import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

// Test-only fixtures for the E3b comment-delete proof, owned by this file pair and by nothing else.
// No provider, no network, no mocked production seam: real rows, the real public deleteComment and the
// pinned R5 owner. guard() runs before any client exists, so nothing connects without Root's serial GO.
export const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const GRANT = 'ITSAPLAN_8364_E3_COMMENT_DELETE';
export const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R5/CONFIG.json';
// The landed migration file itself, seven levels above this directory; its bytes are applied unchanged.
export const MIGRATION = new URL(
  '../../../../../../../packages/db/drizzle/0183_comment_version.sql',
  import.meta.url,
);
export const MARK = 'zz_e3b_delete';

export function guard(): void {
  if (process.env[GRANT] !== 'granted')
    throw new Error(
      `DB held: this suite runs only when ${GRANT}=granted is set on Root's serial GO`,
    );
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('this suite runs serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  // An omitted port connects 5432, so the fallback must be 5432 for this to refuse it.
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
}
guard();
export const { db } = await import('@repo/db');

type Query = ReturnType<typeof sql>;
export const rows = async <T>(query: Query) => (await db.execute(query)) as unknown as T[];
export const one = async <T>(query: Query) => (await rows<T>(query))[0];
export const n = async (query: Query) => (await one<{ n: number }>(query)).n;
// Exact ids for = ANY(...): scalar bound parameters in a typed array, never a JS array bind.
export const textIds = (ids: (number | string)[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${String(id)}`),
    sql`, `,
  )}]::text[]`;

// Every 0183 object by name. WHY: if any pre-exists, the final drop could remove a foreign object.
const OBJECTS_0183 = sql`SELECT
  (to_regclass('public.comment_version') IS NOT NULL)::int
  + (to_regclass('public.comment_version_id_seq') IS NOT NULL)::int
  + (to_regclass('public.comment_version_lookup_idx') IS NOT NULL)::int
  + (SELECT count(*)::int FROM pg_proc WHERE proname = 'comment_version_immutable')
  + (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'comment_version_no_update')
  + (SELECT count(*)::int FROM pg_constraint WHERE starts_with(conname, 'comment_version_')) AS n`;
export const objects0183 = () => n(OBJECTS_0183);

// `owned` flips only after the DDL transaction commits, and back before the first drop, so a refused
// or failed setup drops nothing and a second caller never drops again.
export const ddl = { owned: false };
export async function applyHistoryDdl(): Promise<void> {
  if ((await objects0183()) !== 0)
    throw new Error('refusing: a comment_version object already exists; this run owns none');
  const text = readFileSync(MIGRATION, 'utf8');
  await db.transaction(async (tx) => {
    for (const statement of text.split('--> statement-breakpoint'))
      if (statement.trim()) await tx.execute(sql.raw(statement));
  });
  ddl.owned = true;
}
// Exactly the owned objects, by name, in dependency order; no IF EXISTS and no CASCADE.
export async function dropOwnedDdl(): Promise<string[]> {
  if (!ddl.owned) return [];
  ddl.owned = false;
  const errors: string[] = [];
  for (const drop of [
    'DROP TRIGGER comment_version_no_update ON comment_version',
    'DROP TABLE comment_version',
    'DROP FUNCTION comment_version_immutable()',
  ])
    await db.execute(sql.raw(drop)).catch((e: Error) => errors.push(`${drop}: ${e.message}`));
  return errors;
}

// Exact-id bookkeeping: `made` is what cleanup still owes, `ever` is what the residue check reads back.
const TABLES = ['issue', 'webhook', 'label', 'project_column', 'project', 'team', 'workspace'];
export const ALL = [...TABLES, '"user"'];
const made: Record<string, (number | string)[]> = Object.fromEntries(ALL.map((t) => [t, []]));
export const ever: Record<string, (number | string)[]> = Object.fromEntries(
  [...ALL, 'issue_activity'].map((t) => [t, []]),
);
export const cleanupErrors: string[] = [];
async function makeRow<T extends number | string = number>(table: string, insert: Query) {
  const id = (await one<{ id: T }>(insert)).id;
  made[table].push(id);
  ever[table].push(id);
  return id;
}

// One rig per run. Rigs and ledger rows are immutable, so they stay, with issue_id nulled by cleanup.
export const RIG_PREFIX = `cte3b${randomUUID().replace(/-/g, '')}`;
let rigId: number | null = null;
export const TOKEN_BASE = 40;
export const seq = { token: TOKEN_BASE };

export interface DeleteFixture {
  projectId: number;
  issueId: number;
  rigId: number | null;
  webhookId: number;
  rootId: number;
  childId: number;
  grandchildId: number;
  unrelatedId: number;
  authorIds: { root: string; child: string; grandchild: string };
  actorId: string;
  editorId: string;
}

// A project with members, a size-small label, a law-library label, a comment.deleted webhook, and one
// card with a three-deep comment chain plus an unrelated live comment. A gated card is a rig-scoped
// imported bead (title `token: ...`, bead_id `prefix-token`) the owner can name; `ll` puts the
// law-library label on it with no compliance block anywhere, which the owner refuses.
export async function deleteFixture(tag: string, options: { gated: boolean; ll?: boolean }) {
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${`${MARK} ${tag}`}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${MARK}, ${`${MARK}-${ws}`}) RETURNING id`,
  );
  if (options.gated && rigId === null)
    rigId = await n(sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id AS n`);
  const rig = options.gated ? rigId : null;
  const projectId = await makeRow(
    'project',
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`E3B${ws}`}, ${MARK}, ${rig}) RETURNING id`,
  );
  const columnId = await makeRow(
    'project_column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${projectId}, 'Todo', 1) RETURNING id`,
  );
  const people: Record<string, string> = {};
  for (const role of ['root', 'child', 'grandchild', 'actor', 'editor']) {
    people[role] = await makeRow<string>(
      '"user"',
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${MARK}-${role}-${projectId}`}, ${role}, ${`${role}${projectId}`}, ${`${role}-${projectId}@example.com`}, true) RETURNING id`,
    );
    await db.execute(sql`INSERT INTO project_member (project_id, user_id, role)
        VALUES (${projectId}, ${people[role]}, ${role === 'actor' ? 'owner' : 'member'})`);
  }
  const labels = (
    await rows<{ id: number }>(sql`INSERT INTO label (project_id, name)
        VALUES (${projectId}, 'size-small'), (${projectId}, 'law-library') RETURNING id`)
  ).map((r) => r.id);
  made.label.push(...labels);
  ever.label.push(...labels);
  const webhookId = await makeRow(
    'webhook',
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${projectId}, 'https://example.invalid/hook', 'dummy', '["comment.deleted"]'::jsonb) RETURNING id`,
  );
  const token = rig === null ? null : String(++seq.token);
  const title = `${MARK} ${tag} card`;
  const issueId = await makeRow(
    'issue',
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, description, bead_id)
        VALUES (${projectId}, 1, ${columnId}, ${token === null ? title : `${token}: ${title}`},
                'Plain card prose, no compliance block here.',
                ${token === null ? null : `${RIG_PREFIX}-${token}`}) RETURNING id`,
  );
  if (token !== null)
    await db.execute(sql`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
        VALUES (${rig}, ${token}, 'imported', ${issueId})`);
  for (const labelId of options.ll ? labels : labels.slice(0, 1))
    await db.execute(
      sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${labelId})`,
    );
  const comment = async (body: string, author: string, replyTo: number | null) => {
    const id =
      await n(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body, reply_to_id)
        VALUES (${issueId}, 'comment', ${author}, ${body}, ${replyTo}) RETURNING id AS n`);
    ever.issue_activity.push(id);
    return id;
  };
  const rootId = await comment('root body', people.root, null);
  const childId = await comment('child body', people.child, rootId);
  const grandchildId = await comment('grandchild body', people.grandchild, childId);
  const unrelatedId = await comment('unrelated body', people.actor, null);
  return {
    projectId,
    issueId,
    rigId: rig,
    webhookId,
    rootId,
    childId,
    grandchildId,
    unrelatedId,
    authorIds: { root: people.root, child: people.child, grandchild: people.grandchild },
    actorId: people.actor,
    editorId: people.editor,
  } satisfies DeleteFixture;
}

