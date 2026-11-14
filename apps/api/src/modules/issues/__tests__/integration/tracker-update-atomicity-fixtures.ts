import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

// Synthetic fixtures for the gated UPDATE atomicity proof. Real rows, real public writers, the real
// pinned tracker owner. DATABASE HELD: the guard refuses before any client unless Root's serial DB GO
// set the grant flag. No reset, migration, clone, trigger disable or rig/ledger delete.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_D4_UPDATE_ATOMICITY';
// Root's immutable R3 pin (the safe-forms map fix); the R2 config stays untouched for its own runs.
const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R3/CONFIG.json';
export const MARK = 'zz_a4_d4_update';

function grantAndTarget(): void {
  if (process.env[GRANT] !== 'granted')
    throw new Error(
      `DB held: this suite runs only when ${GRANT}=granted is set by Root's serial DB GO`,
    );
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  // An omitted port connects 5432, so the fallback must be 5432 for this to refuse it.
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
}
void grantAndTarget();

const { db } = await import('@repo/db');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
const { createIssue } = await import('../../service');
const { getProjectById } = await import('../../../projects/service');

export async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(query)) as unknown as T[])[0];
}
export function many<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return db.execute(query) as unknown as Promise<T[]>;
}

const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE_NAMES = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];

// The real gate config, installed for the call and restored exactly as it was.
export async function withOwner<T>(run: () => Promise<T>): Promise<T> {
  const prior = GATE_NAMES.map((name) => process.env[name]);
  [OWNER.python, OWNER.owner, OWNER_CONFIG].forEach((value, i) => {
    process.env[GATE_NAMES[i]] = value;
  });
  try {
    return await run();
  } finally {
    GATE_NAMES.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}

const BUCKETS = [
  'issue',
  'agent',
  'cycle',
  'schedule',
  'webhook',
  'label',
  'column',
  'project',
  'team',
  'workspace',
  'rig',
] as const;
type Bucket = (typeof BUCKETS)[number];
export const made = Object.fromEntries(BUCKETS.map((b) => [b, [] as number[]])) as Record<
  Bucket,
  number[]
>;
// Append-only: the residue read still needs these ids after cleanup spliced the live buckets.
export const everMade = Object.fromEntries(BUCKETS.map((b) => [b, [] as number[]])) as Record<
  Bucket,
  number[]
>;
const CLEANUP: [Bucket, string][] = [
  ['issue', 'issue'],
  ['schedule', 'agent_schedule'],
  ['agent', 'ai_agent'],
  ['cycle', 'cycle'],
  ['webhook', 'webhook'],
  ['label', 'label'],
  ['column', 'project_column'],
  ['project', 'project'],
  ['team', 'team'],
  ['workspace', 'workspace'],
];
export const minted: string[] = [];
export const madeUsers: string[] = [];
export const everUsers: string[] = [];
export const cleanupErrors: string[] = [];
export const fixtureProjects: { id: number; expectedIssues: number }[] = [];

export async function makeRow(bucket: Bucket, insert: ReturnType<typeof sql>): Promise<number> {
  const id = (await one<{ id: number }>(insert)).id;
  made[bucket].push(id);
  everMade[bucket].push(id);
  return id;
}

async function makeUser(suffix: string, role: string): Promise<{ id: string; username: string }> {
  const row = await one<{ id: string; username: string }>(
    sql`INSERT INTO "user" (id, name, username, email, email_verified)
        VALUES (${`${MARK}-${role}-${suffix}`}, ${role}, ${`${role}${suffix}`}, ${`${role}-${suffix}@example.com`}, true)
        RETURNING id, username`,
  );
  madeUsers.push(row.id);
  everUsers.push(row.id);
  return row;
}

export const RIG_PREFIX = `a4d4${crypto.randomUUID().replace(/-/g, '')}`;
let rigId: number | null = null;
async function sharedRig(): Promise<number> {
  if (rigId === null)
    rigId = await makeRow('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rigId;
}

export interface UpdateBoard {
  column: number;
  title: string;
  description: string;
  cycle: number | null;
  updated_at: string;
  stretches: number;
  open_stretches: number;
  activity: number;
  notifications: number;
  deliveries_updated: number;
  deliveries_state: number;
  cycle_rows: number;
  runs: number;
  seq: number;
  root: number;
  identities: number;
}

export async function board(projectId: number, issueId: number, rig: number | null) {
  return one<UpdateBoard>(sql`
    SELECT (SELECT column_id FROM issue WHERE id = ${issueId}) AS column,
      (SELECT title FROM issue WHERE id = ${issueId}) AS title,
      (SELECT description FROM issue WHERE id = ${issueId}) AS description,
      (SELECT cycle_id FROM issue WHERE id = ${issueId}) AS cycle,
      (SELECT updated_at::text FROM issue WHERE id = ${issueId}) AS updated_at,
      (SELECT count(*)::int FROM issue_status WHERE issue_id = ${issueId}) AS stretches,
      (SELECT count(*)::int FROM issue_status WHERE issue_id = ${issueId} AND left_at IS NULL) AS open_stretches,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${issueId}) AS activity,
      (SELECT count(*)::int FROM notification WHERE issue_id = ${issueId}) AS notifications,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId}) AND event_type = 'issue.updated') AS deliveries_updated,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId}) AND event_type = 'issue.state_changed') AS deliveries_state,
      (SELECT count(*)::int FROM issue_cycle WHERE issue_id = ${issueId}) AS cycle_rows,
      (SELECT count(*)::int FROM agent_run WHERE issue_id = ${issueId}) AS runs,
      (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq,
      (SELECT coalesce(next_root, 0) FROM rig WHERE id = ${rig}) AS root,
      (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${rig}) AS identities`);
}

export interface UpdateFixture {
  projectId: number;
  issueId: number;
  rigId: number | null;
  todoId: number;
  doingId: number;
  doneId: number;
  cycleId: number;
  actorId: string;
  mentionHandle: string;
  webhookId: number;
  sizeLabelId: number;
  localToken: string;
}

// Three columns, two non-terminal and one terminal, no auto-assignee; author, mentioned member and an
// internal agent as members; a cycle; a webhook on the two events this unit emits; and an active status
// schedule on the target column, so a move has a real run row to queue. No provider or network call.
export async function updateFixture(gated: boolean, tag: string): Promise<UpdateFixture> {
  const suffix = `${tag}-${Date.now()}`;
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${`${MARK} ws ${suffix}`}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${`${MARK} team`}, ${`${MARK}-${suffix}`}) RETURNING id`,
  );
  const rig = gated ? await sharedRig() : null;
  const project = await makeRow(
    'project',
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`A4D4${ws}`}, ${`${MARK} project`}, ${rig}) RETURNING id`,
  );
  fixtureProjects.push({ id: project, expectedIssues: 1 });
  const makeColumn = (name: string, position: number, stateType: string) =>
    makeRow(
      'column',
      sql`INSERT INTO project_column (project_id, name, position, state_type) VALUES (${project}, ${name}, ${position}, ${stateType}) RETURNING id`,
    );
  const todoId = await makeColumn('Todo', 1, 'unstarted');
  const doingId = await makeColumn('Doing', 2, 'started');
  const doneId = await makeColumn('Done', 3, 'completed');
  const actor = await makeUser(suffix, 'actor');
  const member = await makeUser(suffix, 'member');
  const bot = await makeUser(suffix, 'agent');
  for (const userId of [actor.id, member.id, bot.id]) {
    await db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${project}, ${userId}, 'member')`,
    );
  }
  const agentId = await makeRow(
    'agent',
    sql`INSERT INTO ai_agent (team_id, user_id, username, kind)
        VALUES (${team}, ${bot.id}, ${`agent${project}`}, 'internal') RETURNING id`,
  );
  const sizeLabelId = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name) VALUES (${project}, 'size-small') RETURNING id`,
  );
  await makeRow(
    'schedule',
    sql`INSERT INTO agent_schedule (agent_id, project_id, name, prompt, timezone, status, type, column_id)
        VALUES (${agentId}, ${project}, ${`status run ${suffix}`}, 'Walk the item', 'UTC', 'active', 'status', ${doingId})
        RETURNING id`,
  );
  const cycleId = await makeRow(
    'cycle',
    sql`INSERT INTO cycle (project_id, name, start_date, end_date)
        VALUES (${project}, ${`cycle ${suffix}`}, '2026-01-01', '2026-12-31') RETURNING id`,
  );
  const webhookId = await makeRow(
    'webhook',
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${project}, 'https://example.invalid/update', 'dummy', ${JSON.stringify([
          'issue.updated',
          'issue.state_changed',
        ])}::jsonb) RETURNING id`,
  );
  const projectRow = await getProjectById(project);
  if (!projectRow) throw new Error('project missing');
  const created = await withOwner(() =>
    createIssue(
      projectRow,
      { columnId: todoId, title: `update subject ${suffix}`, labelIds: [sizeLabelId] },
      actor.id,
    ),
  );
  made.issue.push(created.id);
  // A non-actor watcher, so the status change has its own recipient next to the mention (+2 total).
  await db.execute(
    sql`INSERT INTO issue_watcher (issue_id, user_id) VALUES (${created.id}, ${member.id})`,
  );
  // The writer returns the row whose bead_id column carries the token; read it back by exact id.
  const identity = await one<{ bead_id: string | null }>(
    sql`SELECT bead_id FROM issue WHERE id = ${created.id}`,
  );
  if (identity.bead_id) minted.push(identity.bead_id);
  return {
    projectId: project,
    issueId: created.id,
    rigId: rig,
    todoId,
    doingId,
    doneId,
    cycleId,
    actorId: actor.id,
    mentionHandle: member.username,
    webhookId,
    sizeLabelId,
    localToken: identity.bead_id ? identity.bead_id.slice(RIG_PREFIX.length + 1) : '',
  };
}

// An owned INSERT-time trigger on webhook_delivery, scoped to this project and to issue.state_changed -
// the last queue insert before the status runs. It raises a distinct EARLY marker unless the same
// transaction already sees the moved row and the earlier side effects, then the intended LATE one.
export async function withLateStateFailure<T>(
  projectId: number,
  targetColumnId: number,
  markers: { early: string; late: string },
  run: () => Promise<T>,
): Promise<T> {
  const nonce = `u3c4_update_${Date.now()}`;
  await db.execute(sql`CREATE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
