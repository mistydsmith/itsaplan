import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

// Synthetic fixtures for the comment-create proof, and nothing else: real rows, the real public
// writer, the real pinned owner, the board read back. DATABASE HELD: without Root's grant flag this
// file refuses before any client exists; it never resets, truncates, migrates, clones, or deletes a rig or a ledger row.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_D3_COMMENT_CREATE';
const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R4/CONFIG.json';
export const MARK = 'zz_qw3_d3cc';

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

const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE_NAMES = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];

// Each case's gate env comes back exactly as it was, so no case leaks its own onward.
export async function withOwner<T>(run: () => Promise<T>): Promise<T> {
  const prior = GATE_NAMES.map((name) => process.env[name]);
  GATE_NAMES.forEach((name, i) => {
    process.env[name] = [OWNER.python, OWNER.owner, OWNER_CONFIG][i];
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

// What this run created, by exact id: the live buckets cleanup consumes, and the append-only record the residue case reads after cleanup.
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
export const made = Object.fromEntries(BUCKETS.map((b) => [b, []])) as unknown as Record<
  Bucket,
  number[]
>;
export const everMade = Object.fromEntries(BUCKETS.map((b) => [b, []])) as unknown as Record<
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
export const madeUsers: string[] = [];
export const everUsers: string[] = [];
export const cleanupErrors: string[] = [];
// Every fixture project and the issues it should hold once its case finished; more is a refused comment that still committed a row.
export const fixtureProjects: { id: number; expectedIssues: number }[] = [];

export async function makeRow(bucket: Bucket, insert: ReturnType<typeof sql>): Promise<number> {
  const id = (await one<{ id: number }>(insert)).id;
  made[bucket].push(id);
  everMade[bucket].push(id);
  return id;
}

// One shared synthetic rig for the whole run, retained with the tombstones its cards carry.
export const RIG_PREFIX = `q3cc${randomUUID().replace(/-/g, '')}`;
let rigId: number | null = null;
async function sharedRig(): Promise<number> {
  if (rigId === null)
    rigId = await makeRow('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rigId;
}

// The four-part law-library block as the owner's own checks demand it, so a retained comment satisfies the rule.
export const LL_BLOCK = [
  'LAW LIBRARY COMPLIANCE:',
  "(a) SOURCES ARE SETTLED: Misty's source ruling for this card, pasted verbatim.",
  '(b) text source, comment source, act window all verified for the code touched.',
  '(c) no comment rows touched.',
  '(d) byte copy, never retyped.',
].join('\n');

export interface CommentFixture {
  projectId: number;
  columnId: number;
  rigId: number | null;
  authorId: string;
  member2Id: string;
  agentUserId: string;
  sizeLabelId: number;
  llLabelId: number;
}

// A project with an author and one more member, an internal agent whose bot user reacts to being
// mentioned, a comment.created webhook, and the two labels the cases attach; gated=false leaves rig_id null: the ordinary path's control.
export async function commentProject(gated: boolean): Promise<CommentFixture> {
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
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`Q3CC${ws}`}, ${`${MARK} project`}, ${rig}) RETURNING id`,
  );
  fixtureProjects.push({ id: project, expectedIssues: 1 });
  const column = await makeRow(
    'column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project}, 'Todo', 1) RETURNING id`,
  );
  const people: Record<string, string> = {};
  for (const name of ['author', 'member2', 'agent']) {
    const user = await one<{ id: string }>(
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${MARK}-${name}-${project}`}, ${name}, ${`${name}${project}`}, ${`${name}-${project}@example.com`}, true) RETURNING id`,
    );
    madeUsers.push(user.id);
    everUsers.push(user.id);
    people[name] = user.id;
  }
  for (const name of ['author', 'member2', 'agent']) {
    await db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${project}, ${people[name]}, 'member')`,
    );
  }
  // An internal agent whose bot user reacts to being mentioned: kind internal is triggerable by any member, so a mention queues one run and nothing else.
  await db.execute(
    sql`INSERT INTO ai_agent (team_id, user_id, username, kind, trigger_on_mention)
        VALUES (${team}, ${people.agent}, ${`agent${project}`}, 'internal', true)`,
  );
  const sizeLabelId = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name) VALUES (${project}, 'size-small') RETURNING id`,
  );
  const llLabelId = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name) VALUES (${project}, 'law-library') RETURNING id`,
  );
  await makeRow(
    'webhook',
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${project}, 'https://example.invalid/hook', 'dummy', '["comment.created"]'::jsonb) RETURNING id`,
  );
  return {
    projectId: project,
    columnId: column,
    rigId: rig,
    authorId: people.author,
    member2Id: people.member2,
    agentUserId: people.agent,
    sizeLabelId,
    llLabelId,
  };
}