// Everything one delete could move on this card, read in one query.
export async function board(f: DeleteFixture) {
  return one<Record<string, unknown>>(sql`
    SELECT (SELECT count(*)::int FROM issue WHERE id = ${f.issueId}) AS issue,
      (SELECT count(*)::int FROM bead_identity WHERE issue_id = ${f.issueId}) AS identities,
      (SELECT count(*)::int FROM issue_label WHERE issue_id = ${f.issueId}) AS labels,
      (SELECT string_agg(id || ':' || coalesce(reply_to_id, 0) || ':' || body, '|' ORDER BY id)
        FROM issue_activity WHERE issue_id = ${f.issueId} AND kind = 'comment') AS comments,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${f.issueId} AND kind = 'activity') AS activity,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${f.issueId} AND kind = 'activity' AND action = 'comment_deleted') AS deleted,
      (SELECT count(*)::int FROM notification WHERE project_id = ${f.projectId}) AS notifications,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id = ${f.webhookId}) AS deliveries,
      (SELECT count(*)::int FROM comment_version WHERE issue_id = ${f.issueId}) AS versions`);
}

export const versionRows = (issueId: number) =>
  rows(sql`SELECT comment_id, revision, body, author_user_id, deleted_after FROM comment_version
           WHERE issue_id = ${issueId} ORDER BY comment_id, revision`);
