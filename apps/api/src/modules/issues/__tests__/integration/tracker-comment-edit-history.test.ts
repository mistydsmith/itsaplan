import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Comment-edit boundary, real rows, pinned R5 owner, no mock. DB HELD without grant; no reset/migrate,
// no rig or ledger delete. 0183 is applied only if none of its objects exist; exactly those dropped.
import { sql } from 'drizzle-orm';
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_E3_COMMENT_EDIT';
// Root's composed owner pin (Sentinel 07a7bde25b): it routes comment_edit.
const OWNER_CONFIG =
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/CONFIG.json';
const MIGRATION = new URL(
  '../../../../../../../packages/db/drizzle/0183_comment_version.sql',
  import.meta.url,
);
const MARK = 'zz_ct_e3ed';
function grantAndTarget(): void {
  if (process.env[GRANT] !== 'granted')
    throw new Error(`DB held: this suite runs only when ${GRANT}=granted is set by Root's DB GO`);
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
}
grantAndTarget();
const { db } = await import('@repo/db');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
const { updateComment } = await import('../../activity');
const { storedVersionBodies, commentOp, ownerCardFacts, liveCommentRows } =
  await import('../../comment-history');
type Query = ReturnType<typeof sql>;
const rows = async <T>(query: Query) => (await db.execute(query)) as unknown as T[];
const one = async <T>(query: Query) => (await rows<T>(query))[0];
const n = async (query: Query) => (await one<{ n: number }>(query)).n;
// Every 0183 object by name. WHY: if one pre-exists, the final drop could hit a foreign object.
const OBJECTS_0183 = sql`SELECT
  (to_regclass('public.comment_version') IS NOT NULL)::int
  + (to_regclass('public.comment_version_id_seq') IS NOT NULL)::int
  + (to_regclass('public.comment_version_lookup_idx') IS NOT NULL)::int
  + (SELECT count(*)::int FROM pg_proc WHERE proname = 'comment_version_immutable')
  + (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'comment_version_no_update')
  + (SELECT count(*)::int FROM pg_constraint WHERE starts_with(conname, 'comment_version_')) AS n`;
