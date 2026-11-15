// Synthetic fixtures for the 8429 bd-source authorization witness, and nothing else.

import { randomBytes } from 'node:crypto';
//
// WHAT THIS PROVES AND WHY THE FIXTURES ARE THIS SHAPE (sentinel-prod-8429, prepared by qwen2, 2026-11-15,
// Root's slice in msg_a1e39de3bb12; R2 repair of Root's RETURN in msg_1c1f5286ac02). The server's bd board is
// server-global private data: 617cd9cd added requireBdOperator, which reuses the existing instance-owner guard
// (#shared/access requireGod), on POST /projects/:projectKey/import-jobs/bd-test-connection, .../bd-preview, and on
// POST /projects/:projectKey/import-jobs when body.source === 'bd' - IN ADDITION TO the project's own
// import_export permission. The witness must show that a person who owns the project and holds its import_export
// permission is still refused, in the server's own words, BEFORE any bd command or board config is touched. So the
// fixtures need exactly two accounts - the instance owner and a plain project owner - the real routes to reach them,
// a real job table to count, and a tripwire that fails loudly if a command were ever attempted.
//
// HELD, NOT RUN (Root 2026-11-15: "Prepare only: NO DB GO ... Root will compose and run serially"). This file
// refuses at import time unless Root sets ITSAPLAN_8429_QW2_BD_SOURCE_AUTH=granted, refuses anything but the exact
// D2 test database on the exact test port, and refuses to run in a parallel test worker.
//
// WHAT R2 CHANGED, in Root's words: the R1 fixture called the repo's whole-database reset helper, which empties
// every table in the database, while its own comment promised cleanup by captured ids. That call is gone - import and
// call both - and nothing in this file deletes a row it did not create. Its accounts are made by the repo's own
// sign-up helper and their roles are then set explicitly on the two captured user ids (instance owner 'god', witness
// actor 'user') and read back from the table the server reads, because without a cleared database "the first account
// registered is the owner" is not a fact this lane may assume. The workspace and team ids sign-up created are captured
// and deleted, in the order the foreign keys ask for, and nothing else. The instance owner is also made a project
// owner of the witness project, because the bd routes ask for the project permission first and a global role does not
// bypass it: without that membership the operator case would answer with a project-permission 403 and prove nothing
// about the door.

export const GRANT_ENV = 'ITSAPLAN_8429_QW2_BD_SOURCE_AUTH';
export const BOARD_ROOT_ENV = 'BD_IMPORT_BOARD_ROOT';
export const BOARD_COMMAND_ENV = 'BD_IMPORT_BD_COMMAND';

// Root's R2 tightening: the exact database and port of the D2 rig, not a name that merely contains "test".
const TEST_DATABASE = 'itsaplan_8364_d2_test';
const TEST_PORT = '5433';

// The server's own 403 wording, from requireGod in apps/api/src/shared/access.ts at 617cd9cd. The witness
// asserts these words rather than only a status, because "the door refused" and "the permission refused"
// must not be confused.
export const OWNER_ONLY_ERROR = 'Instance administration is owner-only';

// The wording a project-permission refusal carries instead. It must never be mistaken for the door's.
export const PERMISSION_ERROR_MARKS = ['permission', 'not allowed', 'forbidden'];

// The tripwire (Root's instruction: "configure an invalid executable path as a tripwire, expect 403 rather
// than command/config failure"). A path-shaped board root and a command name that exists nowhere: if any bd
// read were attempted, execFile would fail and the route would answer with the config/command wording
// ("bd import is not configured..." from bdBoardConfig, or "the bd board at ... cannot be read: ..." from
// defaultBdRunner in 617cd9cd's bd.ts). Neither is ever the answer a role user should get.
export const TRIPWIRE_BOARD_ROOT = '/zz-8429-witness-board-does-not-exist';
export const TRIPWIRE_BD_COMMAND = 'zz-8429-witness-not-a-real-bd';
export const COMMAND_FAILURE_MARKS = [
  'cannot be read',
  'is not configured',
  'must be a single word',
];

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function held(): void {
  if (process.env[GRANT_ENV] !== 'granted') {
    throw new Error(
      `HELD: the 8429 bd-source authorization witness runs only when ${GRANT_ENV}=granted is set by Root's serial DB GO`,
    );
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('HELD: these tests run only with NODE_ENV=test and .env.test');
  }
  if (process.env.BUN_TEST_WORKER_ID) {
    throw new Error(
      'HELD: these tests run serially, with no test worker id (Root runs them one at a time)',
    );
  }
  const raw = process.env.DATABASE_URL ?? '';
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname))
    throw new Error(`HELD: refusing a non-loopback host ${url.hostname}`);
  if (url.port !== TEST_PORT)
    throw new Error(
      `HELD: refusing port ${url.port || 'default'}; this witness is for port ${TEST_PORT}`,
    );
  if (dbName !== TEST_DATABASE) {
    throw new Error(
      `HELD: refusing database ${dbName}; this witness is for ${TEST_DATABASE} exactly`,
    );
  }
}
void held();

