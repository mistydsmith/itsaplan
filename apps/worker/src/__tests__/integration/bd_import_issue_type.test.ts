// PREPARED, NOT RUN (8363.1, Root GO 2026-11-15: no author DB GO; Root holds
// the serial DB slot). The worker's issue-type materialization proof: the
// existing Create seam (createLocalIssueTypeAndRecord +
// createLocalIssueAndRecord, apps/worker/src/import-store.ts) must give a bd
// import its OPERATIONAL kind - the exact source issue_type name in the native
// issue_type table and issue.type_id bound to it. An imported epic must land
// as an epic, never defaulted to the project's first type.
//
// Target: loopback on port 5433, database exactly itsaplan_8364_d2_test, and
// the caller must export ITSAPLAN_8363_1_IMPORT_IDENTITY_PROOF=granted - the
// same proof flag and conventions as the packages/db prepared suites
// (bead-import-target-guard.ts): the flag is checked before any client exists,
// loopback only, BUN_TEST_WORKER_ID refused (this fixture owns its connection
// for Root's single serial slot), one random suffix per run so re-runs never
// collide, and the fixture rows are removed in foreign-key order in afterAll
// (no rig is created here - the kind seam needs no rig).
//
// The suite runs the seam's OWN production client (@repo/db's `db`, built from
// DATABASE_URL): raw reads go through db.execute so the worker package needs
// no direct postgres driver dependency. It asserts the ACTUAL STORE: the
// issue_type rows carry the exact source names, the created issue's type_id is
// the exact-name row, and the counter replay (a second materialize run) reuses
// the row in place - no duplicate type, no moved position, the import record
// re-bound, not re-created.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@repo/db';
import { createLocalIssueTypeAndRecord } from '../../import-store';
import { createLocalIssueAndRecord } from '../../import-store-issue';
import type { CanonicalIssueType } from '../../canonical';

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const PROOF_FLAG = 'ITSAPLAN_8363_1_IMPORT_IDENTITY_PROOF';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// One random suffix per process: re-runs add distinct fixtures, never collide.
const RUN = Math.random().toString(36).slice(2, 10);

function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  // The proof flag gates the suite before any client exists (C1): the flag is
  // checked first, so an accidental env file can never point this fixture at
  // prod - even though the client is the shared production client.
  if (process.env[PROOF_FLAG] !== 'granted') {
    throw new Error(
      `${PROOF_FLAG} must be 'granted' to run this prepared suite; it is held for Root's serial DB slot`,
    );
  }
  if (process.env.BUN_TEST_WORKER_ID !== undefined) {
    throw new Error(
      'refused inside a bun test worker: this fixture owns its connection for the serial slot',
    );
  }
  if (nodeEnv !== 'test') throw new Error('NODE_ENV must be test');
  if (!raw) throw new Error('DATABASE_URL is required');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error('refused: only loopback hosts are allowed');
  if (u.port !== '5433') throw new Error('refused: only port 5433 is allowed');
  if (u.pathname.replace(/^\//, '') !== REQUIRED_DB) {
    throw new Error(`refused: only database ${REQUIRED_DB}`);
  }
  return raw;
}

// The bd reader's export-derived types for the proof board: the exact source
// names, machine-bound - the worker seam must create exactly these rows.
const BD_TYPES: CanonicalIssueType[] = [
  { sourceId: 'epic', name: 'epic' },
  { sourceId: 'feature', name: 'feature' },
  { sourceId: 'task', name: 'task' },
];

let projectId = 0;
let columnId = 0;
let jobId = 0;
let userId: string;
const made = {
  user: false,
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
  column: [] as number[],
  issue: [] as number[],
};

const BASE_TITLE = `8363.1 kind fixture ${RUN}`;

// House pattern (notification-delivery.ts): db.execute(sql`...`) hands back the
// row LIST directly; the worker's own code casts it as unknown as the row
// shape. postgres-js returns row OBJECTS, so each element dereferences as one.
async function rows(sqlTemplate: SQL): Promise<Record<string, unknown>[]> {
  return (await db.execute(sqlTemplate)) as unknown as Record<string, unknown>[];
}

