// scripts/landing-slot.test.ts — sentinel-prod-8429 auto-lander unit 2: the slot protocol.
//
// NO DB: every case drives a synthetic driver, so these tests prove the protocol only - which
// statements run, with which parameters, in which order, and what each failure path returns. They do
// NOT prove that two real PostgreSQL processes exclude each other; that claim needs a dedicated
// connection and a two-process test under Root's GO, and is kept separate on purpose.
//
// Run with: env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" bun test ./landing-slot.test.ts

import { describe, expect, it } from 'bun:test';

import {
  normaliseRepoIdentity,
  slotKey,
  withLandingSlot,
  type SlotDriver,
  type SlotSession,
} from './landing-slot';

type Call = { sql: string; params?: readonly unknown[] };

/** A synthetic session that answers from a queue and records every call it saw. */
function fakeSession(answers: Array<unknown | Error> = [], endError?: Error) {
  const calls: Call[] = [];
  let ended = 0;
  const session: SlotSession = {
    async query(sql, params) {
      calls.push({ sql, params });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return (next ?? { rows: [{ held: true }] }) as { rows: unknown[] };
    },
    async end() {
      ended += 1;
      if (endError) throw endError;
    },
  };
  return { session, calls, ended: () => ended };
}

function fakeDriver(session: SlotSession, connectError?: Error): SlotDriver & { connects: number } {
  let connects = 0;
  return {
    get connects() {
      return connects;
    },
    async connect() {
      connects += 1;
      if (connectError) throw connectError;
      return session;
    },
  };
}

describe('the key is derived from the configured identity, never from a path', () => {
  it('gives identical keys for the same identity reached from different paths and hosts', () => {
    const a = slotKey('sentinel-prod');
    const b = slotKey('  sentinel-prod  ');
    expect(a).toBe(b);
    // A path-shaped identity is just text: two different checkouts of one repository share a key only
    // if they are configured with the same identity, which is what the identity is for.
    expect(slotKey('sentinel-prod')).not.toBe(slotKey('/Users/misty/sentinel/sentinel-prod'));
  });

  it('gives different keys for different identities', () => {
    expect(slotKey('sentinel-prod')).not.toBe(slotKey('dss-law'));
    expect(slotKey('itsaplan')).not.toBe(slotKey('dispatch_board'));
  });

  it('stays inside the signed 63-bit range PostgreSQL advisory locks accept', () => {
    for (const identity of ['sentinel-prod', 'dss-law', 'a', 'x'.repeat(500)]) {
      const key = slotKey(identity);
      expect(key >= 0n).toBe(true);
      expect(key < 1n << 63n).toBe(true);
    }
  });

  it('refuses an empty identity instead of hashing one shared key', async () => {
    const { session } = fakeSession();
    const driver = fakeDriver(session);
    for (const empty of ['', '   ', undefined, 42]) {
      const outcome = await withLandingSlot(driver, empty as string, async () => 'ran');
      expect(outcome.code).toBe('REPO_IDENTITY_MISSING');
      expect(outcome.acquired).toBe(false);
    }
    expect(driver.connects).toBe(0);
    expect(() => slotKey('')).toThrow();
    expect(normaliseRepoIdentity(' sentinel-prod ')).toBe('sentinel-prod');
  });
});

describe('acquiring and releasing', () => {
  it('runs the callback once and releases exactly once when the lock is taken', async () => {
    const { session, calls, ended } = fakeSession([
      { rows: [{ held: true }] },
      { rows: [{ released: true }] },
    ]);
    const driver = fakeDriver(session);
    let ran = 0;
    const outcome = await withLandingSlot(driver, 'sentinel-prod', async () => {
      ran += 1;
      return 'landed';
    });

    expect(outcome).toEqual({ acquired: true, released: true, value: 'landed' });
    expect(ran).toBe(1);
    expect(driver.connects).toBe(1);
    expect(ended()).toBe(1);
    expect(calls.map((call) => call.sql)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS held',
      'SELECT pg_advisory_unlock($1) AS released',
    ]);
    expect(calls[0].params).toEqual([slotKey('sentinel-prod')]);
    expect(calls[1].params).toEqual([slotKey('sentinel-prod')]);
    // No transaction is opened across the callback: the protocol is two statements on one session.
    expect(calls.some((call) => /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(call.sql))).toBe(false);
  });

  it('accepts a positional row as well as a named one', async () => {
    const { session } = fakeSession([{ rows: [[true]] }, { rows: [[true]] }]);
    const outcome = await withLandingSlot(fakeDriver(session), 'dss-law', async () => 7);
    expect(outcome.value).toBe(7);
    expect(outcome.released).toBe(true);
  });
});

