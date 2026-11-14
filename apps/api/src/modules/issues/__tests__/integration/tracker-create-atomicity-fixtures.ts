import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

// Synthetic fixtures for the gated create atomicity proof, and nothing else. The proof owns no app mock
// and no exported testing seam: it writes real rows, calls the real public writer with the real pinned
// tracker owner, and reads the board back. DATABASE HELD: without Root's grant flag this file refuses
// before any client exists, and it never resets, truncates, migrates, clones, disables a trigger, or
// deletes a rig or a ledger row.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_D3_CREATE_ATOMICITY';
const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R2/CONFIG.json';
export const MARK = 'zz_a4_d3_atomicity';

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
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
}
void grantAndTarget();

const { db } = await import('@repo/db');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');

export async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(query)) as unknown as T[])[0];
}

export async function many<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

// Root's reviewed owner export and its pin manifest: the real gate config, never a stub.
const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE_NAMES = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];

// Every variable a case sets comes back exactly as it was, so no case erases a config the process
// genuinely had and no case leaks its own onward.
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

// What this run created, by exact id, in two forms: the live bucket cleanup consumes, and an
// append-only record the final residue case can still read after cleanup spliced the buckets away.
const BUCKETS = [
  'issue',
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
export const everMade = Object.fromEntries(BUCKETS.map((b) => [b, [] as number[]])) as Record<
  Bucket,
  number[]
>;
const CLEANUP: [Bucket, string][] = [
  ['issue', 'issue'],
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
// Every fixture project, with the number of issues it should hold once its case has finished. A count
// above the expectation is the signature of a create that committed an issue nobody tracked.
export const fixtureProjects: { id: number; expectedIssues: number }[] = [];

export async function makeRow(bucket: Bucket, insert: ReturnType<typeof sql>): Promise<number> {
  const id = (await one<{ id: number }>(insert)).id;
  made[bucket].push(id);
  everMade[bucket].push(id);
  return id;
}

// One shared synthetic rig for the whole run: its prefix is this process's own, and it is retained
// with the tombstones its gated creates mint under Root's fixture ruling.
export const RIG_PREFIX = `a4d3${crypto.randomUUID().replace(/-/g, '')}`;
let rigId: number | null = null;
async function sharedRig(): Promise<number> {
  if (rigId === null)
    rigId = await makeRow('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rigId;
}

// What the board could have moved, in one query, so a case compares shapes rather than numbers it picked.
export interface BoardCounts {
  seq: number;
  root: number;
  issues: number;
  identities: number;
  labels: number;
  activity: number;
  status: number;
  watchers: number;
  notifications: number;
  runs: number;
  webhooks: number;
  deliveries: number;
}
export async function board(projectId: number, rig: number | null): Promise<BoardCounts> {
  return one<BoardCounts>(sql`
    SELECT (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq,
      (SELECT coalesce(next_root, 0) FROM rig WHERE id = ${rig}) AS root,
      (SELECT count(*)::int FROM issue WHERE project_id = ${projectId}) AS issues,
      (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${rig}) AS identities,
      (SELECT count(*)::int FROM issue_label WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS labels,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS activity,
      (SELECT count(*)::int FROM issue_status WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS status,
      (SELECT count(*)::int FROM issue_watcher WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS watchers,
      (SELECT count(*)::int FROM notification WHERE project_id = ${projectId}) AS notifications,
      (SELECT count(*)::int FROM agent_run WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS runs,
      (SELECT count(*)::int FROM webhook WHERE project_id = ${projectId}) AS webhooks,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS deliveries`);
}

export async function issuesIn(projectId: number): Promise<number> {
  return (
    await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue WHERE project_id = ${projectId}`,
    )
  ).n;
}

export interface CreateFixture {
  projectId: number;
  columnId: number;
  rigId: number | null;
  authorId: string;
  assigneeId: string;
  agentUserId: string;
  sizeLabelId: number;
  featureLabelId: number;
}

// A project with the two labels the owner wants, an author and an assignee who are both project members,
// an internal agent's bot user as a member that reacts to being delegated to, and one webhook subscribed
// to issue.created - so a successful gated create has something to queue on every door it has. The
// agent door queues a run row only; no model, provider or network call is made by this fixture.
export async function createFixture(gated: boolean, expectedIssues = 1): Promise<CreateFixture> {
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${`${MARK} ws`}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${`${MARK} team`}, ${`${MARK}-${ws}`}) RETURNING id`,
  );
  const rig = gated ? await sharedRig() : null;
  const project = await makeRow(
    'project',
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`A4D3${ws}`}, ${`${MARK} project`}, ${rig}) RETURNING id`,
  );
  fixtureProjects.push({ id: project, expectedIssues });
  const column = await makeRow(
    'column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project}, 'Todo', 1) RETURNING id`,
  );
  const people: Record<string, string> = {};
  for (const name of ['author', 'assignee', 'agent']) {
    const user = await one<{ id: string }>(
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${MARK}-${name}-${project}`}, ${name}, ${`${name}${project}`}, ${`${name}-${project}@example.com`}, true) RETURNING id`,
    );
    madeUsers.push(user.id);
    everUsers.push(user.id);
    people[name] = user.id;
  }
  for (const name of ['author', 'assignee', 'agent']) {
    await db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${project}, ${people[name]}, 'member')`,
    );
  }
  // An internal agent whose bot user is the delegate: trigger_on_assign with kind internal is
  // triggerable by any member, so the writer queues one run and nothing else.
  await db.execute(
    sql`INSERT INTO ai_agent (team_id, user_id, username, kind, trigger_on_assign)
        VALUES (${team}, ${people.agent}, ${`agent${project}`}, 'internal', true)`,
  );
  const sizeLabelId = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name) VALUES (${project}, 'size-small') RETURNING id`,
  );
  const featureLabelId = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name, color) VALUES (${project}, ${`feature ${project}`}, '#336699') RETURNING id`,
  );
  await makeRow(
    'webhook',
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${project}, 'https://example.invalid/hook', 'dummy', ${JSON.stringify([
          'issue.created',
          'issue.label_changed',
        ])}::jsonb) RETURNING id`,
  );
  return {
    projectId: project,
    columnId: column,
    rigId: rig,
    authorId: people.author,
    assigneeId: people.assignee,
    agentUserId: people.agent,
    sizeLabelId,
    featureLabelId,
  };
}

