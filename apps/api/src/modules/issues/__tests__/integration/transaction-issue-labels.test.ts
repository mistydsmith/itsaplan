import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
// The label connector: the before-state SELECT, the link DELETE and INSERT, the updatedAt UPDATE, the label name
// snapshot, the activity rows and the row the webhook payload is built from. Split across the default client and
// the caller's transaction those reads cannot see the writes -- a label the transaction just created is refused
// as "not in this project", the payload misses it, and a failure in the middle leaves links, activity and a
// queued delivery committed while the caller's work rolls back. Every fixture row is written through the executor
// under test and removed by exact id; every cleanup failure is collected and asserted empty.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MARK = 'q3lbl';
const PAST = '2026-01-01T00:00:00.000Z';
function targetUrl(raw: string | undefined, env: string | undefined): string {
  if (env !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (/sentinel|trial/i.test(name)) throw new Error('refusing a trial or Sentinel database');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}
// A worker clone would mean the suite ran under an environment nobody here chose.
function targetIsSingleProcess(workerId: string | undefined): void {
  if (workerId) throw new Error('target guard: BUN_TEST_WORKER_ID must be unset (single process)');
}
void targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
targetIsSingleProcess(process.env.BUN_TEST_WORKER_ID);

const { db } = await import('@repo/db');
const { setIssueLabels } = await import('../../service');
type Executor = { execute: typeof db.execute };
type LabelExecutor = Parameters<typeof setIssueLabels>[5];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Counts = Record<string, number>;
type Label = { id: number; name: string };
type Change = { added: Label[]; removed: Label[] };
type Act = { id: number; action: string; from: string | null; to: string | null; toId: number };
type Queued = { webhookId: number; event: string; action: string; type: string; change: string };
type Base = {
  workspaceId: number;
  teamId: number;
  projectId: number;
  foreignId: number;
  columnId: number;
};
const rollback = Symbol('rollback');
const madeWs: number[] = [];
const madeTeam: number[] = [];
const madeProject: number[] = [];
const madeUser: string[] = [];
const madeIssue: number[] = [];
const madeTrap: string[] = [];
const cleanupErrors: string[] = [];
async function rows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)) as unknown as T[];
}
async function row<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  return (await rows<T>(executor, query))[0];
}
async function run(executor: Executor, query: ReturnType<typeof sql>): Promise<void> {
  await executor.execute(query);
}
// A cleanup statement that throws must not hide the other cleanup statements or their ids.
async function attempt(query: ReturnType<typeof sql>): Promise<void> {
  await db.execute(query).catch((error) => cleanupErrors.push(String(error)));
}
// DDL goes in as one raw statement: no bind sits inside a CREATE FUNCTION or CREATE TRIGGER.
const parsed = (text: string): Change => JSON.parse(text) as Change;
function raw(text: string): ReturnType<typeof sql> {
  return sql`${sql.raw(text)}`;
}
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${MARK}-${tag}-${Date.now().toString(36)}`;
  const key = (letter: string) => `${letter}${suffix.slice(-6)}`.toUpperCase();
  const chain = sql`WITH ws AS (INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id),
    tm AS (INSERT INTO team (workspace_id, name, slug) SELECT id, ${`team ${suffix}`}, ${`lb-${suffix}`} FROM ws RETURNING id),
    pr AS (INSERT INTO project (team_id, key, name) SELECT id, ${key('L')}, ${`project ${suffix}`} FROM tm RETURNING id),
    fr AS (INSERT INTO project (team_id, key, name) SELECT (SELECT id FROM tm), ${key('F')}, ${`foreign ${suffix}`} RETURNING id),
    cl AS (INSERT INTO project_column (project_id, name, position) SELECT id, 'Todo', 1 FROM pr RETURNING id)
    SELECT ws.id AS "workspaceId", tm.id AS "teamId", pr.id AS "projectId", fr.id AS "foreignId", cl.id AS "columnId"
    FROM ws, tm, pr, fr, cl`;
  const base = await row<Base>(executor, chain);
  madeWs.push(base.workspaceId);
  madeTeam.push(base.teamId);
  madeProject.push(base.projectId, base.foreignId);
  const actorId = `${MARK}-${suffix}`;
  const person = sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${actorId}, 'Label Actor', ${actorId.replace(/[^a-z0-9]/gi, '').toLowerCase()}, ${`${actorId}@example.com`}, true) RETURNING id`;
  madeUser.push((await row<{ id: string }>(executor, person)).id);
  const owned = sql`INSERT INTO label (project_id, name, color) VALUES (${base.projectId}, 'alpha', '#123456'), (${base.projectId}, 'beta', '#123456'), (${base.projectId}, 'gamma', '#123456') RETURNING id, name`;
  const labels: Record<string, Label> = {};
  for (const label of await rows<Label>(executor, owned)) labels[label.name] = label;
  const other = sql`INSERT INTO label (project_id, name, color) VALUES (${base.foreignId}, 'foreign', '#654321') RETURNING id, name`;
  const foreignLabel = await row<Label>(executor, other);
  const hooks = sql`INSERT INTO webhook (project_id, url, secret, events) VALUES (${base.projectId}, 'http://127.0.0.1:5591/one', 'q3lbl-secret', ${'["issue.label_changed"]'}::jsonb), (${base.projectId}, 'http://127.0.0.1:5592/two', 'q3lbl-secret', ${'["issue.label_changed"]'}::jsonb), (${base.projectId}, 'http://127.0.0.1:5593/three', 'q3lbl-secret', ${'["issue.created"]'}::jsonb) RETURNING id, events`;
  const webhooks = { subscribed: [] as number[], unsubscribed: 0 };
  for (const hook of await rows<{ id: number; events: string[] }>(executor, hooks)) {
    if (hook.events.includes('issue.label_changed')) webhooks.subscribed.push(hook.id);
    else webhooks.unsubscribed = hook.id;
  }
  // updated_at is pinned in the past: left to the default the fixture and the change share one now().
  const issue = sql`INSERT INTO issue (project_id, sequence_number, column_id, title, updated_at) VALUES (${base.projectId}, 1, ${base.columnId}, ${`issue ${suffix}`}, ${PAST}) RETURNING id, updated_at`;
  const created = await row<{ id: number; updated_at: string }>(executor, issue);
  madeIssue.push(created.id);
  return {
    projectId: base.projectId,
    issueId: created.id,
    actorId,
    labels,
    foreignLabel,
    webhooks,
    updatedAt: created.updated_at,
  };
}
type Facts = Awaited<ReturnType<typeof fixtures>>;
const pastEpoch = (facts: Facts) => Number(new Date(facts.updatedAt).getTime() / 1000);
const mine = `name LIKE 'project ${MARK}%' OR name LIKE 'foreign ${MARK}%'`;
// Every table this suite can touch, counted by the name only this suite writes.
async function counts(): Promise<Counts> {
  const q = sql`WITH pr AS (SELECT id FROM project WHERE ${sql.raw(mine)}),
    wb AS (SELECT id FROM webhook WHERE project_id IN (SELECT id FROM pr))
    SELECT (SELECT count(*) FROM workspace WHERE name LIKE ${`ws ${MARK}%`})::int AS workspace, (SELECT count(*) FROM team WHERE name LIKE ${`team ${MARK}%`})::int AS team, (SELECT count(*) FROM project WHERE ${sql.raw(mine)})::int AS project,
      (SELECT count(*) FROM project_column WHERE project_id IN (SELECT id FROM pr))::int AS column, (SELECT count(*) FROM label WHERE project_id IN (SELECT id FROM pr))::int AS label,
      (SELECT count(*) FROM webhook WHERE project_id IN (SELECT id FROM pr))::int AS webhook, (SELECT count(*) FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM wb))::int AS delivery,
      (SELECT count(*) FROM issue WHERE title LIKE ${`issue ${MARK}%`})::int AS issue, (SELECT count(*) FROM "user" WHERE id LIKE ${`${MARK}%`})::int AS "user", (SELECT count(*) FROM rig WHERE prefix LIKE ${`${MARK}%`})::int AS rig`;
  return row<Counts>(db, q);
}
const baseline = await counts();
async function links(executor: Executor, issueId: number): Promise<number[]> {
  const q = sql`SELECT label_id FROM issue_label WHERE issue_id = ${issueId} ORDER BY label_id`;
  return (await rows<{ label_id: number }>(executor, q)).map((r) => r.label_id);
}
async function activity(executor: Executor, issueId: number) {
  const q = sql`SELECT id, action, payload -> 'to' ->> 'value' AS "to", (payload -> 'to' ->> 'id')::int AS "toId", payload -> 'from' ->> 'value' AS "from" FROM issue_activity WHERE issue_id = ${issueId} ORDER BY id`;
  return rows<Act>(executor, q);
}
async function deliveries(executor: Executor, projectId: number) {
  const q = sql`SELECT d.webhook_id AS "webhookId", d.event_type AS event, d.payload ->> 'action' AS action, d.payload ->> 'type' AS type, (d.payload -> 'data' -> 'labelChange')::text AS change FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id WHERE w.project_id = ${projectId} ORDER BY d.id`;
  return rows<Queued>(executor, q);
}
// An issue the transaction rolled back reports 0 and null instead of making the reader dereference it.
async function state(executor: Executor, f: Facts) {
  const q = sql`SELECT count(*)::int AS exists, (EXTRACT(EPOCH FROM max(updated_at)))::text AS at FROM issue WHERE id = ${f.issueId}`;
  const found = await row<{ exists: number; at: string | null }>(executor, q);
  const at = found.at === null ? null : Number(found.at);
  const linksOn = await links(executor, f.issueId);
  const acts = (await activity(executor, f.issueId)).length;
  const queued = (await deliveries(executor, f.projectId)).length;
  return { exists: found.exists, at, links: linksOn, acts, queued };
}
async function cleanUp() {
  for (const issueId of madeIssue) {
    await attempt(sql`DELETE FROM issue_label WHERE issue_id = ${issueId}`);
    await attempt(sql`DELETE FROM issue_activity WHERE issue_id = ${issueId}`);
    await attempt(sql`DELETE FROM issue WHERE id = ${issueId}`);
  }
  for (const projectId of madeProject) {
    const drops = sql`DELETE FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})`;
    await attempt(drops);
    await attempt(sql`DELETE FROM webhook WHERE project_id = ${projectId}`);
    await attempt(sql`DELETE FROM label WHERE project_id = ${projectId}`);
    await attempt(sql`DELETE FROM project_column WHERE project_id = ${projectId}`);
    await attempt(sql`DELETE FROM project WHERE id = ${projectId}`);
  }
  for (const id of madeUser) await attempt(sql`DELETE FROM "user" WHERE id = ${id}`);
  for (const id of madeTeam) await attempt(sql`DELETE FROM team WHERE id = ${id}`);
  for (const id of madeWs) await attempt(sql`DELETE FROM workspace WHERE id = ${id}`);
  // Only names this suite created, and only if a forced rollback somehow left one behind.
  for (const name of madeTrap) {
    const q = sql`SELECT (SELECT count(*) FROM pg_proc WHERE proname = ${name})::int AS f, (SELECT count(*) FROM pg_trigger WHERE tgname = ${name})::int AS t`;
    const live = await row<{ f: number; t: number }>(db, q);
    if (live.t > 0) await attempt(raw(`DROP TRIGGER IF EXISTS ${name} ON public.issue_activity`));
    if (live.f > 0) await attempt(raw(`DROP FUNCTION IF EXISTS public.${name}()`));
  }
}
// Runs the body on a real transaction, keeps what it observed, then aborts: the ids survive, the rows do not.
async function inside<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let seen: T | undefined;
  const abort = async (tx: Tx) => {
    seen = await body(tx);
    throw rollback;
  };
  try {
    await db.transaction(abort);
    throw new Error('the transaction was not rolled back');
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return seen as T;
}
const errorChain = (error: unknown): string => {
  const out: string[] = [];
  type Link = { status?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  for (let link = error as Link; link; link = link.cause as Link) {
    out.push([link.status, link.code, link.message ?? link].map(String).join(' '));
  }
  return out.join(' | ');
};
// A trap unique to one run: a BEFORE INSERT trigger on issue_activity that fires only for an actor this suite
// created, so the failing write is this suite's own row, after every label write. Nothing here replaces or drops
// an object it did not create.
const trapNames = (tag: string) => {
  const name = `${MARK}_${tag}_${Date.now().toString(36)}`;
  madeTrap.push(name);
  const make = `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $tr$ BEGIN RAISE EXCEPTION 'q3lbl label trap'; END; $tr$`;
  const fire = `CREATE TRIGGER ${name} BEFORE INSERT ON public.issue_activity FOR EACH ROW WHEN (NEW.actor_user_id LIKE 'q3lbl%') EXECUTE FUNCTION public.${name}()`;
  const gone = sql`SELECT (SELECT count(*) FROM pg_proc WHERE proname = ${name})::int AS f, (SELECT count(*) FROM pg_trigger WHERE tgname = ${name})::int AS t`;
  return { fn: raw(make), trigger: raw(fire), gone };
};
describe('the issue label connector on a supplied transaction', () => {
  // Cleanup runs after every case, so a case that throws mid-way still has its ids released.
  afterEach(async () => {
    await cleanUp();
  });
  it('writes links, updatedAt, activity and queued deliveries the pool cannot see', async () => {
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'scope');
      const ids = [f.labels.beta.id, f.labels.gamma.id, f.labels.beta.id];
      await setIssueLabels(f.projectId, f.issueId, ids, f.actorId, true, ex);
      return { f, on: await state(tx, f) };
    });
    expect(on.links).toEqual([f.labels.beta.id, f.labels.gamma.id]); // beta twice is one link
    expect(on.exists).toBe(1);
    expect(on.at).toBeGreaterThan(pastEpoch(f));
    expect(on.queued).toBe(2); // one delivery row per subscribed webhook
    // The whole fixture chain was rolled back, so the pool has no issue row to read at all.
    const gone = await state(db, f);
    expect(gone.exists).toBe(0);
    expect([gone.at, gone.links, gone.acts, gone.queued]).toEqual([null, [], 0, 0]);
  }, 60_000);
  it('accepts a label the same transaction created, and names it in the log', async () => {
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'minted');
      const fresh = sql`INSERT INTO label (project_id, name) VALUES (${f.projectId}, 'just-minted') RETURNING id`;
      const minted = await row<{ id: number }>(tx, fresh);
      // On the default pool this call refuses its own label: the check cannot see an uncommitted label.
      await setIssueLabels(f.projectId, f.issueId, [minted.id], f.actorId, true, ex);
      const on = { links: await links(tx, f.issueId), acts: await activity(tx, f.issueId) };
      return { f, on };
    });
    expect(on.links).toEqual([on.acts[0].toId]);
    expect(on.acts.length).toBe(1);
    expect(on.acts[0].action).toBe('label_add');
    expect(on.acts[0].to).toBe('just-minted');
    expect(await links(db, f.issueId)).toEqual([]);
    const left = sql`SELECT count(*)::int AS n FROM label WHERE name = 'just-minted'`;
    expect((await row<{ n: number }>(db, left)).n).toBe(0);
  }, 60_000);
  it('holds the no-change contract: the same set moves nothing and logs nothing', async () => {
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'nochange');
      const { alpha, beta } = f.labels;
      await setIssueLabels(f.projectId, f.issueId, [alpha.id, beta.id], f.actorId, true, ex);
      const first = await state(tx, f);
      // Reordered and duplicated is the same set: no add, no remove, no log, no delivery, no updatedAt.
      const again = [beta.id, alpha.id, beta.id];
      await setIssueLabels(f.projectId, f.issueId, again, f.actorId, true, ex);
      return { f, on: { first, after: await state(tx, f) } };
    });
    expect(on.after.links).toEqual([f.labels.alpha.id, f.labels.beta.id]);
    expect(on.after.acts).toBe(on.first.acts); // still only the two adds from the first call
    expect(on.after.queued).toBe(on.first.queued);
    expect(on.after.at).toBe(on.first.at);
    expect(on.first.at).toBeGreaterThan(pastEpoch(f));
    const gone = await state(db, f);
    expect(gone.exists).toBe(0);
    expect([gone.at, gone.links, gone.acts, gone.queued]).toEqual([null, [], 0, 0]);
  }, 60_000);
  it('keeps emitEvent=false: the log is written, the granular webhook is not', async () => {
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'quiet');
      const ids = [f.labels.alpha.id, f.labels.gamma.id];
      await setIssueLabels(f.projectId, f.issueId, ids, f.actorId, false, ex);
      return { f, on: await state(tx, f) };
    });
    expect(on.links).toEqual([f.labels.alpha.id, f.labels.gamma.id]);
    expect(on.acts).toBe(2);
    expect(on.queued).toBe(0);
  }, 60_000);
  it('keeps the default-pool path and its committed rows', async () => {
    const f = await fixtures(db, 'pool');
    await setIssueLabels(f.projectId, f.issueId, [f.labels.alpha.id], f.actorId);
    expect(await links(db, f.issueId)).toEqual([f.labels.alpha.id]);
    expect((await activity(db, f.issueId)).map((a) => a.action)).toEqual(['label_add']);
    const queued = await deliveries(db, f.projectId);
    expect(queued.map((d) => d.event)).toEqual(['issue.label_changed', 'issue.label_changed']);
    const change = parsed(queued[0].change);
    expect(change.added.map((l) => l.name)).toEqual(['alpha']);
    expect(change.added.map((l) => l.id)).toEqual([f.labels.alpha.id]);
    expect((await state(db, f)).at).toBeGreaterThan(pastEpoch(f));
    await setIssueLabels(f.projectId, f.issueId, [], f.actorId); // the empty set removes
    expect(await links(db, f.issueId)).toEqual([]);
    const after = (await activity(db, f.issueId)).map((a) => a.action);
    expect(after).toEqual(['label_add', 'label_remove']);
    expect((await state(db, f)).exists).toBe(1); // committed, so the pool still reads it
  }, 60_000);
  it('refuses a label from another project and leaves the before-state untouched', async () => {
    let failure: unknown = null;
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'foreign');
      const seed = sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${f.issueId}, ${f.labels.alpha.id})`;
      await run(tx, seed);
      const before = await state(tx, f);
      const ids = [f.labels.beta.id, f.foreignLabel.id];
      try {
        await setIssueLabels(f.projectId, f.issueId, ids, f.actorId, true, ex);
      } catch (error) {
        failure = error;
      }
      return { f, on: { before, after: await state(tx, f) } };
    });
    expect(errorChain(failure)).toContain('400');
    expect(errorChain(failure)).toContain('Labels must belong to this project');
    expect(on.after).toEqual(on.before); // the refusal wrote nothing, not even a partial set
    expect((await state(db, f)).exists).toBe(0);
  }, 60_000);
  it('rolls the whole transaction back when a write after the labels fails', async () => {
    let failure: unknown = null;
    let advanced = false;
    const f = await fixtures(db, 'trap'); // committed before-state on the pool
    const seed = sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${f.issueId}, ${f.labels.alpha.id})`;
    await run(db, seed);
    const committed = await state(db, f);
    const trap = trapNames('trap');
    try {
      await db.transaction(async (tx) => {
        const ex = tx as unknown as LabelExecutor;
        await run(tx, trap.fn);
        await run(tx, trap.trigger);
        const ids = [f.labels.beta.id, f.labels.gamma.id];
        await setIssueLabels(f.projectId, f.issueId, ids, f.actorId, true, ex);
        advanced = true; // must stay false: the awaited call rejects
      });
    } catch (error) {
      failure = error;
    }
    expect(advanced).toBe(false);
    expect(errorChain(failure)).toContain('q3lbl label trap');
    expect(await state(db, f)).toEqual(committed); // links, updatedAt, log and delivery as committed
    expect(await row<{ f: number; t: number }>(db, trap.gone)).toEqual({ f: 0, t: 0 });
  }, 60_000);
  it('logs a remove with the name the label held at change time, after the adds', async () => {
    const { f, on } = await inside(async (tx) => {
      const ex = tx as unknown as LabelExecutor;
      const f = await fixtures(tx as unknown as Executor, 'rename');
      const seed = sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${f.issueId}, ${f.labels.alpha.id})`;
      await run(tx, seed);
      const ids = [f.labels.beta.id, f.labels.gamma.id];
      await setIssueLabels(f.projectId, f.issueId, ids, f.actorId, true, ex);
      await run(tx, sql`UPDATE label SET name = 'renamed-alpha' WHERE id = ${f.labels.alpha.id}`);
      const on = { acts: await activity(tx, f.issueId), queued: await deliveries(tx, f.projectId) };
      return { f, on };
    });
    expect(on.acts.map((a) => a.action)).toEqual(['label_add', 'label_add', 'label_remove']);
    expect(on.acts.map((a) => a.id)).toEqual([...on.acts.map((a) => a.id)].sort((x, y) => x - y));
    expect(on.acts[2].from).toBe('alpha'); // the name at change time, not the later rename
    const change = parsed(on.queued[0].change);
    expect(change.added).toEqual([
      { id: f.labels.beta.id, name: 'beta' },
      { id: f.labels.gamma.id, name: 'gamma' },
    ]);
    expect(change.removed).toEqual([{ id: f.labels.alpha.id, name: 'alpha' }]);
    expect(on.queued.map((d) => d.webhookId).sort()).toEqual([...f.webhooks.subscribed].sort());
    expect(on.queued.every((d) => d.action === 'update' && d.type === 'Issue')).toBe(true);
  }, 60_000);
  it('leaves no fixture, trigger or function of its own behind', async () => {
    expect(await counts()).toEqual(baseline);
    expect(Object.values(baseline)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const own = sql`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'q3lbl_%'`;
    expect((await row<{ n: number }>(db, own)).n).toBe(0);
    expect(cleanupErrors).toEqual([]);
  }, 60_000);
});