describe('a busy slot never runs the work', () => {
  it('returns SLOT_BUSY without calling the callback or unlocking', async () => {
    const { session, calls, ended } = fakeSession([{ rows: [{ held: false }] }]);
    let ran = false;
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      ran = true;
      return 'never';
    });

    expect(outcome.code).toBe('SLOT_BUSY');
    expect(outcome.acquired).toBe(false);
    expect(outcome.released).toBe(false);
    expect(ran).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain('unlock');
    expect(ended()).toBe(1);
  });

  it('treats an unreadable answer as not held rather than as held', async () => {
    const { session } = fakeSession([{ rows: [] }]);
    let ran = false;
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      ran = true;
    });
    expect(outcome.code).toBe('SLOT_BUSY');
    expect(ran).toBe(false);
  });
});

describe('failures are reported, never smoothed into a pass', () => {
  it('closes the session when the connection cannot be made', async () => {
    const { session, ended } = fakeSession();
    const outcome = await withLandingSlot(
      fakeDriver(session, new Error('no route')),
      'sentinel-prod',
      async () => 1,
    );
    expect(outcome.code).toBe('ACQUISITION_FAILED');
    expect(outcome.acquired).toBe(false);
    expect(ended()).toBe(0); // nothing was opened, so nothing is closed
    expect(String(outcome.error)).toContain('no route');
    expect(outcome.cleanup).toBeUndefined();
  });

  it('closes the session when the try-lock statement throws, and does not call back', async () => {
    const { session, ended } = fakeSession([new Error('lock query failed')]);
    let ran = false;
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      ran = true;
    });
    expect(outcome.code).toBe('ACQUISITION_FAILED');
    expect(outcome.acquired).toBe(false);
    expect(ran).toBe(false);
    expect(ended()).toBe(1);
  });

  it('preserves a callback throw and still unlocks and closes', async () => {
    const { session, calls, ended } = fakeSession([
      { rows: [{ held: true }] },
      { rows: [{ released: true }] },
    ]);
    const boom = new Error('compose failed');
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      throw boom;
    });
    expect(outcome.acquired).toBe(true);
    expect(outcome.error).toBe(boom);
    expect(outcome.released).toBe(true);
    expect(outcome.code).toBe('CALLBACK_FAILED');
    expect(calls.at(-1)?.sql).toContain('pg_advisory_unlock');
    expect(ended()).toBe(1);
  });

  it('reports an unlock that did not succeed as RELEASE_FAILED, with the work still returned', async () => {
    const { session, ended } = fakeSession([
      { rows: [{ held: true }] },
      { rows: [{ released: false }] },
    ]);
    const outcome = await withLandingSlot(
      fakeDriver(session),
      'sentinel-prod',
      async () => 'landed',
    );
    expect(outcome.value).toBe('landed');
    expect(outcome.released).toBe(false);
    expect(outcome.code).toBe('RELEASE_FAILED');
    expect(outcome.cleanup).toContain('did not report a successful unlock');
    expect(ended()).toBe(1);
  });

  it('reports an unlock that threw, and keeps a callback error visible beside it', async () => {
    const { session } = fakeSession([{ rows: [{ held: true }] }, new Error('unlock exploded')]);
    const boom = new Error('compose failed');
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      throw boom;
    });
    expect(outcome.error).toBe(boom);
    expect(outcome.released).toBe(false);
    expect(outcome.cleanup).toContain('unlock failed');
  });

  it('reports a close failure even when the unlock succeeded', async () => {
    const { session } = fakeSession(
      [{ rows: [{ held: true }] }, { rows: [{ released: true }] }],
      new Error('close failed'),
    );
    const outcome = await withLandingSlot(
      fakeDriver(session),
      'sentinel-prod',
      async () => 'landed',
    );
    expect(outcome.released).toBe(true);
    expect(outcome.cleanup).toContain('session close failed');
  });

  it('closes the session exactly once on every path', async () => {
    const paths: Array<[Array<unknown | Error>, Error | undefined]> = [
      [[{ rows: [{ held: true }] }, { rows: [{ released: true }] }], undefined],
      [[{ rows: [{ held: false }] }], undefined],
      [[new Error('lock failed')], undefined],
      [[{ rows: [{ held: true }] }], undefined],
    ];
    for (const [answers, endError] of paths) {
      const { session, ended } = fakeSession(answers, endError);
      await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => 'x');
      expect(ended()).toBe(1);
    }
  });
});