// Exact text ids for = ANY(...): scalar bound parameters in a typed array, never a JS array bind.
const textIds = (ids: (number | string)[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${String(id)}`),
    sql`, `,
  )}]::text[]`;
const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE = {
  [TRACKER_GATE_ENV.python]: OWNER.python,
  [TRACKER_GATE_ENV.owner]: OWNER.owner,
  [TRACKER_GATE_ENV.manifest]: OWNER_CONFIG,
};
async function withOwner<T>(run: () => Promise<T>): Promise<T> {
  const prior = Object.keys(GATE).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, GATE);
  try {
    return await run();
  } finally {
    for (const [name, value] of prior)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}
const TABLES = ['issue', 'webhook', 'label', 'project_column', 'project', 'team', 'workspace'];
const ALL = [...TABLES, '"user"'];
const made: Record<string, (number | string)[]> = Object.fromEntries(ALL.map((t) => [t, []]));
const ever: Record<string, (number | string)[]> = Object.fromEntries(ALL.map((t) => [t, []]));
const cleanupErrors: string[] = [];
async function makeRow<T extends number | string = number>(table: string, insert: Query) {
  const id = (await one<{ id: T }>(insert)).id;
  made[table].push(id);
  ever[table].push(id);
  return id;
}
const RIG_PREFIX = `cte3${randomUUID().replace(/-/g, '')}`;
let rigId: number | null = null;
const LL_BLOCK = [
  'LAW LIBRARY COMPLIANCE:',
  "(a) SOURCES ARE SETTLED: Misty's source ruling for this card, pasted verbatim.",
  '(b) text source, comment source, act window all verified for the code touched.',
  '(c) no comment rows touched.',
  '(d) byte copy, never retyped.',
].join('\n');
const AGENT_BODY = 'the agent kept an earlier note here';
const PLAIN_BODY = 'the author kept an earlier note here';
const PEOPLE = ['author', 'editor', 'member2', 'agent', 'oagent'] as const;
type Ids = { projectId: number; columnId: number; rigId: number | null; labels: number[] };
type P = Ids & Record<(typeof PEOPLE)[number], string>;
// Author, owner-editor, member2, internal agent, external agent only the author may trigger.
async function project(gated: boolean): Promise<P> {
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${MARK}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${MARK}, ${`${MARK}-${ws}`}) RETURNING id`,
  );
  if (gated && rigId === null)
    rigId = await n(sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id AS n`);
  const rig = gated ? rigId : null;
  const projectId = await makeRow(
    'project',
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`CTE${ws}`}, ${MARK}, ${rig}) RETURNING id`,
  );
  const columnId = await makeRow(
    'project_column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${projectId}, 'Todo', 1) RETURNING id`,
  );
  const people = {} as Record<(typeof PEOPLE)[number], string>;
  for (const name of PEOPLE) {
    people[name] = await makeRow<string>(
      '"user"',
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${MARK}-${name}-${projectId}`}, ${name}, ${`${name}${projectId}`}, ${`${name}-${projectId}@example.com`}, true) RETURNING id`,
    );
    await db.execute(sql`INSERT INTO project_member (project_id, user_id, role)
        VALUES (${projectId}, ${people[name]}, ${name === 'editor' ? 'owner' : 'member'})`);
  }
  await db.execute(sql`INSERT INTO ai_agent (team_id, user_id, username, kind, trigger_on_mention)
      VALUES (${team}, ${people.agent}, ${`agent${projectId}`}, 'internal', true)`);
  await db.execute(sql`INSERT INTO ai_agent
      (team_id, user_id, username, kind, trigger_on_mention, runner_scope, owner_user_id)
      VALUES (${team}, ${people.oagent}, ${`oagent${projectId}`}, 'external', true, 'owner', ${people.author})`);
  const labels = (
    await rows<{ id: number }>(sql`INSERT INTO label (project_id, name)
        VALUES (${projectId}, 'size-small'), (${projectId}, 'law-library') RETURNING id`)
  ).map((r) => r.id);
  made.label.push(...labels);
  ever.label.push(...labels);
  await makeRow(
    'webhook',
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${projectId}, 'https://example.invalid/hook', 'dummy', '["comment.updated"]'::jsonb) RETURNING id`,
  );
  return { projectId, columnId, rigId: rig, labels, ...people };
}
let tokenSeq = 70;
let cardSeq = 0;
async function card(p: P, title: string, ll: boolean, block: boolean) {
  const token = p.rigId === null ? null : String(++tokenSeq);
  const issueId = await makeRow(
    'issue',
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, description, bead_id)
        VALUES (${p.projectId}, ${++cardSeq}, ${p.columnId}, ${token === null ? title : `${token}: ${title}`},
                'Plain card prose, no compliance block here.',
                ${token === null ? null : `${RIG_PREFIX}-${token}`}) RETURNING id`,
  );
  if (token !== null)
    await db.execute(sql`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
        VALUES (${p.rigId}, ${token}, 'imported', ${issueId})`);
  for (const labelId of ll ? p.labels : p.labels.slice(0, 1))
    await db.execute(
      sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${labelId})`,
    );
  const comment = (actor: string, body: string) =>
    n(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body)
          VALUES (${issueId}, 'comment', ${actor}, ${body}) RETURNING id AS n`);
  const humanId = await comment(p.author, block ? LL_BLOCK : PLAIN_BODY);
  const agentId = await comment(p.agent, AGENT_BODY);
  return { issueId, humanId, agentId };
}
async function board(projectId: number, rig: number | null) {
  const issues = sql`(SELECT id FROM issue WHERE project_id = ${projectId})`;
  return one<Record<string, unknown>>(sql`
    SELECT (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq,
      (SELECT coalesce(next_root, 0) FROM rig WHERE id = ${rig}) AS root,
      (SELECT count(*)::int FROM issue WHERE project_id = ${projectId}) AS issues,
      (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${rig}) AS identities,
      (SELECT max(updated_at) FROM issue WHERE project_id = ${projectId}) AS "updatedAt",
      (SELECT count(*)::int FROM issue_label WHERE issue_id IN ${issues}) AS labels,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id IN ${issues}) AS activity,
      (SELECT string_agg(body, '|' ORDER BY id) FROM issue_activity WHERE issue_id IN ${issues} AND kind = 'comment') AS bodies,
      (SELECT count(*)::int FROM issue_status WHERE issue_id IN ${issues}) AS status,
      (SELECT count(*)::int FROM issue_watcher WHERE issue_id IN ${issues}) AS watchers,
      (SELECT count(*)::int FROM notification WHERE project_id = ${projectId}) AS notifications,
      (SELECT count(*)::int FROM agent_run WHERE issue_id IN ${issues}) AS runs,
      (SELECT count(*)::int FROM webhook WHERE project_id = ${projectId}) AS webhooks,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS deliveries,
      (SELECT count(*)::int FROM comment_version WHERE issue_id IN ${issues}) AS versions`);
}
const versions = (issueId: number) =>
  rows(sql`SELECT comment_id, revision, body, author_user_id, deleted_after FROM comment_version
           WHERE issue_id = ${issueId} ORDER BY comment_id, revision`);