beforeAll(async () => {
  targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
  const [u] = (await rows(
    sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES (${`imp83631k-${RUN}`}, '8363.1 kind fixture operator', ${`imp83631k-${RUN}@example.invalid`}, true)
    RETURNING id`,
  )) as Record<string, unknown>[];
  userId = u.id as string;
  made.user = true;
  const [ws] = await rows(
    sql`INSERT INTO workspace (name) VALUES (${`8363.1 kind ws ${RUN}`}) RETURNING id`,
  );
  made.workspace.push(ws.id as number);
  const [team] = await rows(sql`
    INSERT INTO team (workspace_id, name, slug)
    VALUES (${ws.id}, ${`8363.1 kind team ${RUN}`}, ${`kind-${ws.id}`}) RETURNING id`);
  made.team.push(team.id as number);
  const [proj] = await rows(sql`
    INSERT INTO project (team_id, key, name)
    VALUES (${team.id}, ${`KIND${ws.id}`}, ${`8363.1 kind project ${RUN}`}) RETURNING id`);
  projectId = proj.id as number;
  made.project.push(projectId);
  const [col] = await rows(sql`
    INSERT INTO project_column (project_id, name, position)
    VALUES (${projectId}, '8363.1 kind column', 1) RETURNING id`);
  columnId = col.id as number;
  made.column.push(columnId);
  // An import job row: the seam keys its records on the job. The status column
  // is NOT NULL with a check constraint: the worker's claim path writes
  // 'pending' itself; this fixture job is only the seam's keying scope, never
  // claimed by a worker.
  const [job] = await rows(sql`
    INSERT INTO import_job (project_id, created_by_user_id, source, status)
    VALUES (${projectId}, ${userId}, 'bd', 'pending') RETURNING id`);
  jobId = job.id as number;
});

afterAll(async () => {
  try {
    for (const id of made.issue) await db.execute(sql`DELETE FROM issue WHERE id = ${id}`);
    await db.execute(sql`DELETE FROM import_record WHERE import_job_id = ${jobId}`);
    await db.execute(sql`DELETE FROM import_job WHERE id = ${jobId}`);
    // The materialized types die with the project (project-scoped); the
    // project cascade covers issue_type, but the fixture rows are named to be
    // auditable if a cascade ever regresses.
    await db.execute(
      sql`DELETE FROM issue_type WHERE project_id = ${projectId} AND name IN ('epic', 'feature', 'task')`,
    );
    await db.execute(sql`DELETE FROM project_column WHERE id = ${columnId}`);
    await db.execute(sql`DELETE FROM project WHERE id = ${projectId}`);
    await db.execute(sql`DELETE FROM team WHERE id = ${made.team[0]}`);
    await db.execute(sql`DELETE FROM workspace WHERE id = ${made.workspace[0]}`);
    if (made.user) await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
  } catch {
    // The guards already ran; a cleanup failure here must not mask the
    // failures above - the random suffix keeps the leftovers auditable.
  }
});

describe('the bd import kind seam lands in the ACTUAL store (prepared, Root serial slot)', () => {
  it('materializes the exact source names and binds the issue to its exact-name type row', async () => {
    // The worker's existing seam, fed the bd reader's export-derived types.
    const epicId = await createLocalIssueTypeAndRecord(jobId, 'epic', projectId, BD_TYPES[0]!);
    const featureId = await createLocalIssueTypeAndRecord(
      jobId,
      'feature',
      projectId,
      BD_TYPES[1]!,
    );
    const taskId = await createLocalIssueTypeAndRecord(jobId, 'task', projectId, BD_TYPES[2]!);
    expect(epicId).not.toBe(featureId);
    expect(epicId).not.toBe(taskId);

    // The ACTUAL STORE: the rows carry the exact source names, nothing
    // translated (the readiness mapping epic->epic / feature->task happens
    // later at the ready fact, never at import).
    const typeRows = await rows(sql`
      SELECT id, name FROM issue_type WHERE project_id = ${projectId} AND name IN ('epic', 'feature', 'task')
      ORDER BY name`);
    expect(typeRows).toEqual([
      { id: epicId, name: 'epic' },
      { id: featureId, name: 'feature' },
      { id: taskId, name: 'task' },
    ]);

    // The imported EPIC binds its type_id to the epic row - never the
    // project's first type, never a default.
    const issueId = await createLocalIssueAndRecord(jobId, 'kind-epic-1', 'kind-epic-1', {
      projectId,
      columnId,
      typeId: epicId,
      cycleId: null,
      parentId: null,
      assigneeUserId: null,
      title: `${BASE_TITLE} epic`,
      description: '',
      priority: null,
      startDate: null,
      dueDate: null,
    });
    made.issue.push(issueId);
    const [bound] = await rows(sql`SELECT type_id FROM issue WHERE id = ${issueId}`);
    expect(Number(bound.type_id)).toBe(epicId);

    // A feature issue binds the feature row: distinct source kinds are
    // distinct native kinds in the store.
    const featureIssueId = await createLocalIssueAndRecord(
      jobId,
      'kind-feature-1',
      'kind-feature-1',
      {
        projectId,
        columnId,
        typeId: featureId,
        cycleId: null,
        parentId: null,
        assigneeUserId: null,
        title: `${BASE_TITLE} feature`,
        description: '',
        priority: null,
        startDate: null,
        dueDate: null,
      },
    );
    made.issue.push(featureIssueId);
    const [featureBound] = await rows(sql`SELECT type_id FROM issue WHERE id = ${featureIssueId}`);
    expect(Number(featureBound.type_id)).toBe(featureId);
  });

  it('the counter replay reuses the exact-name row in place: no duplicate, no moved position', async () => {
    // The position before the replay.
    const [before] = await rows(sql`
      SELECT id, position FROM issue_type WHERE project_id = ${projectId} AND name = 'epic'`);
    // A re-run materializes the SAME source type again: the unique
    // (project_id, name) reuse must return the SAME native row and re-bind the
    // import record, not create a second type or shift the counter.
    const again = await createLocalIssueTypeAndRecord(jobId, 'epic', projectId, BD_TYPES[0]!);
    const [after] = await rows(sql`
      SELECT id, position FROM issue_type WHERE project_id = ${projectId} AND name = 'epic'`);
    expect(again).toBe(Number(before.id));
    expect(Number(after.id)).toBe(Number(before.id));
    expect(Number(after.position)).toBe(Number(before.position));
    // Exactly one native epic row exists - the replay never duplicated it.
    const [count] = await rows(sql`
      SELECT count(*)::int AS n FROM issue_type WHERE project_id = ${projectId} AND name = 'epic'`);
    expect(count.n).toBe(1);
    // The import record re-bound in place: one record for the job's 'epic'
    // source type, pointing at the reused row.
    const recs = await rows(sql`
      SELECT local_id FROM import_record
      WHERE import_job_id = ${jobId} AND source_entity_type = 'issue_type' AND source_id = 'epic'`);
    expect(recs).toHaveLength(1);
    expect(Number(recs[0]!.local_id)).toBe(Number(before.id));
  });
});