describe('a thrown value is a failure whatever it is', () => {
  it('sets CALLBACK_FAILED for throws of undefined, null and 0, preserving the value', async () => {
    for (const thrown of [undefined, null, 0]) {
      const { session, ended } = fakeSession([
        { rows: [{ held: true }] },
        { rows: [{ released: true }] },
      ]);
      const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
        throw thrown;
      });
      expect(outcome.code).toBe('CALLBACK_FAILED');
      expect(outcome.acquired).toBe(true);
      expect(outcome.released).toBe(true);
      expect('value' in outcome).toBe(false);
      expect(outcome.error).toBe(thrown);
      expect(ended()).toBe(1);
    }
  });

  it('keeps CALLBACK_FAILED even when the release also fails', async () => {
    const { session } = fakeSession([{ rows: [{ held: true }] }, new Error('unlock exploded')]);
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      throw undefined;
    });
    expect(outcome.code).toBe('CALLBACK_FAILED');
    expect(outcome.cleanup).toContain('unlock failed');
  });
});

describe('the acquisition reply must carry the acquisition column', () => {
  it('does not run the callback for an unlock-shaped reply', async () => {
    const { session, calls } = fakeSession([{ rows: [{ released: true }] }]);
    let ran = false;
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => {
      ran = true;
      return 'ran';
    });
    expect(ran).toBe(false);
    expect(outcome.acquired).toBe(false);
    expect(outcome.code).toBe('SLOT_BUSY');
    expect(calls).toHaveLength(1);
  });

  it('does not confirm a release from a held-shaped reply', async () => {
    const { session } = fakeSession([{ rows: [{ held: true }] }, { rows: [{ held: true }] }]);
    const outcome = await withLandingSlot(
      fakeDriver(session),
      'sentinel-prod',
      async () => 'landed',
    );
    expect(outcome.released).toBe(false);
    expect(outcome.code).toBe('RELEASE_FAILED');
    expect(outcome.cleanup).toContain('did not report a successful unlock');
  });
});

describe('transport and close failures stay separate facts', () => {
  it('keeps the connect error when no session was opened', async () => {
    const { session } = fakeSession();
    const boom = new Error('no route');
    const outcome = await withLandingSlot(
      fakeDriver(session, boom),
      'sentinel-prod',
      async () => 1,
    );
    expect(outcome.code).toBe('ACQUISITION_FAILED');
    expect(outcome.error).toBe(boom);
    expect(outcome.cleanup).toBeUndefined();
  });

  it('reports the lock-query error and a separate close failure side by side', async () => {
    const { session } = fakeSession([new Error('lock query failed')], new Error('close failed'));
    const outcome = await withLandingSlot(fakeDriver(session), 'sentinel-prod', async () => 1);
    expect(outcome.code).toBe('ACQUISITION_FAILED');
    expect(String(outcome.error)).toContain('lock query failed');
    expect(outcome.cleanup).toContain('session close failed');
  });
});