function version(comment_id: number, revision: number, body: string, by: string) {
  return { comment_id, revision, body, author_user_id: by, deleted_after: false };
}
const moved = (b: Record<string, unknown>, delta: Record<string, number>, extra = {}) => ({
  ...b,
  ...Object.fromEntries(Object.entries(delta).map(([k, d]) => [k, Number(b[k]) + d])),
  ...extra,
});
async function withLateFailure<T>(projectId: number, body: string, run: () => Promise<T>) {
  const nonce = `cte3_${Date.now()}`;
  await db.execute(sql`CREATE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
DECLARE v_issue_id int; v_found int;
BEGIN
  IF NEW.project_id = ${sql.raw(String(projectId))} THEN
    v_issue_id := NEW.issue_id;
    SELECT count(*) INTO v_found FROM issue_activity
      WHERE issue_id = v_issue_id AND kind = 'comment' AND body = '${sql.raw(body.replace(/'/g, "''"))}';
    IF v_found > 0 THEN RAISE EXCEPTION 'E3_LATE' USING ERRCODE = 'P0001'; END IF;
    RAISE EXCEPTION 'E3_EARLY' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`);
  let trigger = false;
  try {
    await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} AFTER INSERT ON notification
FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
    trigger = true;
    return await run().catch((error: unknown) => error);
  } finally {
    const drops = [`DROP FUNCTION ${nonce}()`];
    if (trigger) drops.unshift(`DROP TRIGGER ${nonce} ON notification`);
    for (const drop of drops)
      await db
        .execute(sql.raw(drop))
        .catch((e: Error) => cleanupErrors.push(`${drop}: ${e.message}`));
  }
}
function causeChain(error: unknown): string {
  const parts: string[] = [];
  type Link = { message?: unknown; code?: unknown; cause?: unknown } | null;
  for (let link = error as Link; link; link = link.cause as Link)
    parts.push(String(link.code ?? '') + String(link.message ?? link));
  return parts.join(' | ');
}
// A named agent whose lane the rule manifest does not list refuses before the owner runs.
const unroutedUnchanged = (p: P, run: () => Promise<unknown>) =>
  refusedWith('lane-unrouted', p, run, 'lane-routing');
const refusedUnchanged = (p: P, run: () => Promise<unknown>, ...phrases: string[]) =>
  refusedWith('tracker-rules-violation', p, run, ...phrases);
