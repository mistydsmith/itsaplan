// scripts/landing-slot.integration.test.ts
// sentinel-prod-8429 unit 6 slot witness - the PARENT half. PREPARED for Root's serial D2 slot, never run from this lane.
//
// WHY two real processes: the slot's whole promise is that two landings on one repository exclude each other. A fake driver
// with a global queue proves the protocol and nothing else - Root's own review of unit 5 made that point - so this test
// spawns two Bun children, each with its own dedicated Postgres session, and synchronises them on IPC EVENTS rather than on
// elapsed time. Every deadline is bounded and every child is reaped in a finally.
//
// WHAT IT NEVER DOES: no issue, schema or table write; no sleep-based success; no network or provider. The children issue
// only the two advisory-lock statements the slot itself uses.

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const GRANT_ENV = 'ITSAPLAN_LANDING_D2';
const EXPECTED_DB = 'itsaplan_8364_d2_test';
const CHILD = join(
  import.meta.dir,
  '..',
  'packages',
  'db',
  'src',
  '__tests__',
  'landing-slot.integration.child.ts',
);

/**
 * The guard, before any child is spawned.
 *
 * WHY before: a child that reaches Postgres without these checks would take a real advisory lock on a real repository, and a
 * mistake here would show up as a blocked landing rather than a failed test.
 */
function assertSlotTargetGuard(): void {
  if ((process.env[GRANT_ENV] ?? '').trim() !== '1')
    throw new Error(`slot guard: ${GRANT_ENV}=1 is required (Root's grant for the serial D2 slot)`);
  if (process.env.NODE_ENV !== 'test') throw new Error('slot guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('slot guard: BUN_TEST_WORKER_ID must be unset (single process)');
  const url = process.env.DATABASE_URL ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('slot guard: DATABASE_URL must be a parseable URL');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1')
    throw new Error(`slot guard: host must be loopback, got '${parsed.hostname}'`);
  if (parsed.port !== '5433')
    throw new Error(`slot guard: port must be 5433, got '${parsed.port}'`);
  if (parsed.pathname !== `/${EXPECTED_DB}`)
    throw new Error(`slot guard: path must be /${EXPECTED_DB}, got '${parsed.pathname}'`);
}

const READY = (process.env[GRANT_ENV] ?? '').trim() === '1';
const d2 = READY ? describe : describe.skip;

type Child = {
  pid: number;
  send(text: string): Promise<void>;
  next(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
};

/**
 * One child process, with a line-oriented event stream.
 *
 * WHY the queue: an event can arrive before the parent asks for it, and a reader that only listened when asked would lose
 * the very message it is waiting for.
 */
function spawnChild(scenario: string, identity: string, url: string): Child {
  const proc = Bun.spawn({
    cmd: ['bun', CHILD, `--scenario=${scenario}`, `--identity=${identity}`, `--url=${url}`],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const queue: Record<string, unknown>[] = [];
  // WHY this: a child that dies mid-scenario would otherwise be indistinguishable from one that is merely slow, and the
  // parent would report a deadline instead of the child's own failure.
  const exitState: { code: number | null; stderr: string } = { code: null, stderr: '' };
  const waiters: Array<{ event: string; resolve: (v: Record<string, unknown>) => void }> = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const pump = async (): Promise<void> => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line === '') continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.findIndex((w) => w.event === parsed.event);
        if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(parsed);
        else queue.push(parsed);
      }
    }
  };
  void pump();
  void (async () => {
    const chunks: string[] = [];
    try {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>)
        chunks.push(new TextDecoder().decode(chunk));
    } catch {
      // a closed stderr is not an error of its own
    }
    exitState.stderr = chunks.join('');
  })();
  void proc.exited.then((code: number) => {
    exitState.code = code;
  });

  return {
    pid: proc.pid,
    async send(text: string) {
      proc.stdin.write(`${text}\n`);
      await proc.stdin.flush();
    },
    /**
     * The next event of that name, or a rejection naming the deadline.
     *
     * WHY a deadline rather than a sleep: the parent must fail with the deadline it waited for, not pass because it once
     * happened to see the right thing.
     */
    next(event: string, timeoutMs = 10_000) {
      const queued = queue.findIndex((row) => row.event === event);
      if (queued >= 0) return Promise.resolve(queue.splice(queued, 1)[0]);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        // The exit watch fires only if the event never arrives, and it names what the child actually said.
        const exitWatch = setInterval(() => {
          if (exitState.code === null) return;
          clearInterval(exitWatch);
          const index = waiters.findIndex((w) => w.event === event);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `slot witness: child exited (code ${exitState.code}) before '${event}'; stderr: ${exitState.stderr.trim().slice(-400) || '(empty)'}`,
            ),
          );
        }, 25);
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.event === event);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`slot witness: no '${event}' event within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({
          event,
          resolve: (value) => {
            clearTimeout(timer);
            clearInterval(exitWatch);
            resolve(value);
          },
        });
      });
    },
    async kill() {
      try {
        proc.kill();
      } catch {
        // a child that already exited is not an error
      }
      await proc.exited;
    },
  };
}

/** A synthetic repository identity per run, so two runs in one slot cannot collide. */
function identityFor(tag: string): string {
  return `d2-slot-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

