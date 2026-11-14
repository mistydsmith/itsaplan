import { describe, it, expect, beforeAll } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@repo/db';

// Real-TX integration test for the run-cancellation webhook plumbing (8364 U3c3):
// emitRunsCanceled / emitEnded / selectRuns take a trailing executor and forward it into
// emitWebhookEvents' 5th arg, so the read + the webhook_delivery enqueue share the caller's
// transaction. Self-contained scratch fixtures (no resetDb / public reset); only enqueue, no
// worker/provider/HTTP send.
//
// The exact-target / NODE_ENV / no-worker guard runs BEFORE any DB import, and the db handle
// + the emit under test are imported dynamically after it, matching the other 8364 D2 proofs.
//
// WHY the fixture rules below (Root review of 0c420a0c, 2026-11-14):
// - Numeric ids come from the database (INSERT ... RETURNING id) and are recorded only after
//   that insert returned. A guessed id could name a row this test never wrote, and cleanup
//   would then delete someone else's row.
// - Usernames and emails carry a per-case suffix, because "user".email, "user".username and
//   ai_agent (team, lower(username)) are unique; fixed names collide on a rerun after a crash.
// - Every case runs inside withFixtures: setup, body and assertions are all inside its try, so
//   a half-built fixture is still cleaned. Cleanup and restore failures are collected and
//   thrown, never swallowed, and they never hide the test's own failure.
//
// Covers what the existing tests do not:
//   1. an uncommitted run/agent/user/project payload is seen through the supplied tx;
//   2. the actual webhook_delivery row written on the tx is gone after a forced abort;
//   3. a real DB failure on the tx propagates and rolls the webhook_delivery back;
//   4. a webhook_delivery insert failure (owned trigger) on the tx propagates through the
//      forwarded executor, the emit never returns, and no delivery is written;
//   5. the default call (no executor) still uses the pool and commits a delivery.

const EXPECTED_DB = 'itsaplan_8364_d2_test';
function assertTargetGuard(): void {
  const envUrl = process.env.DATABASE_URL ?? '';
  let u: URL;
  try {
    u = new URL(envUrl);
  } catch {
    throw new Error(
      `target guard: DATABASE_URL is not a parseable URL, got ${JSON.stringify(envUrl)}`,
    );
  }
  if (u.hostname !== '127.0.0.1' && u.hostname !== '::1') {
    throw new Error(`target guard: host must be loopback (127.0.0.1 or ::1), got '${u.hostname}'`);
  }
  if (u.port !== '5433') {
    throw new Error(`target guard: port must be 5433, got '${u.port}'`);
  }
  if (u.pathname !== `/${EXPECTED_DB}`) {
    throw new Error(`target guard: path must be /${EXPECTED_DB}, got '${u.pathname}'`);
  }
  if (process.env.NODE_ENV !== 'test') throw new Error('target guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID) {
    throw new Error('target guard: BUN_TEST_WORKER_ID must be unset (single process)');
  }
}
assertTargetGuard();

type DbMod = Awaited<typeof import('@repo/db')>;
type Ex = DbExecutor;
let db: DbMod['db'];
let emitRunsCanceled: (typeof import('../../run-finished'))['emitRunsCanceled'];

beforeAll(async () => {
  ({ db } = await import('@repo/db'));
  ({ emitRunsCanceled } = await import('../../run-finished'));
});

// Ids this case actually wrote. A field is set only after its insert returned.
type Fixture = {
  ws?: number;
  team?: number;
  proj?: number;
  agent?: number;
  run?: number;
  webhook?: number;
  users: string[];
  // Owned schema objects (the trigger case), undone first and in reverse order.
  restores: Array<() => Promise<unknown>>;
};

// Lowercase hex only, so it is also safe inside the trigger and function names.
type Names = { s: string; human: string; bot: string; agentUsername: string; botName: string };
function makeNames(): Names {
  const s = randomUUID().replace(/-/g, '');
  return {
    s,
    human: `rf-h-${s}`,
    bot: `rf-b-${s}`,
    agentUsername: `rf-agent-${s}`,
    botName: `Rf Agent Bot ${s}`,
  };
}

