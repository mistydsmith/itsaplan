// Fixtures for the gated direct label writer (8364 U4). Every row here is made by this file, remembered by its exact id, and removed by that id; the one
// thing it keeps is the synthetic rig the schema forbids deleting, exactly as Root's fixture ruling allows. It imports no A4 fixture module and nothing
// here reaches outside this suite's own projects. DATABASE HELD: this file and tracker-labels-gate.test.ts stop at the guard below unless Root's serial DB
// GO sets the grant, so the prepared suite cannot touch a database on its own - no reset, truncate, clone, create or drop, no migration, provider or
// sender, no trigger change, no rig delete and no ledger delete.
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
export const GRANT = 'ITSAPLAN_8364_U4_LABEL_GATE_PROOF';
export const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R3/CONFIG.json';
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const RIG_PREFIX = `q3u4${randomUUID().replace(/-/g, '')}`;
export const SIZE_SMALL = 'size-small';
export const SIZE_LARGE = 'size-large';
export const LAW_LABEL = 'law-library';
export const PLAIN_LABEL = 'plain-label';
const RACE_ABORT = Symbol('activation rolled back');

export function grantAndTarget(): string {
  if (process.env[GRANT] !== 'granted')
    throw new Error(
      `DB held: this suite runs only when ${GRANT}=granted is set by Root's serial DB GO`,
    );
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  // An absent port is not 5433: Postgres answers on 5432 when a URL omits it, so the grant requires the port to be spelled out.
  if (url.port !== '5433')
    throw new Error(`refusing a target whose port is not exactly 5433 (got "${url.port}")`);
  const name = url.pathname.replace(/^\//, '');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return url.toString();
}
void grantAndTarget();
const { sql } = await import('drizzle-orm');
export const db = (await import('@repo/db')).db;
export const { setIssueLabels, bulkAddLabels, createIssue } = await import('../../service');
export const { getProjectById } = await import('../../../projects/service');
export const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
export const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as Record<string, string>;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Board = {
  seq: number;
  root: number;
  issues: number;
  identities: number;
  labels: number;
  activity: number;
  notifications: number;
  runs: number;
  webhooks: number;
  deliveries: number;
  updatedAt: string | null;
};
export type Link = { labelId: number; name: string };
export type Act = { action: string; from: string | null; to: string | null };
export type LabelRef = { id: number; name: string | null };
export type Delivery = { webhookId: number; event: string; added: LabelRef[]; removed: LabelRef[] };
// The caller-facing shape the API maps a shared refusal to: service.ts turns a TrackerGateRefusal into an HttpError 409 carrying the code.
export type Refusal = { status: number; message: string; code?: string };
export type GateFacts = {
  projectId: number;
  rigId: number | null;
  columnId: number;
  actorId: string;
  small: number;
  large: number;
  plain: number;
  law: number;
  hookId: number;
};
export type Card = { issueId: number; beadId: string | null; title: string };

const BUCKETS = [
  'issue',
  'label',
  'column',
  'project',
  'team',
  'workspace',
  'hook',
  'rig',
] as const;
type Bucket = (typeof BUCKETS)[number];
// Two inventories, deliberately separate: `made` is the queue cleanup still has to do and drains as it works; `ever` is the immutable record of every id
// this run created, and only the immutable one can answer what the run left behind.
const made = Object.fromEntries(BUCKETS.map((bucket) => [bucket, [] as number[]])) as Record<
  Bucket,
  number[]
>;
const ever = Object.fromEntries(BUCKETS.map((bucket) => [bucket, [] as number[]])) as Record<
  Bucket,
  number[]
>;
const pendingUsers: string[] = [];
const everUsers: string[] = [];
export const cleanupErrors: string[] = [];
const pastStamp = new Date(Date.now() - 86_400_000).toISOString();
// Every gate variable a case sets comes back exactly as it was: nothing the process genuinely had is erased, and nothing a case set leaks onward.
export async function withGateEnv<T>(env: [string, string, string], run: () => Promise<T>) {
  const names = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];
  const prior = names.map((name) => process.env[name]);
  names.forEach((name, index) => (process.env[name] = env[index]));
  try {
    return await run();
  } finally {
    names.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name];
      else process.env[name] = prior[index];
    });
  }
}
export const withOwner = <T>(run: () => Promise<T>) =>
  withGateEnv([OWNER.python, OWNER.owner, OWNER_CONFIG], run);