DECLARE
  v_issue_id int; in_target int; stretches int; acts int; notes int; updated_deliveries int;
BEGIN
  IF NEW.event_type = 'issue.state_changed'
     AND NEW.webhook_id IN (SELECT w.id FROM webhook w WHERE w.project_id = ${sql.raw(String(projectId))}) THEN
    v_issue_id := (NEW.payload->'data'->>'id')::int;
    SELECT count(*) INTO in_target FROM issue i
      WHERE i.id = v_issue_id AND i.column_id = ${sql.raw(String(targetColumnId))};
    SELECT count(*) INTO stretches FROM issue_status s
      WHERE s.issue_id = v_issue_id AND s.left_at IS NULL;
    SELECT count(*) INTO acts FROM issue_activity a WHERE a.issue_id = v_issue_id;
    SELECT count(*) INTO notes FROM notification n WHERE n.issue_id = v_issue_id;
    SELECT count(*) INTO updated_deliveries FROM webhook_delivery
      WHERE webhook_id = NEW.webhook_id AND event_type = 'issue.updated';
    IF in_target <> 1 OR stretches <> 1 OR acts < 2 OR notes < 1 OR updated_deliveries <> 1 THEN
      RAISE EXCEPTION '${sql.raw(markers.early)} moved=% stretches=% acts=% notes=% updated=%',
        in_target, stretches, acts, notes, updated_deliveries USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION '${sql.raw(markers.late)}' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`);
  try {
    await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} BEFORE INSERT ON webhook_delivery
FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
    return await run();
  } finally {
    try {
      await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON webhook_delivery`);
    } catch (error) {
      cleanupErrors.push(`drop trigger: ${(error as Error).message}`);
    }
    try {
      await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(nonce)}()`);
    } catch (error) {
      cleanupErrors.push(`drop function: ${(error as Error).message}`);
    }
  }
}

export function causeChain(error: unknown): string {
  const parts: string[] = [];
  type Link = { message?: unknown; code?: unknown; cause?: unknown } | null;
  for (let link = error as Link; link; link = link.cause as Link) {
    parts.push(String(link.code ?? '') + String(link.message ?? link));
  }
  return parts.join(' | ');
}

export async function cleanUp(): Promise<void> {
  for (const [bucket, table] of CLEANUP) {
    for (const id of made[bucket].splice(0)) {
      try {
        await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`);
      } catch (error) {
        cleanupErrors.push(`${table} ${id}: ${(error as Error).message}`);
      }
    }
  }
  for (const id of madeUsers.splice(0)) {
    try {
      await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
    } catch (error) {
      cleanupErrors.push(`user ${id}: ${(error as Error).message}`);
    }
  }
}

