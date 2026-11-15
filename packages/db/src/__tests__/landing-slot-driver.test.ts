// packages/db/src/__tests__/landing-slot-driver.test.ts — sentinel-prod-8429 atom B unit.
// WHY it needs no database: the driver's job is transport, so the injected factory records exactly what the driver asked for -
// one connection per connect(), a parameterised statement passed through and not rewritten, and a bounded end(). The claim
// that two real processes exclude each other is the accepted two-process witness (aaf6f907 / eec3370f), not this file.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT: any lock key, statement text, unlock or outcome code. Those are the policy's, and a
// test here that pinned them would be the second copy of the policy this atom exists to avoid.

import { describe, expect, it } from 'bun:test';

import {
  createDedicatedSlotDriver,
  type PostgresFactory,
  type PostgresSessionLike,
} from '../landing-slot-driver';

interface FakeCall {
  sql: string;
  params: unknown[];
}

function fakeSession(calls: FakeCall[], endings: Array<{ timeout?: number }>): PostgresSessionLike {
  return {
    async unsafe(sql, params) {
      calls.push({ sql, params: params as unknown[] });
      return [{ held: true }];
    },
    async end(options) {
      endings.push(options ?? {});
    },
  };
}

function fakeFactory(
  opened: Array<{ url: string; options: { max: number } }>,
  calls: FakeCall[],
  endings: Array<{ timeout?: number }>,
): PostgresFactory {
  return (url, options) => {
    opened.push({ url, options });
    return fakeSession(calls, endings);
  };
}

describe('the dedicated slot driver only carries statements', () => {
  it('opens one single-connection session per connect and passes the statement through unmodified', async () => {
    const opened: Array<{ url: string; options: { max: number } }> = [];
    const calls: FakeCall[] = [];
    const endings: Array<{ timeout?: number }> = [];
    const driver = createDedicatedSlotDriver({
      url: ' postgres://user@127.0.0.1:5433/db ',
      postgres: fakeFactory(opened, calls, endings),
    });

    const session = await driver.connect();
    const result = await session.query('SELECT pg_try_advisory_lock($1) AS held', ['42']);

    expect(opened).toHaveLength(1);
    expect(opened[0]?.options).toEqual({ max: 1 });
    // The url is trimmed once, and never rewritten into a statement.
    expect(opened[0]?.url).toBe('postgres://user@127.0.0.1:5433/db');
    expect(calls).toEqual([{ sql: 'SELECT pg_try_advisory_lock($1) AS held', params: ['42'] }]);
    expect(result.rows).toEqual([{ held: true }]);
  });

  it('defaults an omitted parameter list rather than inventing one', async () => {
    const calls: FakeCall[] = [];
    const driver = createDedicatedSlotDriver({
      url: 'postgres://user@127.0.0.1:5433/db',
      postgres: fakeFactory([], calls, []),
    });
    await (await driver.connect()).query('SELECT 1');
    expect(calls).toEqual([{ sql: 'SELECT 1', params: [] }]);
  });

  it('closes the session with a bounded timeout, so a lock cannot outlive the caller by accident', async () => {
    const endings: Array<{ timeout?: number }> = [];
    const driver = createDedicatedSlotDriver({
      url: 'postgres://user@127.0.0.1:5433/db',
      closeTimeoutSeconds: 3,
      postgres: fakeFactory([], [], endings),
    });
    await (await driver.connect()).end();
    expect(endings).toEqual([{ timeout: 3 }]);
  });

  it('gives each connect its own connection, so two sessions never share one lock', async () => {
    const opened: Array<{ url: string; options: { max: number } }> = [];
    const driver = createDedicatedSlotDriver({
      url: 'postgres://user@127.0.0.1:5433/db',
      postgres: fakeFactory(opened, [], []),
    });
    const first = await driver.connect();
    const second = await driver.connect();
    expect(first).not.toBe(second);
    expect(opened).toHaveLength(2);
  });
});

describe('a driver without a usable target is refused at start-up, not mid-landing', () => {
  it('refuses a missing, empty or whitespace url', () => {
    for (const url of ['', '   ', undefined as unknown as string]) {
      expect(() => createDedicatedSlotDriver({ url })).toThrow(/connection url is required/);
    }
  });

  it('refuses a close timeout that is not a positive number', () => {
    for (const closeTimeoutSeconds of [0, -1, Number.NaN]) {
      expect(() =>
        createDedicatedSlotDriver({ url: 'postgres://127.0.0.1:5433/db', closeTimeoutSeconds }),
      ).toThrow(/closeTimeoutSeconds must be a positive number/);
    }
  });
});