const { db, importJob, project, projectMember, team, user, workspace } = await import('@repo/db');
const { app, authedApi, createProject } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');
const { trustedOrigins } = await import('@repo/auth');
const { and, eq, inArray } = await import('drizzle-orm');

export interface Person {
  id: string;
  email: string;
  cookie: string;
  // What sign-up gave this account, captured so cleanup can name it. signUpTestUser returns the workspace the
  // account owns (or null when personal workspaces are off); the team inside it is read back by that id.
  workspaceId: number | null;
  teamIds: number[];
}

export interface Fixture {
  // The account the witness holds the instance-owner role. Used for the one case that must reach the command half
  // of a bd route, and never with a real board.
  instanceOwner: Person;
  // The witness's actor: an ordinary account that owns the project below and holds its import_export permission.
  projectOwner: Person;
  projectKey: string;
  projectId: number;
  // The ids every created row carries, so cleanup is a list rather than a sweep.
  workspaceIds: number[];
  teamIds: number[];
}

let keyCounter = 0;
// PROJECT_KEY_PATTERN in apps/api/src/modules/projects/key.ts is ^[A-Z][A-Z0-9]{0,9}$. A fresh key per call
// keeps two runs of this witness in one database from colliding.
function freshProjectKey(): string {
  keyCounter += 1;
  return `ZZ${Date.now().toString(36).toUpperCase().slice(-6)}${keyCounter}`.slice(0, 10);
}

// Sign-up needs an address that no earlier run of this witness used, because nothing here clears a table: a fixed
// address would collide with the row the previous run left behind.
function freshEmail(label: string): string {
  return `zz8429-${label}-${randomBytes(6).toString('hex')}@example.com`;
}

// Registers one account through the repo's own sign-up helper, then sets its instance role on the captured id alone
// and reads it back from the table the server reads (apps/api/src/shared/access.ts). The role is not inherited from
// the order accounts happened to be created in, which is what R1 relied on and what a cleared database made look
// like it was.
async function account(name: string, label: string, role: 'god' | 'user'): Promise<Person> {
  const created = await signUpTestUser({ name, email: freshEmail(label) });
  await db.update(user).set({ role }).where(eq(user.id, created.userId));
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, created.userId));
  if (!row || row.role !== role) {
    throw new Error(
      `fixture: account ${name} did not read back with role ${role}; it read ${row?.role ?? 'nothing'}`,
    );
  }
  const teamIds =
    created.workspaceId === null
      ? []
      : (
          await db
            .select({ id: team.id })
            .from(team)
            .where(eq(team.workspaceId, created.workspaceId))
        ).map((t) => t.id);
  return {
    id: created.userId,
    email: created.email,
    cookie: created.cookie,
    workspaceId: created.workspaceId,
    teamIds,
  };
}

// Makes the instance owner an owner of the witness project through the same table the server checks
// (apps/api/src/shared/guards.ts: a project owner bypasses the permission matrix, a plain member does not). Without
// this the operator case answers with a project-permission refusal before the door is ever reached.
async function addAsProjectOwner(projectId: number, userId: string): Promise<void> {
  await db.insert(projectMember).values({ projectId, userId, role: 'owner' });
  const [row] = await db
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)));
  if (!row || row.role !== 'owner')
    throw new Error('fixture: the instance owner is not a project owner');
}

// Creates the two accounts and the project the witness acts on. It clears nothing: every id it created is returned
// so cleanup can name them.
export async function bdSourceFixture(): Promise<Fixture> {
  const instanceOwner = await account('zz Witness Instance Owner', 'owner', 'god');
  const projectOwner = await account('zz Witness Project Owner', 'actor', 'user');
  const key = freshProjectKey();

  const client = authedApi(projectOwner.cookie);
  const created = await createProject(client, { key, name: 'zz Witness Bd Source Project' });
  if (!created.data) {
    throw new Error(
      `fixture: creating project ${key} failed with status ${created.status} ${JSON.stringify(created.error ?? null)}`,
    );
  }
  const [row] = await db.select({ id: project.id }).from(project).where(eq(project.key, key));
  if (!row)
    throw new Error(
      `fixture: project ${key} is not readable back from the table it was written to`,
    );

  await addAsProjectOwner(row.id, instanceOwner.id);

  const workspaceIds = [instanceOwner, projectOwner]
    .map((p) => p.workspaceId)
    .filter((id): id is number => id !== null);
  const teamIds = [...instanceOwner.teamIds, ...projectOwner.teamIds];
  return { instanceOwner, projectOwner, projectKey: key, projectId: row.id, workspaceIds, teamIds };
}

// The account's global better-auth role, read from the table the server reads. The witness needs this fact
// stated rather than assumed: every 403 below is about this column, not about membership or permission.
export async function roleOf(userId: string): Promise<string | null> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  return row?.role ?? null;
}

