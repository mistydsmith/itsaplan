// PREPARED, NOT RUN (8363.1, Root handoff 2026-11-15: "Root serial DB slot
// only"): the whole-pipeline D2 witness. The REAL BdReader (injected synthetic
// export - no bd call, the runner throws on every other command), the REAL
// native store (loopback 5433, the D2 test database) and the REAL source
// stamp hooks drive the EXISTING phases - runDiscover, runCreate (issue
// chunk, then the empty chunk committing the retained rows), runLink (twice)
// - on a dedicated job/project/rig, proving on real bytes: every issue_type
// materializes NATIVELY (task, bug, feature, epic, decision; issue.type_id
// bound), the closed card rides 'Closed', the daughter's explicit parent-child
// edge is her native parent (Root P0 2026-11-15: actual edges authoritative,
// no decimal inference) alongside one 'blocks' link and one 'relates', comments land verbatim, the exact bead
// ids stamp issues AND ledger (origin imported) with the rig counter above
// the highest root, the retained artifact commits with its digest (the
// memory's EXACT key/value raw, verbatim notes, the UNKNOWN field source_app),
// and a REPEATED job chunk (end-of-chunk replay AND a restart from the empty
// create cursor {}) adds NO duplicates - unchanged digest.
// The D2 grant guard gates the suite before any client exists:
// ITSAPLAN_8363_1_PIPELINE_D2_PROOF=granted, loopback only, port 5433,
// database itsaplan_8364_d2_test, NODE_ENV=test, no bun test worker. Without
// the grant this file throws in beforeAll - the lane's ordinary suite run
// never touches a database. The rig and its five imported ledger rows are
// IMMUTABLE: cleanup deletes every fixture row by exact id (parameterized IN
// over the captured down-ids) and NEVER deletes the rig or ledger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@repo/db';
import { BdReader } from '../../bd-adapter';
import { advanceImportJobPhase } from '../../import-store';
import type { ClaimedImportJob } from '../../import-store';
import { runCreate, runLink } from '../../import-worker';
import { runDiscover } from '../../import-worker-discover';
import { retainedArtifactOf } from '../../import-retained';
import type { CanonicalRetainedRow } from '../../reader';
import { asObject, buildWitnessBoard, type WitnessBoard } from './bd-pipeline-witness-fixture';

const RUN = Math.random().toString(36).slice(2, 10);
const PROOF_FLAG = 'ITSAPLAN_8363_1_PIPELINE_D2_PROOF';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  if (process.env[PROOF_FLAG] !== 'granted')
    throw new Error(
      `${PROOF_FLAG}=granted is required to run this prepared suite; it is held for Root's serial DB slot`,
    );
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error(
      'this suite runs outside bun test workers (BUN_TEST_WORKER_ID set); use a single serial process',
    );
  if (nodeEnv !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  const port = url.port || '5432';
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(`refusing non-loopback host ${url.hostname}`);
  if (port !== '5433') throw new Error(`refusing port ${port}; this suite uses 5433`);
  if (name !== 'itsaplan_8364_d2_test')
    throw new Error(`refusing database ${name}; this suite uses itsaplan_8364_d2_test`);
  return raw;
}

type Row = Record<string, unknown>;