export const withBrokenConfig = <T>(run: () => Promise<T>) =>
  withGateEnv([OWNER.python, '/dev/null/nonexistent-owner.py', '/dev/null'], run);
export const withNoConfig = <T>(run: () => Promise<T>) => withGateEnv(['', '', ''], run);

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(query)) as unknown as T[])[0];
}
function track(bucket: Bucket, id: number): number {
  made[bucket].push(id);
  ever[bucket].push(id);
  return id;
}
async function insert(bucket: Bucket, query: ReturnType<typeof sql>): Promise<number> {
  return track(bucket, Number((await one<{ id: number | string }>(query)).id));
}
// A failed delete is recorded, never thrown: cleanup must not hide the failure a case just found. Deletion order follows the foreign keys.
async function drop(table: string, where: string, value: number | string): Promise<void> {
  const query = sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(where)} = ${value}`;
  await db.execute(query).catch((error) => cleanupErrors.push(`${table} ${value}: ${error}`));
}
export async function cleanUp(): Promise<void> {
  // A bead identity is never deleted: bead_identity_no_delete (packages/db/drizzle/0181_tracker_identity.sql) raises on any ledger delete, and deleting
  // the issue makes its ledger row the tombstone Root's ruling keeps: only the issue's own rows are named, never the ledger, and 'hook' names no table.
  for (const id of made.issue.splice(0)) {
    for (const table of ['issue_label', 'issue_activity', 'notification'])
      await drop(table, 'issue_id', id);
    await drop('issue', 'id', id);
  }
  for (const id of made.project.splice(0)) {
    const hooks = sql`(SELECT id FROM webhook WHERE project_id = ${id})`;
    await db
      .execute(sql`DELETE FROM webhook_delivery WHERE webhook_id IN ${hooks}`)
      .catch((error) => cleanupErrors.push(`webhook_delivery ${id}: ${error}`));
    await drop('webhook', 'project_id', id);
    await drop('label', 'project_id', id);
    await drop('project_column', 'project_id', id);
    await drop('project', 'id', id);
  }
  for (const bucket of ['label', 'column', 'team', 'workspace'] as const)
    for (const id of made[bucket].splice(0))
      await drop(bucket === 'column' ? 'project_column' : bucket, 'id', id);
  for (const id of pendingUsers.splice(0)) await drop('"user"', 'id', id);
}
let rig: number | null = null;
export async function sharedRig(): Promise<number> {
  if (rig === null)
    rig = await insert('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rig;
}

// The whole board one call could possibly have moved, in one read, including the issue's own updatedAt. Every count is cast to int: a bare PostgreSQL
// count comes back as bigint, which Bun hands over as a string, and a number assertion on a string fails for the wrong reason.
export async function board(f: GateFacts): Promise<Board> {
  const cards = sql`(SELECT id FROM issue WHERE project_id = ${f.projectId})`;
  const hooks = sql`(SELECT id FROM webhook WHERE project_id = ${f.projectId})`;
  return one<Board>(sql`
    SELECT (SELECT next_sequence FROM project WHERE id = ${f.projectId})::int AS seq,
           coalesce((SELECT next_root FROM rig WHERE id = ${f.rigId}), 0)::int AS root,
           (SELECT count(*) FROM issue WHERE project_id = ${f.projectId})::int AS issues,
           (SELECT count(*) FROM bead_identity WHERE rig_id = ${f.rigId})::int AS identities,
           (SELECT count(*) FROM issue_label WHERE issue_id IN ${cards})::int AS labels,
           (SELECT count(*) FROM issue_activity WHERE issue_id IN ${cards})::int AS activity,
           (SELECT count(*) FROM notification WHERE project_id = ${f.projectId})::int AS notifications,
           (SELECT count(*) FROM agent_run WHERE issue_id IN ${cards})::int AS runs,
           (SELECT count(*) FROM webhook WHERE project_id = ${f.projectId})::int AS webhooks,
           (SELECT count(*) FROM webhook_delivery WHERE webhook_id IN ${hooks})::int AS deliveries,
           (SELECT max(updated_at) FROM issue WHERE project_id = ${f.projectId}) AS "updatedAt"`);
}
export async function linksOf(issueId: number): Promise<Link[]> {
  return (
    await one<{
      rows: Link[];
    }>(sql`SELECT coalesce(json_agg(json_build_object('labelId', il.label_id, 'name', l.name)
      ORDER BY l.name), '[]'::json) AS rows FROM issue_label il JOIN label l ON l.id = il.label_id
      WHERE il.issue_id = ${issueId}`)
  ).rows;
}
export async function activityOf(issueId: number): Promise<Act[]> {
  return (
    await one<{ rows: Act[] }>(sql`SELECT coalesce(json_agg(json_build_object('action', a.action,
      'from', a.payload -> 'from' ->> 'value', 'to', a.payload -> 'to' ->> 'value') ORDER BY a.id), '[]'::json) AS rows
      FROM issue_activity a WHERE a.issue_id = ${issueId}`)
  ).rows;
}
export async function deliveriesOf(projectId: number): Promise<Delivery[]> {
  const change = (key: string) => sql`d.payload -> 'data' -> 'labelChange' -> ${key}`;
  return (
    await one<{
      rows: Delivery[];
    }>(sql`SELECT coalesce(json_agg(json_build_object('webhookId', d.webhook_id,
      'event', d.event_type, 'added', ${change('added')}, 'removed', ${change('removed')}) ORDER BY d.id), '[]'::json) AS rows
      FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id WHERE w.project_id = ${projectId}`)
  ).rows;
}
export async function rigOf(projectId: number): Promise<number | null> {
  const rows = await db.execute(sql`SELECT rig_id AS "rigId" FROM project WHERE id = ${projectId}`);
  return (rows as unknown as { rigId: number | null }[])[0].rigId;
}
// The refusal an API caller actually receives. A write that was allowed when it should have refused is itself the failure.
export async function refusalOf(make: () => Promise<unknown>): Promise<Refusal> {
  try {
    await make();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('a gated label write was allowed that it should have refused');
}
export async function fixture(gated: boolean, tag: string): Promise<GateFacts> {
  const suffix = `zz_qwen3_u4-${tag}-${Date.now().toString(36)}`;
  const rigId = gated ? await sharedRig() : null;
  const chain = await one<{ ws: number; team: number; proj: number; col: number }>(sql`
    WITH ws AS (INSERT INTO workspace (name) VALUES (${`u4 ws ${suffix}`}) RETURNING id),
      tm AS (INSERT INTO team (workspace_id, name, slug) SELECT id, ${`u4 team ${suffix}`}, ${`u4-${suffix}`} FROM ws RETURNING id),
      pr AS (INSERT INTO project (team_id, key, name, rig_id)
             SELECT id, ${`U4${suffix.slice(-6).toUpperCase()}`}, ${`u4 project ${suffix}`}, ${rigId} FROM tm RETURNING id),
      cl AS (INSERT INTO project_column (project_id, name, position) SELECT id, 'Todo', 1 FROM pr RETURNING id)
    SELECT ws.id AS ws, tm.id AS team, pr.id AS proj, cl.id AS col FROM ws, tm, pr, cl`);
  track('workspace', chain.ws);
  track('team', chain.team);
  track('project', chain.proj);
  track('column', chain.col);
  const actor = `u4-${suffix}`;
  const userId = String(
    (
      await one<{ id: string }>(sql`INSERT INTO "user" (id, name, username, email, email_verified)
      VALUES (${actor}, 'Label Gate Actor', ${actor.replace(/[^a-z0-9]/gi, '').toLowerCase()},
              ${`${actor}@example.com`}, true) RETURNING id`)
    ).id,
  );
  pendingUsers.push(userId);
  everUsers.push(userId);
  // A data-modifying statement belongs in a WITH clause: PostgreSQL refuses an INSERT nested as a sub-select in FROM. Names are ordered so the ids always
  // land in the same slots.
  const labels = await one<{ ids: number[] }>(sql`
    WITH created AS (INSERT INTO label (project_id, name, color) VALUES
        (${chain.proj}, ${LAW_LABEL}, '#123456'), (${chain.proj}, ${PLAIN_LABEL}, '#123456'),
        (${chain.proj}, ${SIZE_LARGE}, '#123456'), (${chain.proj}, ${SIZE_SMALL}, '#123456')
      RETURNING id, name)
    SELECT json_agg(id ORDER BY name) AS ids FROM created`);
  for (const id of labels.ids) track('label', id);
  const hookId = await insert(
    'hook',
    sql`INSERT INTO webhook (project_id, url, secret, events) VALUES (${chain.proj}, 'http://127.0.0.1:5594/one',
          'q3u4-secret', ${'["issue.label_changed"]'}::jsonb) RETURNING id`,
  );
  const [law, plain, large, small] = labels.ids;
  return {
    projectId: chain.proj,
    rigId,
    columnId: chain.col,
    actorId: actor,
    small,
    large,
    plain,
    law,
    hookId,
  };
}
// A card made through createIssue: it carries the bead identity the gate reads, plus a stored size label. The new issue is recorded the moment createIssue
// returns, before any later statement could fail and lose track of it.
export async function gatedCard(f: GateFacts, title: string): Promise<Card> {
  const project = await getProjectById(f.projectId);
  if (!project) throw new Error('project missing');
  const created = await withOwner(() =>
    createIssue(project, { columnId: f.columnId, title, labelIds: [f.small] }),
  );
  const issueId = track('issue', Number(created.id));
  await db.execute(sql`UPDATE issue SET updated_at = ${pastStamp} WHERE id = ${issueId}`);
  const row = await one<{ beadId: string | null; title: string }>(
    sql`SELECT bead_id AS "beadId", title FROM issue WHERE id = ${issueId}`,
  );
  return { issueId, beadId: row.beadId, title: row.title };
}
export async function ordinaryCard(f: GateFacts, title: string, sequence: number): Promise<Card> {
  const row = await one<{
    id: number;
  }>(sql`WITH new AS (INSERT INTO issue (project_id, sequence_number, column_id, title, updated_at)
    VALUES (${f.projectId}, ${sequence}, ${f.columnId}, ${title}, ${pastStamp}) RETURNING id) SELECT id FROM new`);
  const issueId = track('issue', row.id);
  await db.execute(
    sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${f.small})`,
  );
  return { issueId, beadId: null, title };
}
// The gate reads the card's stored state, so a case that needs a stored label sets it the way a stored label exists: on the row.
export async function storeLabel(issueId: number, labelId: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${labelId})`,
  );
}
export async function assign(issueId: number, actorId: string): Promise<void> {
  await db.execute(sql`UPDATE issue SET assignee_user_id = ${actorId} WHERE id = ${issueId}`);
}
export type Race = { waiting: number; blockedByOther: number; saved: boolean; refusal?: Refusal };
// The activation race: one connection holds an uncommitted UPDATE of the project row - the only way apps/api activates a rig - and the label save starts
// against it. The run observes a real wait (backends waiting on a lock, and how many wait on another backend's uncommitted row) before releasing the
// holder. The holder is released and both promises awaited on every exit path, so no lock and no rejection leak from a failing case.
export async function activationRace(
  projectId: number,
  rigId: number,
  mode: 'commit' | 'rollback',
  save: () => Promise<void>,
): Promise<Race> {
  let release = (): void => undefined;
  let reached = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (reached = resolve));
  let holder = Promise.resolve();
  let saving = Promise.resolve();
  let waiting = 0;
  let blockedByOther = 0;
  const outcome = { saved: false, refusal: undefined as Refusal | undefined };
  try {
    holder = db
      .transaction(async (tx) => {
        await tx.execute(sql`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`);
        reached();
        await gate;
        if (mode === 'rollback') throw RACE_ABORT;
      })
      .catch((error) => {
        if (error !== RACE_ABORT) throw error;
      });
    const held = await Promise.race([started, holder.then(() => 'ended' as const)]);
    if (held === 'ended')
      throw new Error('the activation transaction ended before it held the project row');
    saving = save().then(
      () => {
        outcome.saved = true;
      },
      (error) => {
        outcome.refusal = error as Refusal;
      },
    );
    for (let attempt = 0; attempt < 40 && blockedByOther === 0; attempt += 1) {
      const seen = await one<{ waiting: number; blockedByOther: number }>(sql`
        SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                  AND wait_event_type = 'Lock')::int AS waiting,
               (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = current_database()
                  AND a.wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(a.pid)) > 0)::int AS "blockedByOther"`);
      waiting = seen.waiting;
      blockedByOther = seen.blockedByOther;
      if (blockedByOther === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    release();
    await Promise.allSettled([holder, saving]);
  }
  return { waiting, blockedByOther, ...outcome };
}
// Back to ordinary: only this suite's own fixture project, and only the rig id this race set.
export async function resetRig(f: GateFacts): Promise<void> {
  await db.execute(sql`UPDATE project SET rig_id = NULL WHERE id = ${f.projectId}`);
}
// Activation leaves the ordinary fixture cards without ledger identities.
export async function activateRig(f: GateFacts, rigId: number): Promise<void> {
  await db.execute(sql`UPDATE project SET rig_id = ${rigId} WHERE id = ${f.projectId}`);
}
export type LedgerRow = { local_token: string; issue_id: number | null };
export async function ledgerOf(prefix: string): Promise<LedgerRow[]> {
  const rows = await one<{ tokens: LedgerRow[] }>(sql`
    SELECT coalesce(json_agg(json_build_object('local_token', b.local_token, 'issue_id', b.issue_id) ORDER BY b.local_token),
      '[]'::json) AS tokens FROM bead_identity b JOIN rig r ON r.id = b.rig_id WHERE r.prefix = ${prefix}`);
  return rows.tokens;
}
export async function residue(): Promise<Record<string, number>> {
  const array = (items: (number | string)[]) =>
    sql`ARRAY[${sql.join(
      items.map((value) => sql`${value}`),
      sql`, `,
    )}]`;
  const ids = (list: number[]) => array(list.length ? list : [-1]);
  const users = array(everUsers.length ? everUsers : ['none']);
  return one<Record<string, number>>(sql`
    SELECT (SELECT count(*) FROM project WHERE id = ANY(${ids(ever.project)}::int[]))::int AS project,
           (SELECT count(*) FROM label WHERE id = ANY(${ids(ever.label)}::int[]))::int AS label,
           (SELECT count(*) FROM webhook WHERE id = ANY(${ids(ever.hook)}::int[]))::int AS webhook,
           (SELECT count(*) FROM project_column WHERE id = ANY(${ids(ever.column)}::int[]))::int AS column,
           (SELECT count(*) FROM team WHERE id = ANY(${ids(ever.team)}::int[]))::int AS team,
           (SELECT count(*) FROM workspace WHERE id = ANY(${ids(ever.workspace)}::int[]))::int AS workspace,
           (SELECT count(*) FROM issue WHERE id = ANY(${ids(ever.issue)}::int[]))::int AS issue,
           (SELECT count(*) FROM rig WHERE prefix = ${RIG_PREFIX})::int AS rig,
           (SELECT count(*) FROM "user" WHERE id = ANY(${users}::text[]))::int AS "user"`);
}