export const version = (
  comment_id: number,
  revision: number,
  body: string,
  by: string,
  gone = true,
) => ({
  comment_id,
  revision,
  body,
  author_user_id: by,
  deleted_after: gone,
});
// The four versions a full chain delete must leave: one per removed row, by that row's own author.
export const chainVersions = (f: DeleteFixture) => [
  version(f.rootId, 1, 'root body', f.authorIds.root),
  version(f.childId, 1, 'child body', f.authorIds.child),
  version(f.grandchildId, 1, 'grandchild body', f.authorIds.grandchild),
];

// A LATE failure on this fixture's own webhook_delivery insert only: a scoped trigger created and dropped
// by its exact nonce name, never global, never IF EXISTS.
export async function withLateDeliveryFailure<T>(webhookId: number, run: () => Promise<T>) {
  const nonce = `cte3b_${Date.now()}`;
  await db.execute(
    sql.raw(`CREATE FUNCTION ${nonce}() RETURNS trigger AS $$
BEGIN
  IF NEW.webhook_id = ${Number(webhookId)} THEN
    RAISE EXCEPTION 'E3B_LATE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`),
  );
  let trigger = false;
  try {
    await db.execute(
      sql.raw(`CREATE TRIGGER ${nonce} AFTER INSERT ON webhook_delivery
FOR EACH ROW EXECUTE FUNCTION ${nonce}()`),
    );
    trigger = true;
    return await run().catch((error: unknown) => error);
  } finally {
    const drops = [`DROP FUNCTION ${nonce}()`];
    if (trigger) drops.unshift(`DROP TRIGGER ${nonce} ON webhook_delivery`);
    for (const drop of drops)
      await db
        .execute(sql.raw(drop))
        .catch((e: Error) => cleanupErrors.push(`${drop}: ${e.message}`));
  }
}

// Exact ids only, every attempt recorded; issue rows take their comments and versions with them.
export async function cleanUp(): Promise<void> {
  for (const table of ALL)
    for (const id of made[table].splice(0))
      await db
        .execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`)
        .catch((e: Error) => cleanupErrors.push(`${table} ${id}: ${e.message}`));
}

// What is left of everything this run ever created, read back by exact id.
export async function residue() {
  const left: Record<string, number> = {};
  for (const table of [...ALL, 'issue_activity'])
    left[table] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id::text = ANY(${textIds(ever[table])})`,
    );
  left.comment_version = await n(
    sql`SELECT count(*)::int AS n FROM comment_version WHERE issue_id::text = ANY(${textIds(ever.issue)})`,
  );
  const ledger = await one<{ n: number; live: number }>(sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE issue_id IS NOT NULL)::int AS live
      FROM bead_identity b JOIN rig r ON r.id = b.rig_id WHERE r.prefix = ${RIG_PREFIX}`);
  return { left, ledger };
}