describe('8363.1 bd whole-pipeline D2 witness (prepared, not run)', () => {
  let board: WitnessBoard;
  let reader: BdReader;
  let rigId = 0;
  let wsId = 0;
  let teamId = 0;
  let projectId = 0;
  let jobId = 0;
  let userId = '';
  const issueIds = new Map<string, number>();
  const made = { user: false, ws: false, team: false, project: false, job: false };

  // Re-read the job row the way the worker's claim path hands it to a phase.
  async function jobOf(): Promise<ClaimedImportJob> {
    const [r] = await db.execute(
      sql`SELECT phase, status, config, cursor, attempts FROM import_job WHERE id = ${jobId}`,
    );
    return {
      id: jobId,
      projectId,
      source: 'bd',
      phase: String(r.phase),
      status: String(r.status),
      config: asObject(r.config),
      cursor: asObject(r.cursor),
      attempts: Number(r.attempts),
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
    };
  }

  async function importRecordCounts(): Promise<Record<string, number>> {
    const rows = (await db.execute(sql`
      SELECT source_entity_type AS entity, count(*)::int AS n
      FROM import_record WHERE import_job_id = ${jobId}
      GROUP BY source_entity_type`)) as unknown as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.entity), Number(r.n)]));
  }

  async function readArtifact(): Promise<{ digest: string; rows: CanonicalRetainedRow[] }> {
    const [r] = await db.execute(
      sql`SELECT config -> 'retainedArtifact' AS artifact FROM import_job WHERE id = ${jobId}`,
    );
    const artifact = r.artifact as { digest: string; rows: CanonicalRetainedRow[] } | null;
    expect(artifact).not.toBeNull();
    return artifact!;
  }

  async function pipelineCounts(): Promise<{
    issues: number;
    comments: number;
    types: number;
    ledger: number;
    links: number;
  }> {
    const [a] = await db.execute(
      sql`SELECT count(*)::int AS n FROM issue WHERE project_id = ${projectId}`,
    );
    const [b] = await db.execute(sql`
      SELECT count(*)::int AS n FROM issue_activity act JOIN issue i ON i.id = act.issue_id
      WHERE i.project_id = ${projectId} AND act.kind = 'comment'`);
    const [c] = await db.execute(
      sql`SELECT count(*)::int AS n FROM issue_type WHERE project_id = ${projectId}`,
    );
    const [d] = await db.execute(
      sql`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`,
    );
    const [e] = await db.execute(sql`
      SELECT count(*)::int AS n FROM issue_link l JOIN issue i ON i.id = l.source_issue_id
      WHERE i.project_id = ${projectId}`);
    return {
      issues: Number(a.n),
      comments: Number(b.n),
      types: Number(c.n),
      ledger: Number(d.n),
      links: Number(e.n),
    };
  }

  beforeAll(async () => {
    targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
    const [u] = await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${`imp83631pl-${RUN}`}, '8363.1 pipeline witness operator', ${`imp83631pl-${RUN}@example.invalid`}, true)
      RETURNING id`);
    userId = String(u.id);
    made.user = true;
    board = buildWitnessBoard(RUN);
    const [rig] = await db.execute(
      sql`INSERT INTO rig (prefix, next_root) VALUES (${board.prefix}, 1) RETURNING id`,
    );
    rigId = Number(rig.id);
    const [ws] = await db.execute(
      sql`INSERT INTO workspace (name) VALUES (${`8363.1 pipeline ws ${RUN}`}) RETURNING id`,
    );
    wsId = Number(ws.id);
    made.ws = true;
    const [team] = await db.execute(sql`
      INSERT INTO team (workspace_id, name, slug) VALUES (${wsId}, ${`8363.1 pipeline team ${RUN}`}, ${`plw-${RUN}`}) RETURNING id`);
    teamId = Number(team.id);
    made.team = true;
    const [proj] = await db.execute(sql`
      INSERT INTO project (team_id, key, name, rig_id)
      VALUES (${teamId}, ${`plw${RUN}`}, ${`8363.1 pipeline project ${RUN}`}, ${rigId}) RETURNING id`);
    projectId = Number(proj.id);
    made.project = true;
    await db.execute(
      sql`INSERT INTO project_column (project_id, name, position) VALUES (${projectId}, 'Backlog', 1)`,
    );
    const [job] = await db.execute(sql`
      INSERT INTO import_job (project_id, created_by_user_id, source, phase, status)
      VALUES (${projectId}, ${userId}, 'bd', 'discover', 'paused') RETURNING id`);
    jobId = Number(job.id);
    made.job = true;
    // The REAL reader over the injected export; the runner records every command.
    reader = new BdReader(
      {
        boardPath: board.boardPath,
        maxDepth: Number.POSITIVE_INFINITY,
        sourceName: 'witness board',
      },
      board.run,
    );
  });

  test('discover: the whole board in two subphases, then the create phase', async () => {
    await runDiscover(await jobOf(), reader);
    const [meta] = await db.execute(sql`SELECT cursor FROM import_job WHERE id = ${jobId}`);
    expect(asObject(meta.cursor).subphase).toBe('issues');
    const afterMeta = await importRecordCounts();
    // GROUP BY omits zero-count groups: no issue records yet (no issue:0).
    expect(afterMeta).toEqual({ state: 5, label: 1, issue_type: 5 });
    await runDiscover(await jobOf(), reader);
    const [ph] = await db.execute(sql`SELECT phase FROM import_job WHERE id = ${jobId}`);
    expect(String(ph.phase)).toBe('create');
    const afterIssues = await importRecordCounts();
    expect(afterIssues.issue).toBe(5);
    // ONE export read for the whole tick (single-flight snapshot): no crawl,
    // no other command of any shape.
    expect(board.calls).toEqual([['bd', 'export', '--all']]);
  });

  test('create: native kinds, exact ids and ledger, comments, and the retained artifact', async () => {
    await runCreate(await jobOf(), reader); // chunk 1: the five issues
    await runCreate(await jobOf(), reader); // chunk 2: empty -> retained rows + advance
    const cid = (t: string) => `${board.prefix}-${t}`;
    const issues = (await db.execute(sql`
      SELECT i.id::int AS id, i.bead_id, i.title, i.parent_id::int AS parent,
             it.name AS type_name, pc.name AS state_name, pc.state_type AS state_category
      FROM issue i
      JOIN issue_type it ON it.id = i.type_id
      JOIN project_column pc ON pc.id = i.column_id
      WHERE i.project_id = ${projectId}
      ORDER BY i.bead_id`)) as unknown as Row[];
    expect(issues).toHaveLength(5);
    for (const row of issues) issueIds.set(String(row.bead_id), Number(row.id));
    const byBead = new Map(issues.map((i) => [String(i.bead_id), i]));
    // Every issue_type materializes natively and binds exactly.
    expect(byBead.get(cid('7100'))!.type_name).toBe('task');
    expect(byBead.get(cid('7100.1'))!.type_name).toBe('bug');
    expect(byBead.get(cid('7101'))!.type_name).toBe('feature');
    expect(byBead.get(cid('7102'))!.type_name).toBe('epic');
    expect(byBead.get(cid('7103'))!.type_name).toBe('decision');
    const types = (await db.execute(
      sql`SELECT name FROM issue_type WHERE project_id = ${projectId} ORDER BY name`,
    )) as unknown as Row[];
    expect(types.map((t) => String(t.name))).toEqual([
      'bug',
      'decision',
      'epic',
      'feature',
      'task',
    ]);
    // The states preserve the source status names (no silent folding).
    expect(byBead.get(cid('7100'))!.state_name).toBe('Open');
    expect(byBead.get(cid('7100'))!.state_category).toBe('unstarted');
    expect(byBead.get(cid('7100.1'))!.state_name).toBe('Blocked');
    expect(byBead.get(cid('7101'))!.state_name).toBe('Closed');
    expect(byBead.get(cid('7101'))!.state_category).toBe('completed');
    expect(byBead.get(cid('7102'))!.state_name).toBe('Queued');
    expect(byBead.get(cid('7103'))!.state_name).toBe('Review');
    expect(byBead.get(cid('7100'))!.title).toBe('7100: witness root card');
    expect(byBead.get(cid('7100.1'))!.title).toBe('7100.1: blocked daughter');
    expect(byBead.get(cid('7101'))!.title).toBe('7101: shipped feature');
    expect(byBead.get(cid('7102'))!.title).toBe('7102: queued epic');
    expect(byBead.get(cid('7103'))!.title).toBe('7103: in review');
    expect(byBead.get(cid('7100.1'))!.parent).toBe(byBead.get(cid('7100'))!.id);
    // The ledger: the exact five tokens, origin imported, zero tombstones.
    const ledger = (await db.execute(sql`
      SELECT local_token, issue_id::int AS issue_id, origin FROM bead_identity
      WHERE rig_id = ${rigId} ORDER BY local_token`)) as unknown as Row[];
    const imported = (t: string) => ({
      local_token: t,
      issue_id: issueIds.get(cid(t)),
      origin: 'imported',
    });
    expect(ledger).toEqual(['7100', '7100.1', '7101', '7102', '7103'].map(imported));
    // The rig counter advanced above the highest imported root.
    const [rig] = await db.execute(
      sql`SELECT next_root::int AS next_root FROM rig WHERE id = ${rigId}`,
    );
    expect(Number(rig.next_root)).toBe(7104);
    // The comments land with their exact bodies and bd author tokens.
    const comments = (await db.execute(sql`
      SELECT act.body, act.actor_name FROM issue_activity act
      JOIN issue i ON i.id = act.issue_id
      WHERE i.project_id = ${projectId} AND act.kind = 'comment'
      ORDER BY act.created_at, act.body`)) as unknown as Row[];
    expect(comments.map((c) => String(c.body))).toEqual([
      'first comment body',
      'second comment body',
      'third comment body',
    ]);
    expect(comments.map((c) => String(c.actor_name)).sort()).toEqual([
      'codex_admin',
      'qwen',
      'qwen',
    ]);
    // The retained artifact: digest cross-checked with the worker's own
    // function, the memory's EXACT raw, verbatim notes, the UNKNOWN field.
    const artifact = await readArtifact();
    const fresh = retainedArtifactOf(await reader.listRetainedRows());
    expect(artifact.digest).toBe(fresh.digest);
    expect(artifact.rows).toHaveLength(6);
    const memRow = artifact.rows.find((r) => r.sourceId === 'memory:lane-preference')!;
    expect(memRow.unmapped.find((f) => f.field === 'value')!.value).toBe(board.memory.value);
    expect(memRow.unmapped.find((f) => f.field === 'raw')!.value).toBe(
      JSON.stringify({ _type: 'memory', key: board.memory.key, value: board.memory.value }),
    );
    const rootRow = artifact.rows.find((r) => r.sourceId === cid('7100'))!;
    expect(rootRow.originalTitle).toBe('witness root card');
    expect(rootRow.alreadyPrefixed).toBe(false);
    expect(rootRow.unmapped.find((f) => f.field === 'notes')!.value).toBe('root notes verbatim');
    const daughterRow = artifact.rows.find((r) => r.sourceId === cid('7100.1'))!;
    expect(daughterRow.unmapped.find((f) => f.field === 'notes')!.value).toBe(
      'daughter notes verbatim',
    );
    expect(rootRow.unmapped.find((f) => f.field === 'raw')!.value).toContain(
      '"source_app":"witness-app"',
    );
    expect(board.calls).toHaveLength(1);
  });

  test('link: the dependency edges land exactly once each', async () => {
    await runLink(await jobOf(), reader);
    await runLink(await jobOf(), reader);
    const [ph] = await db.execute(sql`SELECT phase FROM import_job WHERE id = ${jobId}`);
    expect(String(ph.phase)).toBe('rewrite');
    const cid = (t: string) => `${board.prefix}-${t}`;
    const links = (await db.execute(sql`
      SELECT s.bead_id AS source, t.bead_id AS target, l.kind
      FROM issue_link l
      JOIN issue s ON s.id = l.source_issue_id
      JOIN issue t ON t.id = l.target_issue_id
      WHERE s.project_id = ${projectId}
      ORDER BY l.source_issue_id, l.target_issue_id`)) as unknown as Row[];
    expect(links).toEqual([
      { source: cid('7100'), target: cid('7100.1'), kind: 'blocks' },
      { source: cid('7103'), target: cid('7101'), kind: 'relates' },
    ]);
  });

  test('a repeated job chunk adds no duplicate issues, comments, types or identities', async () => {
    const before = await pipelineCounts();
    const digestBefore = (await readArtifact()).digest;
    // A crashed-and-retried tick builds a FRESH reader (the worker's per-tick
    // buildReader re-reads the board) and re-enters Create at the chunk end:
    // nothing may change; Link adds no second edge.
    const retryReader = new BdReader(
      {
        boardPath: board.boardPath,
        maxDepth: Number.POSITIVE_INFINITY,
        sourceName: 'witness board',
      },
      board.run,
    );
    await runCreate(await jobOf(), retryReader);
    await runLink(await jobOf(), retryReader);
    const after = await pipelineCounts();
    expect(after).toEqual(before);
    expect(before).toEqual({ issues: 5, comments: 3, types: 5, ledger: 5, links: 2 });
    expect((await readArtifact()).digest).toBe(digestBefore);
    expect(board.calls).toHaveLength(2); // exactly one export read per tick, no more

    // Worst case: a restart that LOST the chunk pointer (create cursor {})
    // replays all five records against the ledger: the per-record dedupe
    // creates nothing new and the fresh empty commit keeps the digest
    // byte-identical - no new ids are forced.
    await advanceImportJobPhase(jobId, 'create', {});
    await runCreate(await jobOf(), retryReader); // all five records replay against the ledger
    await runCreate(await jobOf(), retryReader); // empty chunk -> same-digest commit
    expect(await pipelineCounts()).toEqual(before);
    expect((await readArtifact()).digest).toBe(digestBefore);
    expect(board.calls).toHaveLength(2); // the cached snapshot: still no new export
  });

  afterAll(async () => {
    if (made.job) {
      const ids = [...issueIds.values()];
      if (ids.length) {
        // Parameterized equality clauses over the captured down-ids only: an
        // ANY(${arr}) bind compiles a SQL tuple and fails 42809 (Root
        // FULL_PIPELINE_D2_R1), so each id is its own bind parameter.
        const srcEqs = ids.map((id) => sql`source_issue_id = ${id}`);
        const tgtEqs = ids.map((id) => sql`target_issue_id = ${id}`);
        await db.execute(
          sql`DELETE FROM issue_link WHERE ${sql.join([...srcEqs, ...tgtEqs], sql` OR `)}`,
        );
        const idEqs = ids.map((id) => sql`issue_id = ${id}`);
        await db.execute(sql`DELETE FROM issue_label WHERE ${sql.join(idEqs, sql` OR `)}`);
        await db.execute(sql`DELETE FROM issue_activity WHERE ${sql.join(idEqs, sql` OR `)}`);
      }
      await db.execute(sql`DELETE FROM issue WHERE project_id = ${projectId}`);
      await db.execute(sql`DELETE FROM import_record WHERE import_job_id = ${jobId}`);
      await db.execute(sql`DELETE FROM import_job WHERE id = ${jobId}`);
      await db.execute(sql`DELETE FROM project_column WHERE project_id = ${projectId}`);
      await db.execute(sql`DELETE FROM project WHERE id = ${projectId}`);
      if (made.team) await db.execute(sql`DELETE FROM team WHERE id = ${teamId}`);
      if (made.ws) await db.execute(sql`DELETE FROM workspace WHERE id = ${wsId}`);
      if (made.user) await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
      // Rig + ledger rows are IMMUTABLE - never deleted; asserted by count.
      const [left] = await db.execute(
        sql`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`,
      );
      const [rigRow] = await db.execute(
        sql`SELECT next_root::int AS next_root FROM rig WHERE id = ${rigId}`,
      );
      console.log(
        `8363.1 pipeline witness: rig ${rigId} (${board.prefix}) retained with ` +
          `${Number(left.n)} imported identities, next_root ${Number(rigRow.next_root)}; fixture rows removed.`,
      );
    }
  });
});