export interface CardFixture {
  issueId: number;
  beadId: string | null;
  title: string;
  localToken: string | null;
  humanCommentId: number;
  agentCommentId: number;
}
let tokenSeq = 40;
// A card with the fixture's labels and its retained member and agent comments; a gated card
// additionally carries the rig's ledger identity, and its stored title begins with that exact
// local token plus a separator — the identity precondition the owner enforces before any rule.
// retainBlock keeps the law-library block in the retained human comment only.
export async function commentCard(
  p: CommentFixture,
  title: string,
  description: string,
  llLabel: boolean,
  retainBlock: boolean,
): Promise<CardFixture> {
  const localToken = p.rigId === null ? null : String(++tokenSeq);
  const cardTitle = localToken === null ? `${RIG_PREFIX} ${title}` : `${localToken}: ${title}`;
  const issueId = await makeRow(
    'issue',
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, description)
        VALUES (${p.projectId}, 1, ${p.columnId}, ${cardTitle}, ${description}) RETURNING id`,
  );
  let beadId: string | null = null;
  if (localToken !== null) {
    beadId = `${RIG_PREFIX}-${localToken}`;
    await db.execute(sql`UPDATE issue SET bead_id = ${beadId} WHERE id = ${issueId}`);
    await db.execute(
      sql`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
          VALUES (${p.rigId}, ${localToken}, 'imported', ${issueId})`,
    );
  }
  for (const labelId of [p.sizeLabelId, ...(llLabel ? [p.llLabelId] : [])]) {
    await db.execute(
      sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${labelId})`,
    );
  }
  // The retained bodies are bound parameters, never raw literals: a note with an apostrophe
  // inside a single-quoted literal breaks the statement before the card is ever seeded.
  const humanBody = retainBlock ? LL_BLOCK : 'the member kept an earlier note here';
  const agentBody = 'the agent kept an earlier note here';
  const humanCommentId = (
    await one<{ id: number }>(
      sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, actor_name, body)
          VALUES (${issueId}, 'comment', ${p.authorId}, 'Member', ${humanBody}) RETURNING id`,
    )
  ).id;
  const agentCommentId = (
    await one<{ id: number }>(
      sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, actor_name, body)
          VALUES (${issueId}, 'comment', ${p.agentUserId}, 'Agent', ${agentBody}) RETURNING id`,
    )
  ).id;
  return { issueId, beadId, title: cardTitle, localToken, humanCommentId, agentCommentId };
}

// What the board could have moved, in one query, so a case compares shapes, not numbers it picked.
export interface BoardCounts {
  seq: number;
  root: number;
  issues: number;
  identities: number;
  updatedAt: Date | null;
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
      (SELECT max(updated_at) FROM issue WHERE project_id = ${projectId}) AS "updatedAt",
      (SELECT count(*)::int FROM issue_label WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS labels,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS activity,
      (SELECT count(*)::int FROM issue_status WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS status,
      (SELECT count(*)::int FROM issue_watcher WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS watchers,
      (SELECT count(*)::int FROM notification WHERE project_id = ${projectId}) AS notifications,
      (SELECT count(*)::int FROM agent_run WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS runs,
      (SELECT count(*)::int FROM webhook WHERE project_id = ${projectId}) AS webhooks,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS deliveries`);
}

// A fixture-owned AFTER INSERT trigger on notification scoped to the case's project: LATE when the
// case's unique body is already visible in the same transaction, EARLY otherwise; the row's issue
// rides a v_issue_id variable (the 42702 lesson); a finally drops it. INSERT-time, not SELECT.
export async function withCommentLateFailure<T>(
  projectId: number,
  body: string,
  markers: { late: string; early: string },
  run: () => Promise<T>,
): Promise<T> {
  const nonce = `w1cc_${Date.now()}`;
  const safeBody = body.replace(/'/g, "''");
  await db.execute(sql`CREATE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
DECLARE
  v_issue_id int;
  v_found int;
BEGIN
  IF NEW.project_id = ${sql.raw(String(projectId))} THEN
    v_issue_id := NEW.issue_id;
    SELECT count(*) INTO v_found FROM issue_activity
      WHERE issue_id = v_issue_id AND kind = 'comment' AND body = '${sql.raw(safeBody)}';
    IF v_found > 0 THEN
      RAISE EXCEPTION '${sql.raw(markers.late)}' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION '${sql.raw(markers.early)}' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`);
  try {
    await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} AFTER INSERT ON notification
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

// Every delete goes by exact id, each attempt is recorded, and a failure cannot stop the rest — a cleanup that halted halfway would leave owned rows behind and report success.
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

// Exact-id residue for everything this run ever made, read after cleanup spliced its buckets: a row still standing for one of these ids is a leak the case failed to remove.
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

// What this run is allowed to keep, read back for the final case: one synthetic rig and the ledger rows its cards carried (issue ids nulled by the cascades), nothing else of ours.
export async function retained() {
  const rig = await one<{ id: number; prefix: string; next_root: number }>(
    sql`SELECT id, prefix, next_root FROM rig WHERE prefix = ${RIG_PREFIX}`,
  );
  if (!rig) throw new Error('the shared synthetic rig is missing: no gated case ran');
  const ledger = await one<{ n: number; orphans: number }>(
    sql`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE issue_id IS NOT NULL)::int AS orphans
        FROM bead_identity WHERE rig_id = ${rig.id}`,
  );
  return { rig, ledger };
}
