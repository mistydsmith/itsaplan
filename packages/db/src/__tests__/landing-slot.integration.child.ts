// packages/db/src/__tests__/landing-slot.integration.child.ts
// sentinel-prod-8429 unit 6 slot witness - the CHILD half. PREPARED, spawned only by its parent under Root's D2 grant.
//
// WHY it lives in packages/db: this is the only package that DECLARES a postgres client (postgres ^3.4.9), and its tsconfig
// includes src. A leaf under scripts/ cannot resolve a driver at all, and importing one by absolute path would bind the test
// to another workspace's install layout.
//
// WHAT IT DOES: opens its OWN dedicated session, runs exactly one of the slot scenarios against the real withLandingSlot and
// the real advisory locks, and reports progress as one JSON object per line on stdout so the parent can synchronise on
// events rather than on time. It writes no row: the only statements it issues are pg_try_advisory_lock and
// pg_advisory_unlock, plus connect and end.

import postgres from 'postgres';

import {
  slotKey,
  withLandingSlot,
  type SlotDriver,
  type SlotSession,
} from '../../../../scripts/landing-slot';

interface ChildArgs {
  scenario: 'hold' | 'attempt' | 'throw';
  identity: string;
  url: string;
}

function parseArgs(argv: string[]): ChildArgs {
  const get = (name: string): string => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (hit === undefined) throw new Error(`child: missing --${name}`);
    return hit.slice(name.length + 3);
  };
  const scenario = get('scenario');
  if (scenario !== 'hold' && scenario !== 'attempt' && scenario !== 'throw')
    throw new Error(`child: unknown scenario ${scenario}`);
  return { scenario, identity: get('identity'), url: get('url') };
}

/** The same guard the parent runs, before any connection is opened. */
function assertSlotTargetGuard(url: string): void {
  if ((process.env.ITSAPLAN_LANDING_D2 ?? '').trim() !== '1')
    throw new Error('slot child guard: ITSAPLAN_LANDING_D2=1 is required (Root grant)');
  if (process.env.NODE_ENV !== 'test') throw new Error('slot child guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('slot child guard: BUN_TEST_WORKER_ID must be unset (single process)');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('slot child guard: DATABASE_URL must be a parseable URL');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1')
    throw new Error(`slot child guard: host must be loopback, got '${parsed.hostname}'`);
  if (parsed.port !== '5433')
    throw new Error(`slot child guard: port must be 5433, got '${parsed.port}'`);
  if (parsed.pathname !== '/itsaplan_8364_d2_test')
    throw new Error(
      `slot child guard: path must be /itsaplan_8364_d2_test, got '${parsed.pathname}'`,
    );
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** One dedicated session over the declared postgres client, shaped as the SlotSession the slot expects. */
function driverFor(url: string, opened: { count: number }): SlotDriver {
  return {
    async connect(): Promise<SlotSession> {
      const sql = postgres(url, { max: 1, onnotice: () => undefined });
      opened.count += 1;
      return {
        async query(text: string, params?: readonly unknown[]) {
          // WHY $1 is passed through: the slot parameterises the advisory key, so the child must not inline it.
          // WHY the cast: postgres types unsafe() parameters as its own JSON-or-primitive union while the slot passes
          // through exactly the values it was given, so the array crosses that boundary untyped rather than reshaped.
          const rows = (await sql.unsafe(text, (params ?? []) as never[])) as unknown as unknown[];
          return { rows };
        },
        async end() {
          await sql.end({ timeout: 5 });
        },
      };
    },
  };
}

/** Wait for one line on stdin, with no timer of its own - the parent owns every deadline. */
function nextLine(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      process.stdin.off('data', onData);
      resolve(chunk.toString().trim());
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // WHY before the driver exists: a child invoked directly must refuse on its own, not rely on the parent having checked.
  assertSlotTargetGuard(args.url);
  const opened = { count: 0, callbacks: 0 };
  const key = slotKey(args.identity).toString();
  emit({ event: 'ready', pid: process.pid, key });

  const outcome = await withLandingSlot(driverFor(args.url, opened), args.identity, async () => {
    opened.callbacks += 1;
    emit({ event: 'callback' });
    if (args.scenario === 'throw') throw new Error('child callback throws on purpose');
    if (args.scenario === 'hold') {
      emit({ event: 'held', pid: process.pid, key });
      // WHY it waits for a line: a hold that ended on a timer would make the parent's assertions time-based.
      const line = await nextLine();
      emit({ event: 'released', line });
    }
    return 'done';
  });

  emit({
    event: 'outcome',
    acquired: outcome.acquired,
    released: outcome.released,
    code: outcome.code ?? null,
    callbackError: outcome.error instanceof Error ? outcome.error.message : null,
    cleanup: outcome.cleanup ?? null,
    connects: opened.count,
    callbacks: opened.callbacks,
    pid: process.pid,
  });
  process.exit(0);
}

main().catch((error: unknown) => {
  emit({ event: 'child_error', message: String(error) });
  process.exit(1);
});