export async function residue(): Promise<Record<string, number>> {
  const count = async (table: string, ids: number[]) => {
    if (ids.length === 0) return 0;
    const row = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(',')}]::int[]`)})`,
    );
    return row.n;
  };
  let users = 0;
  for (const id of everUsers) {
    const row = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "user" WHERE id = ${id}`,
    );
    users += row.n;
  }
  return {
    issues: await count('issue', everMade.issue),
    agents: await count('ai_agent', everMade.agent),
    cycles: await count('cycle', everMade.cycle),
    schedules: await count('agent_schedule', everMade.schedule),
    webhooks: await count('webhook', everMade.webhook),
    labels: await count('label', everMade.label),
    columns: await count('project_column', everMade.column),
    projects: await count('project', everMade.project),
    teams: await count('team', everMade.team),
    workspaces: await count('workspace', everMade.workspace),
    users,
  };
}

export async function retained() {
  const rig = await one<{ id: number; prefix: string; next_root: number }>(
    sql`SELECT id, prefix, next_root FROM rig WHERE prefix = ${RIG_PREFIX}`,
  );
  if (!rig) throw new Error('the shared synthetic rig is missing: no gated case ran');
  const ledger = await many<{ local_token: string; origin: string; issue_id: number | null }>(
    sql`SELECT local_token, origin, issue_id FROM bead_identity WHERE rig_id = ${rig.id} ORDER BY local_token`,
  );
  return { rig, ledger };
}