// Which role a project carries for one account, for the same reason: the permission half of these routes is a fact
// the witness states and checks, not an assumption.
export async function projectRoleOf(projectId: number, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)));
  return row?.role ?? null;
}

interface Call {
  status: number;
  body: string;
}

// Drives the routes through the in-memory app (no network, no port) the way apps/api/src/__tests__/integration/api-keys.test.ts
// does, rather than through Eden Treaty: these three paths are exactly the ones whose typing depends on the
// candidate Root composes, and a witness that names the URL is readable against either branch.
//
// The Origin header is test context, not a defect repair (Root's correction, msg_1f293ef091f8). apps/api/src/app.ts
// refuses a state-changing cookie request whose Origin is present but untrusted; when no Origin is present it trusts
// Sec-Fetch-Site, and Bun's own Request adds neither header - measured, so a POST built without one is allowed here,
// not CSRF-refused. Sending the app's own APP_URL-derived origin (the same list packages/auth/src/origins.ts builds
// from APP_URL) is what a caller from the web app would send, so the case shows the owner door answering on a
// request the CSRF guard accepts, rather than leaving which guard answered unstated.
export async function bdCall(
  fixture: Fixture,
  method: 'GET' | 'POST',
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Call> {
  // The fixture is load-bearing here rather than decorative: a witness that asked one project's permission
  // while calling another project's route would prove nothing about the first one.
  if (!path.startsWith(`/projects/${fixture.projectKey}/`)) {
    throw new Error(`witness refused: ${path} is not a route of project ${fixture.projectKey}`);
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: trustedOrigins[0],
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
    }),
  );
  return { status: response.status, body: await response.text() };
}

export function bdRoute(fixture: Fixture, segment: string): string {
  return `/projects/${fixture.projectKey}/import-jobs/${segment}`;
}

export function importJobsRoute(fixture: Fixture): string {
  return `/projects/${fixture.projectKey}/import-jobs`;
}

// The job table, counted the way the witness needs it: once across the instance, once for this project.
// A refusal that "changed nothing" is only a fact if both counts were read.
export async function importJobCountAll(): Promise<number> {
  const rows = await db.select({ id: importJob.id }).from(importJob);
  return rows.length;
}

export async function importJobCountForProject(projectId: number): Promise<number> {
  const rows = await db
    .select({ id: importJob.id })
    .from(importJob)
    .where(eq(importJob.projectId, projectId));
  return rows.length;
}

// Runs `run` with the bd tripwire configured and hands the environment back exactly as it was, so no case
// leaks its own onward - the same shape as withOwner in apps/api/src/modules/issues/__tests__/integration/tracker-comment-create-fixtures.ts.
export async function withTripwire<T>(run: () => Promise<T>): Promise<T> {
  const prior = [process.env[BOARD_ROOT_ENV], process.env[BOARD_COMMAND_ENV]];
  process.env[BOARD_ROOT_ENV] = TRIPWIRE_BOARD_ROOT;
  process.env[BOARD_COMMAND_ENV] = TRIPWIRE_BD_COMMAND;
  try {
    return await run();
  } finally {
    [BOARD_ROOT_ENV, BOARD_COMMAND_ENV].forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}

// Says what a refusal body actually carries, so the witness can tell the door's words from the config's words.
export function namesCommandOrConfigFailure(body: string): boolean {
  return COMMAND_FAILURE_MARKS.some((mark) => body.includes(mark));
}

export function namesTripwire(body: string): boolean {
  return body.includes(TRIPWIRE_BD_COMMAND) || body.includes(TRIPWIRE_BOARD_ROOT);
}

// Says whether a refusal is the project-permission half rather than the instance-owner door, so a case that was
// supposed to test the door cannot silently be testing membership.
export function namesPermissionFailure(body: string): boolean {
  const lower = body.toLowerCase();
  return PERMISSION_ERROR_MARKS.some((mark) => lower.includes(mark));
}

// Cleanup by the ids this file captured, and only those: the job rows it created, the one project it created, the
// teams and workspaces its two accounts' sign-ups created, and the two accounts. It deletes no row it did not
// create and touches no rig, ledger, session or settings table. The order is the one the foreign keys in
// packages/db/src/schema/app.ts ask for: a project cascades its projectMember rows, a workspace cascades its teams
// and its workspaceManager rows, so the parents go before the accounts they point at.
export async function cleanupFixture(
  fixture: Fixture,
  createdJobIds: number[] = [],
): Promise<void> {
  if (createdJobIds.length > 0) {
    await db.delete(importJob).where(inArray(importJob.id, createdJobIds));
  }
  await db.delete(project).where(eq(project.id, fixture.projectId));
  if (fixture.teamIds.length > 0) await db.delete(team).where(inArray(team.id, fixture.teamIds));
  if (fixture.workspaceIds.length > 0)
    await db.delete(workspace).where(inArray(workspace.id, fixture.workspaceIds));
  await db
    .delete(user)
    .where(inArray(user.id, [fixture.projectOwner.id, fixture.instanceOwner.id]));
}