async function refusedWith(code: string, p: P, run: () => Promise<unknown>, ...phrases: string[]) {
  const before = await board(p.projectId, p.rigId);
  const error = await withOwner(run).then(
    () => 'allowed',
    (e: Error) => e,
  );
  expect(error).toMatchObject({ status: 409, code });
  for (const phrase of phrases) expect((error as Error).message).toContain(phrase);
  expect(await board(p.projectId, p.rigId)).toEqual(before);
}
async function cleanUp(): Promise<void> {
  for (const table of ALL)
    for (const id of made[table].splice(0))
      await db
        .execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`)
        .catch((e: Error) => cleanupErrors.push(`${table} ${id}: ${e.message}`));
}
describe('the comment-edit history boundary', () => {
  // Registered before hooks run; drops only DDL this run committed (refused/failed setup: no-op).
  let owned = false;
  afterAll(async () => {
    if (!owned) return;
    const errors: string[] = [];
    for (const drop of [
      'DROP TRIGGER comment_version_no_update ON comment_version',
      'DROP TABLE comment_version',
      'DROP FUNCTION comment_version_immutable()',
    ])
      await db.execute(sql.raw(drop)).catch((e: Error) => errors.push(`${drop}: ${e.message}`));
    const left = await n(OBJECTS_0183);
    if (errors.length > 0 || left !== 0)
      throw new Error(`fixture DDL not fully dropped (${left} left): ${errors.join('; ')}`);
  });
  beforeAll(async () => {
    if ((await n(OBJECTS_0183)) !== 0)
      throw new Error('refusing: a comment_version object already exists; this run owns none');
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint'))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
    owned = true;
  });
  afterEach(cleanUp);
  it('stores the first and second versions with the original author, and lets plain progress through on a block only a version retains', async () => {
    const p = await project(true);
    const c = await card(p, 'Version chain', true, true);
    const b0 = await board(p.projectId, p.rigId);
    // Edit 1 replaces the only live copy of the block; the previous live list still carries it.
    await withOwner(() => updateComment(c.humanId, 'progress: step one', p.author, p.projectId));
    const b1 = await board(p.projectId, p.rigId);
    const bodies1 = `progress: step one|${AGENT_BODY}`;
    expect(b1).toEqual(moved(b0, { activity: 1, deliveries: 1, versions: 1 }, { bodies: bodies1 }));
    // Edit 2 (owner) is judged on this state: block only in the version, each live body once per side.
    const body = `progress: step two @member2${p.projectId}`;
    const stored = await storedVersionBodies(db, c.issueId);
    expect(stored).toEqual([LL_BLOCK]);
    const op = commentOp({
      opName: 'comment_edit',
      facts: await ownerCardFacts(db, c.issueId, p.rigId as number),
      versions: stored,
      liveBefore: await liveCommentRows(db, c.issueId),
      superseded: ['progress: step one'],
      targetId: c.humanId,
      editBody: body,
      actorUserId: p.editor, // The actor updateComment authenticates (8429).
    }) as Record<string, { comments: string[] }>;
    expect(op.previous_state.comments).toEqual([LL_BLOCK, 'progress: step one', AGENT_BODY]);
    expect(op.proposed_state.comments).toEqual([LL_BLOCK, 'progress: step one', body, AGENT_BODY]);
    const written = await withOwner(() => updateComment(c.humanId, body, p.editor, p.projectId));
    expect(written.body).toBe(body);
    expect(await board(p.projectId, p.rigId)).toEqual(
      moved(
        b1,
        { activity: 1, deliveries: 1, notifications: 1, watchers: 1, versions: 1 },
        { bodies: `${body}|${AGENT_BODY}` },
      ),
    );
    // Versions: superseded bodies, by the comment's author; the editor is only the activity actor.
    expect(await versions(c.issueId)).toEqual([
      version(c.humanId, 1, LL_BLOCK, p.author),
      version(c.humanId, 2, 'progress: step one', p.author),
    ]);
    const actors = await rows<{ actor_user_id: string }>(
      sql`SELECT actor_user_id FROM issue_activity WHERE issue_id = ${c.issueId} AND kind = 'activity' ORDER BY id`,
    );
    expect(actors.map((r) => r.actor_user_id)).toEqual([p.author, p.editor]);
  }, 120_000);
  it("moves nothing on a gated refusal (no block anywhere; the author's agent reached) or a late failure", async () => {
    const p = await project(true);
    const bare = await card(p, 'No block', true, false);
    await refusedUnchanged(
      p,
      () => updateComment(bare.humanId, 'progress: drafted section 3', p.author, p.projectId),
      'law-library-compliance',
    );
    // A named agent is a routing target whoever edits, and the fixture agents hold no manifest lane.
    const c = await card(p, 'Agent reach', true, true);
    await unroutedUnchanged(p, () =>
      updateComment(c.humanId, `please look @oagent${p.projectId}`, p.editor, p.projectId),
    );
    await unroutedUnchanged(p, () =>
      updateComment(c.humanId, `agent asks @oagent${p.projectId}`, p.agent, p.projectId),
    );
    // The same holds on an agent's own comment, where the edit reaches nobody and queues no run.
    await unroutedUnchanged(p, () =>
      updateComment(c.agentId, `${AGENT_BODY} @agent${p.projectId}`, p.editor, p.projectId),
    );
    // A late failure rolls history, body, activity, webhook, notification and run back together.
    const late = await card(p, 'Late marker', true, true);
    const before = await board(p.projectId, p.rigId);
    const body = `late edit ${randomUUID()} @member2${p.projectId}`;
    const error = await withLateFailure(p.projectId, body, () =>
      withOwner(() => updateComment(late.humanId, body, p.author, p.projectId)),
    );
    expect(causeChain(error)).toContain('E3_LATE');
    expect(causeChain(error)).not.toContain('E3_EARLY');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);
  it('keeps the ordinary contract: history and body commit together, effects and runs follow the commit', async () => {
    const p = await project(false);
    const c = await card(p, 'Ordinary edit', false, false);
    const before = await board(p.projectId, null);
    const body = `ordinary edit ${randomUUID()} @member2${p.projectId}`;
    const error = await withLateFailure(p.projectId, body, () =>
      updateComment(c.humanId, body, p.author, p.projectId),
    );
    // LATE after the commit: version, body, activity and delivery stay; only the notification is gone.
    expect(causeChain(error)).toContain('E3_LATE');
    expect(await board(p.projectId, null)).toEqual(
      moved(
        before,
        { activity: 1, deliveries: 1, watchers: 1, versions: 1 },
        { bodies: `${body}|${AGENT_BODY}` },
      ),
    );
    expect(await versions(c.issueId)).toEqual([version(c.humanId, 1, PLAIN_BODY, p.author)]);
    // Runs queue on the comment's author (who may trigger oagent), not the editing owner: one run.
    await updateComment(c.humanId, `over to @oagent${p.projectId}`, p.editor, p.projectId);
    const mid = await board(p.projectId, null);
    expect(mid.runs).toBe(Number(before.runs) + 1);
    // An agent-authored comment never queues a run, though the owner alone would have triggered it.
    await updateComment(c.agentId, `${AGENT_BODY} @agent${p.projectId}`, p.editor, p.projectId);
    const after = await board(p.projectId, null);
    expect(after.runs).toBe(mid.runs);
    expect(after.versions).toBe(3);
  }, 120_000);
  it('leaves nothing behind but the shared rig and its ledger tombstones', async () => {
    expect(cleanupErrors).toEqual([]);
    const left: Record<string, number> = {};
    for (const table of ALL)
      left[table] = await n(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id::text = ANY(${textIds(ever[table])})`,
      );
    expect(left).toEqual(Object.fromEntries(ALL.map((t) => [t, 0])));
    expect(await n(sql`SELECT count(*)::int AS n FROM comment_version`)).toBe(0);
    const ledger = await one<{ n: number; live: number }>(sql`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE issue_id IS NOT NULL)::int AS live
        FROM bead_identity b JOIN rig r ON r.id = b.rig_id WHERE r.prefix = ${RIG_PREFIX}`);
    expect(ledger).toEqual({ n: tokenSeq - 70, live: 0 });
  }, 120_000);
});