// An owned immediate trigger on the notification insert, scoped by the row's own project id. Before
// raising the marker the case asked for, it counts the rows the create should already have written on
// its own transaction and raises a DIFFERENT marker if any is missing - so a pass proves those earlier
// writes were visible to this insert rather than committed afterwards. A legal INSERT-time trigger,
// never a SELECT one, dropped in a finally.
export async function withLateFailure<T>(
  projectId: number,
  markers: { early: string; late: string },
  run: () => Promise<T>,
): Promise<T> {
  const nonce = `u3c4_atomic_${Date.now()}`;
  await db.execute(sql`CREATE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
DECLARE
  labels int; statuses int; watchers int; deliveries int; activities int;
BEGIN
  IF NEW.project_id = ${sql.raw(String(projectId))} THEN
    SELECT count(*) INTO labels FROM issue_label WHERE issue_id = NEW.issue_id;
    SELECT count(*) INTO statuses FROM issue_status WHERE issue_id = NEW.issue_id;
    SELECT count(*) INTO watchers FROM issue_watcher WHERE issue_id = NEW.issue_id;
    SELECT count(*) INTO activities FROM issue_activity WHERE issue_id = NEW.issue_id;
    SELECT count(*) INTO deliveries FROM webhook_delivery
      WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = NEW.project_id);
    IF labels <> 2 OR statuses <> 1 OR watchers < 1 OR activities < 1 OR deliveries <> 1 THEN
      RAISE EXCEPTION '${sql.raw(markers.early)} % % % % %', labels, statuses, watchers, activities, deliveries
        USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION '${sql.raw(markers.late)}' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`);
  try {
    await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} BEFORE INSERT ON notification
FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
    return await run();
  } finally {
    try {
      await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON notification`);
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

// The cause chain a rejected write carries: drizzle wraps the driver error, so the marker rides there.
export function causeChain(error: unknown): string {
  const parts: string[] = [];
  type Link = { message?: unknown; code?: unknown; cause?: unknown } | null;
  for (let link = error as Link; link; link = link.cause as Link) {
    parts.push(String(link.code ?? '') + String(link.message ?? link));
  }
  return parts.join(' | ');
}

// Every delete this run may make goes by exact id, each attempt is recorded, and a failure cannot stop
// the rest - a cleanup that halted halfway would leave owned rows behind and report success.
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

// Exact-id residue for everything this run ever made, read after the cleanups spliced their buckets:
// a row still standing for one of these ids is a leak the case failed to remove.
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
    webhooks: await count('webhook', everMade.webhook),
    labels: await count('label', everMade.label),
    columns: await count('project_column', everMade.column),
    projects: await count('project', everMade.project),
    teams: await count('team', everMade.team),
    workspaces: await count('workspace', everMade.workspace),
    users,
  };
}

// What this run is allowed to keep, read back for the final case: one synthetic rig, the tombstones its
// gated creates minted, and nothing else of ours.
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
