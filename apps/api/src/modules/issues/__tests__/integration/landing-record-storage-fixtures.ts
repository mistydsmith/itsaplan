// apps/api/src/modules/issues/__tests__/integration/landing-record-storage-fixtures.ts
// sentinel-prod-8429 unit 6 fixtures - PREPARED, executed only inside Root's D2 slot.
//
// EVERY COLUMN HERE WAS READ FROM THE SCHEMA at ItsPlan main 4f089442: rig carries (prefix, next_root) and NOT project_id, the
// project points at the rig through project.rig_id, the canonical bead id comes from the rig (prefix plus the root coordinate
// recorded in bead_identity), and the status stretch is issue_status (column_id, column_name, state_type, entered_at, left_at).
//
// WHY these are functions and not SQL strings: the first version exported statement templates that the test never used, so the
// test kept its own wrong seed. A function that performs the inserts cannot be bypassed by accident.
//
// WHAT IT NEVER DOES: no reset, no trigger disable, no ledger or rig delete. The rig and its bead_identity row are tombstones -
// named for a reader, left in place - because project.rig_id is ON DELETE RESTRICT and because they are the audit trail.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as G from './tracker-labels-gate-fixtures';

export const LANDING_D2_ENV = 'ITSAPLAN_LANDING_D2';
export const landingD2Ready = (): boolean => (process.env[LANDING_D2_ENV] ?? '').trim() === '1';

export const LANDING_D2_DB = 'itsaplan_8364_d2_test';