d2('the landing slot across two real processes', () => {
  it('holds, refuses the same identity, then lets it in after an explicit release', async () => {
    assertSlotTargetGuard();
    const url = process.env.DATABASE_URL as string;
    const identity = identityFor('same');
    const first = spawnChild('hold', identity, url);
    const children: Child[] = [first];
    try {
      const held = await first.next('held');
      expect(typeof held.pid).toBe('number');
      expect(held.pid).toBe(first.pid);
      const second = spawnChild('attempt', identity, url);
      children.push(second);
      const ready = await second.next('ready');
      // The same advisory key, computed independently in the second process, and a different process.
      expect(ready.key).toBe(held.key);
      expect(ready.pid).not.toBe(held.pid);
      const outcome = await second.next('outcome');
      expect(outcome.acquired).toBe(false);
      expect(String(outcome.code)).toBe('SLOT_BUSY');
      // The callback must never have been entered in the blocked process.
      expect(outcome.callbacks).toBe(0);
      expect(outcome.callbackError).toBeNull();
      // Explicit release, then a FRESH attempt from a third process.
      await first.send('release');
      await first.next('released');
      await first.next('outcome');
      const third = spawnChild('attempt', identity, url);
      children.push(third);
      const after = await third.next('outcome');
      expect(after.acquired).toBe(true);
      expect(after.released).toBe(true);
      expect(after.callbacks).toBe(1);
    } finally {
      for (const child of children) await child.kill();
    }
  });

  it('lets a DIFFERENT identity proceed while the first is held, and releases after a callback throw', async () => {
    assertSlotTargetGuard();
    const url = process.env.DATABASE_URL as string;
    const held = identityFor('a');
    const other = identityFor('b');
    const first = spawnChild('hold', held, url);
    const children: Child[] = [first];
    try {
      await first.next('held');
      const distinct = spawnChild('attempt', other, url);
      children.push(distinct);
      const distinctOutcome = await distinct.next('outcome');
      expect(distinctOutcome.acquired).toBe(true);
      await first.send('release');
      await first.next('outcome');

      // A throwing callback must still release the lock, so the next process can take it.
      const thrower = spawnChild('throw', held, url);
      children.push(thrower);
      const thrown = await thrower.next('outcome');
      expect(thrown.acquired).toBe(true);
      expect(String(thrown.callbackError)).toContain('throws on purpose');
      expect(thrown.released).toBe(true);
      const next = spawnChild('attempt', held, url);
      children.push(next);
      const after = await next.next('outcome');
      expect(after.acquired).toBe(true);
    } finally {
      for (const child of children) await child.kill();
    }
  });
});