async function insertId(executor: Ex, query: SQL): Promise<number> {
  const rows = (await executor.execute(query)) as unknown as Array<{ id: number | string }>;
  const id = Number(rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('fixture insert returned no id');
  return id;
}

// Committed baseline: the project the run lives in + the actor the cancellation is attributed to.
async function commitBaseline(fx: Fixture, n: Names): Promise<void> {
  fx.ws = await insertId(db, sql`insert into workspace (name) values ('Rf Scratch') returning id`);
  fx.team = await insertId(
    db,
    sql`insert into team (workspace_id, name) values (${fx.ws}, 'Rf Scratch Team') returning id`,
  );
  fx.proj = await insertId(
    db,
    sql`insert into project (team_id, "key", name) values (${fx.team}, 'RF', 'Rf Scratch Project') returning id`,
  );
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, username) values (${n.human}, 'Rf Human', ${`${n.human}@scratch.test`}, true, ${n.human})`,
  );
  fx.users.push(n.human);
}

// The run + its agent + the agent's user + a subscribed webhook. On a tx these are uncommitted
// (the visibility cases); on the pool they commit. Ids written on a tx that later rolled back
// are kept too: sequences never hand a rolled-back id out again, so deleting by it is exact
// and touches nothing, and it still cleans up if the tx committed by mistake.
async function insertRunAgentWebhook(executor: Ex, fx: Fixture, n: Names): Promise<void> {
  await executor.execute(
    sql`insert into "user" (id, name, email, email_verified, username) values (${n.bot}, ${n.botName}, ${`${n.bot}@scratch.test`}, true, ${n.bot})`,
  );
  fx.users.push(n.bot);
  fx.agent = await insertId(
    executor,
    sql`insert into ai_agent (team_id, user_id, username, kind) values (${fx.team}, ${n.bot}, ${n.agentUsername}, 'internal') returning id`,
  );
  fx.run = await insertId(
    executor,
    sql`insert into agent_run (project_id, agent_id, prompt, status) values (${fx.proj}, ${fx.agent}, 'rf scratch run', 'canceled') returning id`,
  );
  fx.webhook = await insertId(
    executor,
    sql`insert into webhook (project_id, url, secret, events, is_active) values (${fx.proj}, 'https://rf.scratch.test/hook', 'rf-secret', '["agent_run.finished"]'::jsonb, true) returning id`,
  );
}

// Exact-key cleanup of only the recorded ids. Every step is attempted; failures are returned.
async function cleanup(fx: Fixture): Promise<unknown[]> {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      errors.push(e);
    }
  };
  for (const restore of [...fx.restores].reverse()) await step(restore);
  const { webhook, run, agent, proj, team, ws } = fx;
  if (webhook !== undefined) {
    await step(() => db.execute(sql`delete from webhook_delivery where webhook_id = ${webhook}`));
    await step(() => db.execute(sql`delete from webhook where id = ${webhook}`));
  }
  if (run !== undefined) await step(() => db.execute(sql`delete from agent_run where id = ${run}`));
  if (agent !== undefined)
    await step(() => db.execute(sql`delete from ai_agent where id = ${agent}`));
  if (proj !== undefined) await step(() => db.execute(sql`delete from project where id = ${proj}`));
  if (team !== undefined) await step(() => db.execute(sql`delete from team where id = ${team}`));
  if (ws !== undefined) await step(() => db.execute(sql`delete from workspace where id = ${ws}`));
  for (const id of fx.users) await step(() => db.execute(sql`delete from "user" where id = ${id}`));
  return errors;
}

async function withFixtures(body: (fx: Fixture, n: Names) => Promise<void>): Promise<void> {
  const fx: Fixture = { users: [], restores: [] };
  let failure: { error: unknown } | null = null;
  try {
    await body(fx, makeNames());
  } catch (error) {
    failure = { error };
  }
  // The catch above takes every body failure, so this line always runs after the body.
  const errors = await cleanup(fx);
  if (failure && errors.length > 0) {
    throw new AggregateError([failure.error, ...errors], 'case failed, and its cleanup failed');
  }
  if (errors.length > 0) throw new AggregateError(errors, 'fixture cleanup failed');
  if (failure) throw failure.error;
}

type Delivery = { payload: Record<string, unknown> };
type RunData = {
  id: number;
  status: string;
  agent: { id: number; username: string; name: string };
  projectId: number;
};
type Actor = { type: string; id: string; name: string | null };

async function deliveryPayloadOn(
  executor: Ex,
  webhookId: number | undefined,
): Promise<Record<string, unknown> | null> {
  const res = await executor.execute(
    sql`select payload from webhook_delivery where webhook_id = ${webhookId} order by id limit 1`,
  );
  const row = (res as unknown as Delivery[])[0];
  return row ? (row.payload as Record<string, unknown>) : null;
}

async function deliveryCount(executor: Ex, webhookId: number | undefined): Promise<number> {
  const res = await executor.execute(
    sql`select count(*)::int as n from webhook_delivery where webhook_id = ${webhookId}`,
  );
  return Number((res as unknown as Array<{ n: number }>)[0].n);
}

// WHY the cause chain: drizzle wraps a driver failure in DrizzleQueryError, whose own message
// is only "Failed query: ... params: ...". The Postgres text and SQLSTATE code are on .cause.
// The walk stops at a repeated link, so a cyclic cause cannot loop.
function hasPgError(error: unknown, code: string, message: RegExp): boolean {
  const seen = new Set<unknown>();
  let link = error;
  while (link instanceof Error && !seen.has(link)) {
    seen.add(link);
    if ((link as { code?: unknown }).code === code && message.test(link.message)) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

// The run id, once the fixture recorded it; a case that reaches the emit without one is broken.
function runOf(fx: Fixture): number {
  if (fx.run === undefined) throw new Error('fixture run was not created');
  return fx.run;
}

describe('transaction run-finished (run-cancellation webhook plumbing)', () => {
  it('sees the uncommitted run/agent/user/project payload through the supplied tx', () =>
    withFixtures(async (fx, n) => {
      await commitBaseline(fx, n);
      let sawPayload = false;
      let abort = '';
      try {
        await db.transaction(async (tx) => {
          await insertRunAgentWebhook(tx, fx, n); // uncommitted on the tx
          await emitRunsCanceled([runOf(fx)], n.human, tx);
          const payload = await deliveryPayloadOn(tx, fx.webhook);
          const data = payload?.data as RunData | undefined;
          const actor = payload?.actor as Actor | undefined;
          sawPayload =
            payload?.event === 'agent_run.finished' &&
            data?.id === fx.run &&
            data?.status === 'canceled' &&
            data?.agent?.username === n.agentUsername &&
            data?.agent?.name === n.botName &&
            data?.projectId === fx.proj &&
            actor?.id === n.human &&
            actor?.type === 'human';
          throw new Error('rf-abort');
        });
      } catch (e) {
        abort = (e as Error).message;
      }
      expect(abort).toBe('rf-abort');
      expect(sawPayload).toBe(true);
      // Rolled back: the pool must not see the delivery.
      expect(await deliveryCount(db, fx.webhook)).toBe(0);
    }));

  it('rolls the actual webhook_delivery back when the tx is forced to abort', () =>
    withFixtures(async (fx, n) => {
      await commitBaseline(fx, n);
      let deliveryOnTx = 0;
      let abort = '';
      try {
        await db.transaction(async (tx) => {
          await insertRunAgentWebhook(tx, fx, n);
          await emitRunsCanceled([runOf(fx)], n.human, tx);
          deliveryOnTx = await deliveryCount(tx, fx.webhook);
          throw new Error('rf-abort');
        });
      } catch (e) {
        abort = (e as Error).message;
      }
      expect(abort).toBe('rf-abort');
      expect(deliveryOnTx).toBe(1); // the real delivery row was written on the tx
      expect(await deliveryCount(db, fx.webhook)).toBe(0); // gone after the abort
    }));

  it('propagates a real DB failure on the tx and rolls the delivery back', () =>
    withFixtures(async (fx, n) => {
      await commitBaseline(fx, n);
      let caught: unknown = null;
      let advanced = false;
      try {
        await db.transaction(async (tx) => {
          await insertRunAgentWebhook(tx, fx, n);
          await emitRunsCanceled([runOf(fx)], n.human, tx);
          // A real, non-sentinel DB failure on the same tx (integer division by zero).
          await tx.execute(sql`select 1/0`);
          advanced = true; // reached only if the failing statement returned
        });
      } catch (e) {
        caught = e;
      }
      expect(advanced).toBe(false);
      // 22012 is division_by_zero; any other error (a typo in the SQL, an import) fails here.
      expect(hasPgError(caught, '22012', /division by zero/i)).toBe(true);
      expect(await deliveryCount(db, fx.webhook)).toBe(0);
    }));

  it('propagates a webhook_delivery insert failure through the forwarded executor', () =>
    withFixtures(async (fx, n) => {
      await commitBaseline(fx, n);
      await insertRunAgentWebhook(db, fx, n); // committed fixtures
      // Owned immediate insert failure, scoped to this case's webhook only. Plain CREATE (not
      // OR REPLACE) so a name clash fails loudly instead of rewriting someone else's function;
      // each object is registered for restore only after its CREATE returned.
      const fn = `rf_block_delivery_${n.s}`;
      const trg = `rf_block_delivery_trg_${n.s}`;
      const webhookId = fx.webhook;
      if (webhookId === undefined || !Number.isSafeInteger(webhookId)) {
        throw new Error('fixture webhook was not created');
      }
      await db.execute(
        sql.raw(
          `create function ${fn}() returns trigger as $$ begin if new.webhook_id = ${webhookId} then raise exception 'MARKER_RF_WEBHOOK_INSERT_BLOCKED'; end if; return new; end; $$ language plpgsql`,
        ),
      );
      fx.restores.push(() => db.execute(sql.raw(`drop function ${fn}()`)));
      await db.execute(
        sql.raw(
          `create trigger ${trg} before insert on webhook_delivery for each row execute function ${fn}()`,
        ),
      );
      fx.restores.push(() => db.execute(sql.raw(`drop trigger ${trg} on webhook_delivery`)));
      let caught: unknown = null;
      let advanced = false;
      try {
        await db.transaction(async (tx) => {
          await emitRunsCanceled([runOf(fx)], n.human, tx);
          advanced = true; // reached only if the emit returned
        });
      } catch (e) {
        caught = e;
      }
      expect(advanced).toBe(false); // the emit's insert ran on the tx and its failure propagated
      // P0001 is plpgsql RAISE EXCEPTION, and the marker names this case's own trigger.
      expect(hasPgError(caught, 'P0001', /MARKER_RF_WEBHOOK_INSERT_BLOCKED/)).toBe(true);
      expect(await deliveryCount(db, fx.webhook)).toBe(0); // nothing was written
    }));

  it('keeps the default call (no executor) on the pool and commits a delivery', () =>
    withFixtures(async (fx, n) => {
      await commitBaseline(fx, n);
      await insertRunAgentWebhook(db, fx, n); // committed fixtures
      await emitRunsCanceled([runOf(fx)], n.human); // no executor -> pool
      const payload = await deliveryPayloadOn(db, fx.webhook);
      const data = payload?.data as RunData | undefined;
      const actor = payload?.actor as Actor | undefined;
      expect(payload?.event).toBe('agent_run.finished');
      expect(data?.id).toBe(runOf(fx));
      expect(data?.status).toBe('canceled');
      expect(data?.agent?.username).toBe(n.agentUsername);
      expect(data?.agent?.name).toBe(n.botName);
      expect(data?.projectId).toBe(fx.proj);
      expect(actor?.id).toBe(n.human);
      expect(actor?.type).toBe('human');
      expect(await deliveryCount(db, fx.webhook)).toBe(1); // committed (not rolled back)
    }));
});