/** Refuse to touch anything but the dedicated test database, before any query runs. */
export function assertLandingTargetGuard(): void {
  const envUrl = process.env.DATABASE_URL ?? '';
  let url: URL;
  try {
    url = new URL(envUrl);
  } catch {
    throw new Error(
      `landing guard: DATABASE_URL is not a parseable URL, got ${JSON.stringify(envUrl)}`,
    );
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '::1')
    throw new Error(`landing guard: host must be loopback, got '${url.hostname}'`);
  if (url.port !== '5433') throw new Error(`landing guard: port must be 5433, got '${url.port}'`);
  if (url.pathname !== `/${LANDING_D2_DB}`)
    throw new Error(`landing guard: path must be /${LANDING_D2_DB}, got '${url.pathname}'`);
  if (process.env.NODE_ENV !== 'test') throw new Error('landing guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('landing guard: BUN_TEST_WORKER_ID must be unset (single process)');
}

/** The full ref form the adapter compares; `refs/heads/main`, never `main`. */
export const branchRef = (branch: string): string => `refs/heads/${branch}`;
export const TARGET_BRANCH = 'main';
export const TARGET_REF = branchRef(TARGET_BRANCH);

/** The manifest key this fixture pins for its disposable repository. */
export const CLOSE_REPO_KEY = 'fixture';

export function landingRunId(): string {
  return createHash('sha1')
    .update(`${process.pid}-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * A disposable repository plus the manifest pin the close service reads.
 *
 * WHY modelled on tracker-close-request.test.ts: that suite already proves a gated close against a throwaway Git repo, and
 * its shape is the one the service accepts. It writes `refs/heads/main` here, the full form, so the landing payload and the
 * manifest agree by construction rather than by luck.
 */
export interface CloseRepo {
  root: string;
  repo: string;
  manifest: string;
  /** A real commit on the pinned branch; this is the candidate SHA a landing closes. */
  candidateSha: string;
  baseSha: string;
  cleanup(): void;
}

export function closeRepo(runId: string, rigPrefix: string): CloseRepo {
  const work = mkdtempSync(join(tmpdir(), 'landing-record-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo }).toString().trim();
  git('init', '-q', '-b', TARGET_BRANCH);
  git('config', 'user.email', 'landing-fixture@local');
  git('config', 'user.name', 'Landing Fixture');
  writeFileSync(join(repo, 'base.txt'), 'base');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'candidate.txt'), runId);
  git('add', '.');
  git('commit', '-q', '-m', `${rigPrefix}-1: candidate ${runId}`);
  const candidateSha = git('rev-parse', 'HEAD');
  const manifest = join(work, 'CONFIG.json');
  const owner = JSON.parse(readFileSync(G.OWNER_CONFIG, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    manifest,
    JSON.stringify({
      ...owner,
      close: {
        rigs: {
          [rigPrefix]: {
            repos: { [CLOSE_REPO_KEY]: { repoRoot: repo, targetRef: TARGET_REF } },
            artifactRoots: [work],
          },
        },
      },
    }),
  );
  return {
    root: work,
    repo,
    manifest,
    candidateSha,
    baseSha,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

/** Every id this seed created; the rig and its identity are named but never deleted. */
export interface OwnedLandingRows {
  rigPrefix: string;
  rigId: number;
  beadIdentityId: number;
  beadId: string;
  workspaceId: number;
  teamId: number;
  projectId: number;
  startedColumnId: number;
  completedColumnId: number;
  issueId: number;
  closerUserId: string;
  claimEpoch: number;
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
type Db = { execute(query: unknown): Promise<unknown> };

/** drizzle's execute hands back an array of rows in this stack; read one integer out of it. */
async function one(db: Db, query: unknown): Promise<Record<string, unknown>> {
  const out = (await db.execute(query)) as unknown;
  const rows = Array.isArray(out)
    ? (out as Record<string, unknown>[])
    : ((out as { rows?: Record<string, unknown>[] }).rows ?? []);
  const [row] = rows;
  if (row === undefined) throw new Error('landing fixture: statement returned no row');
  return row;
}

/**
 * Creates one owned workspace, rig, project, two columns, a closer user, a claimed card and its bead identity.
 *
 * WHY next_root starts at 2: the mint below takes root 1, and leaving the high-water mark at 1 would hand the same root to
 * the next create - the invariant the unique (rig_id, root, child) index protects.
 */
export async function seed(db: Db, sql: Sql, runId: string): Promise<OwnedLandingRows> {
  const rigPrefix = `d2${runId.slice(0, 6)}`;
  const closerUserId = `closer-${runId}`;
  const rigRow = await one(
    db,
    sql`INSERT INTO rig (prefix, next_root) VALUES (${rigPrefix}, 2) RETURNING id`,
  );
  const rigId = Number(rigRow.id);
  const wsRow = await one(
    db,
    sql`INSERT INTO workspace (name) VALUES (${`d2 ws ${runId}`}) RETURNING id`,
  );
  const workspaceId = Number(wsRow.id);
  const teamRow = await one(
    db,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${workspaceId}, ${`d2 ${runId}`}, ${`d2-${runId}`}) RETURNING id`,
  );
  const teamId = Number(teamRow.id);
  const projectRow = await one(
    db,
    sql`INSERT INTO project (team_id, name, key, rig_id)
        VALUES (${teamId}, ${`d2 ${runId}`}, ${`D2${runId.slice(0, 5).toUpperCase()}`}, ${rigId}) RETURNING id`,
  );
  const projectId = Number(projectRow.id);
  const startedRow = await one(
    db,
    sql`INSERT INTO project_column (project_id, name, state_type, position)
        VALUES (${projectId}, 'Doing', 'started', 1) RETURNING id`,
  );
  const startedColumnId = Number(startedRow.id);
  const completedRow = await one(
    db,
    sql`INSERT INTO project_column (project_id, name, state_type, position)
        VALUES (${projectId}, 'Done', 'completed', 2) RETURNING id`,
  );
  const completedColumnId = Number(completedRow.id);
  await db.execute(
    sql`INSERT INTO "user" (id, name, username, email, email_verified)
        VALUES (${closerUserId}, 'closer', ${`closer-${runId}`}, ${`closer-${runId}@example.invalid`}, true)`,
  );
  const beadId = `${rigPrefix}-1`;
  const claimEpoch = 1;
  const issueRow = await one(
    db,
    sql`INSERT INTO issue (project_id, column_id, title, bead_id, sequence_number, claim_owner, claim_epoch, claim_expires_at)
        VALUES (${projectId}, ${startedColumnId}, ${`1: landing proof ${runId}`}, ${beadId}, 1, ${closerUserId}, ${claimEpoch},
                now() + interval '1 hour') RETURNING id`,
  );
  const issueId = Number(issueRow.id);
  const label = await one(
    db,
    sql`INSERT INTO label (project_id, name, color) VALUES (${projectId}, 'size-small', '#000000') RETURNING id`,
  );
  await db.execute(
    sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issueId}, ${Number(label.id)})`,
  );
  const identityRow = await one(
    db,
    sql`INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
        VALUES (${rigId}, '1', 1, 0, 'minted', ${issueId}) RETURNING id`,
  );
  return {
    rigPrefix,
    rigId,
    beadIdentityId: Number(identityRow.id),
    beadId,
    workspaceId,
    teamId,
    projectId,
    startedColumnId,
    completedColumnId,
    issueId,
    closerUserId,
    claimEpoch,
  };
}

/**
 * Deletes only the captured ids.
 *
 * WHY the rig and bead identity are absent: project.rig_id is ON DELETE RESTRICT and the identity is the ledger's record of a
 * card that was really closed. Both are left behind on purpose, and nothing here claims a cascade removed them.
 */
export async function cleanup(db: Db, sql: Sql, owned: OwnedLandingRows): Promise<void> {
  const ids = [owned.issueId];
  for (const id of ids) {
    await db.execute(sql`DELETE FROM issue_label WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue_activity WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue_status WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue_cycle WHERE issue_id = ${id}`);
  }
  await db.execute(sql`DELETE FROM issue WHERE id = ${owned.issueId}`);
  await db.execute(
    sql`DELETE FROM project_column WHERE id IN (${owned.startedColumnId}, ${owned.completedColumnId})`,
  );
  await db.execute(sql`DELETE FROM label WHERE project_id = ${owned.projectId}`);
  await db.execute(sql`DELETE FROM project WHERE id = ${owned.projectId}`);
  await db.execute(sql`DELETE FROM team WHERE id = ${owned.teamId}`);
  await db.execute(sql`DELETE FROM workspace WHERE id = ${owned.workspaceId}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${owned.closerUserId}`);
}

export const withCloseOwner = <T>(repo: CloseRepo, run: () => Promise<T>) =>
  G.withGateEnv([G.OWNER.python, G.OWNER.owner, repo.manifest], run);
