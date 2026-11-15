// pause-cancel-redaction.proof.ts — the F1 handler-level proof, moved into a
// CHILD TEST PROCESS (Root msg_ff6952f9de7e, 2026-11-15): this file is the
// ONLY place in the api unit set that calls mock.module, and it is never
// collected by `bun test`'s file glob (the name is .proof.ts, not .test.ts).
// The parent pause-cancel-redaction.test.ts spawns exactly this file as a
// separate `bun test` process, so the parent/full test process never installs
// the @repo/db / @repo/auth / service / access / projects stubs.
//
// Why a child process: bun's mock.module rewrites the import graph
// process-globally, and mock.restore() does not undo those rewrites - the
// unisolated version of this proof leaked its @repo/db/service/auth
// replacements into every other file of the same `bun test` run. A separate
// process is the only demonstrable isolation bun offers for module mocks.
//
// CT review 2026-11-15 (Root msg_d1d642d0af0a): the pause and cancel handlers
// return the FRESH job DTO, which can carry a stored bd lastError from the
// previous step - the same leak the list/get readers already redact. This is
// the focused handler-level proof: the REAL route table (index.ts, with its
// real authContext and entity-guard chain) is driven through app.fetch with a
// spread-and-stub mock set - no real session, no bd process, and NO database
// connection: Root 2026-11-15 (msg_039380ec1a3a) found the old "no database
// call" claim false - the real authContext's noteSeen executes an hourly
// UPDATE user SET last_seen_at, which opened a connection to the fake
// loopback URL just to be refused with 28000; a caught error is still a
// connection attempt. The @repo/db module is therefore replaced BEFORE the
// route table loads with the real module's named exports plus a narrow
// fail-closed stub client: the noteSeen update chain records itself and
// resolves, every other operation throws a distinct error, and the real
// client is not in the import chain at all. The recorded writes are the proof
// of zero connection attempts: exactly one memoized write per distinct user.
// The env vars below are set before the dynamic import (the @repo/db module
// still validates them on load) and never overwrite a real environment.
import { beforeAll, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://unit-test:unit-test@127.0.0.1:5433/unit-test';
process.env.APP_URL ??= 'http://127.0.0.1:4000';
process.env.API_URL ??= 'http://127.0.0.1:3000';

// The fresh DTO the service returns after the status write: the previous
// step's stored bd lastError rides along on the row. The shape matches
// ImportJobResponse so the route's response validation passes exactly as in
// production.
const C = { discovered: 12, created: 12 };
const FRESH_JOB = {
  id: 7,
  projectId: 3,
  source: 'bd',
  sourceProject: { name: 'sentinel-prod', url: null },
  phase: 'create',
  status: 'paused',
  counts: {
    issue: C,
    comment: C,
    label: C,
    state: C,
    cycle: C,
    attachment: C,
    checklist: C,
    custom_field: C,
    issue_type: C,
    initiative: C,
    worklog: C,
  },
  lastError: 'bd board /srv/boards/sentinel-prod export failed: board id 42',
  nextAttemptAt: '2026-11-15T00:00:00.000Z',
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-15T09:00:00.000Z',
};
const REDACTED = 'A bd import step failed; ask the operator for the details.';

const editor = { id: 'u1', email: 'owner@example.invalid', role: 'user' };
const operator = { id: 'op', email: 'operator@example.invalid', role: 'god' };

// The session the mocked auth hands the real authContext plugin.
let currentTestUser: unknown = null;

// The narrow fail-closed @repo/db client stub: the ONLY real db consumer
// left in the unmocked auth chain is noteSeen (auth-context.ts signedIn).
// The noteSeen chain (update -> set -> where) records itself and resolves;
// every other client operation throws a distinct error, so any unexpected
// consumer fails this test loudly instead of opening a socket.
const noteSeenWrites: string[] = [];
const stubDb = {
  query: {
    user: {
      findFirst: () => {
        throw new Error('no-database stub: db.query reached; the isolation claim is broken');
      },
    },
  },
  update: (_table: unknown) => ({
    set: (_values: unknown) => ({
      where: () => {
        noteSeenWrites.push('last_seen_at');
        return Promise.resolve([]);
      },
    }),
  }),
  select: () => {
    throw new Error('no-database stub: db.select reached; the isolation claim is broken');
  },
  insert: () => {
    throw new Error('no-database stub: db.insert reached; the isolation claim is broken');
  },
  delete: () => {
    throw new Error('no-database stub: db.delete reached; the isolation claim is broken');
  },
  transaction: () => {
    throw new Error('no-database stub: db.transaction reached; the isolation claim is broken');
  },
  execute: () => {
    throw new Error('no-database stub: db.execute reached; the isolation claim is broken');
  },
};

// The route table as the test drives it: a fetch endpoint (Elysia 1.x has no
// dedicated test harness export, so the app is driven through app.fetch).
interface FetchableApp {
  fetch(request: Request): Promise<Response> | Response;
}
let routes: FetchableApp | null = null;

async function fetchPath(path: string): Promise<Response> {
  if (!routes) throw new Error('route table not loaded');
  return await routes.fetch(new Request(`http://localhost${path}`, { method: 'POST' }));
}

describe('pause/cancel responses redact the stored bd lastError for non-operators (handler level)', () => {
  beforeAll(async () => {
    // The @repo/db mock MUST be first: every spread-and-mock import below
    // loads the real modules, which bind @repo/db through the specifier -
    // they must bind the stub, not the real (connection-opening) client.
    const realDb = await import('@repo/db');
    mock.module('@repo/db', () => ({ ...realDb, db: stubDb }));
    // Spread the REAL modules and stub only what would touch a database or a
    // live session: the two service functions the handlers call plus the
    // project-id read they guard on, the session lookup (the test user), the
    // personal-workspace ensure (DB write), the permission assertion (DB
    // matrix read) and the project row read the reachability guard performs.
    const realAuth = await import('@repo/auth');
    const realService = await import('../../service');
    const realAccess = await import('#shared/access');
    const realProjects = await import('#modules/projects/service');
    mock.module('@repo/auth', () => ({
      ...realAuth,
      getSessionFromHeaders: async () => (currentTestUser ? { user: currentTestUser } : null),
      ensurePersonalWorkspace: async () => {},
    }));
    mock.module('../../service', () => ({
      ...realService,
      pauseImportJob: async () => ({ ...FRESH_JOB, status: 'paused' }),
      cancelImportJob: async () => ({ ...FRESH_JOB, status: 'failed' }),
      getImportJobProjectId: async () => 3,
    }));
    mock.module('#shared/access', () => ({
      ...realAccess,
      assertPermission: async () => {},
    }));
    mock.module('#modules/projects/service', () => ({
      ...realProjects,
      getProjectById: async () => ({ id: 3, archivedAt: null, mcpEnabled: true }),
    }));
    const mod = await import('../../index');
    routes = mod.importExportRoutes;
  });

  test('pause: a non-operator project editor gets the fixed sentence, never the stored text', async () => {
    currentTestUser = editor;
    const res = await fetchPath('/import-jobs/7/pause');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; lastError: string | null };
    expect(body.status).toBe('paused');
    expect(body.lastError).toBe(REDACTED);
    expect(body.lastError).not.toMatch(/srv\/boards|board id 42/);
  });

  test('cancel: the same redaction on the fresh cancel DTO', async () => {
    currentTestUser = editor;
    const res = await fetchPath('/import-jobs/7/cancel');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; lastError: string | null };
    expect(body.status).toBe('failed');
    expect(body.lastError).toBe(REDACTED);
    expect(body.lastError).not.toMatch(/srv\/boards|board id 42/);
  });

  test('the operator reads the stored lastError on both pause and cancel', async () => {
    currentTestUser = operator;
    for (const path of ['/import-jobs/7/pause', '/import-jobs/7/cancel']) {
      const res = await fetchPath(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lastError: string | null };
      expect(body.lastError).toBe(FRESH_JOB.lastError);
    }
  });

  test('no session is refused before any DTO is returned (the session gate owns access)', async () => {
    currentTestUser = null;
    const res = await fetchPath('/import-jobs/7/pause');
    expect(res.status).toBe(401);
  });

  test('zero connection attempts: the only db write in the unmocked auth chain is noteSeen, served by the stub', () => {
    // Exactly one memoized last_seen_at write per distinct user that got
    // through the REAL authContext (editor, then operator; the hourly memo
    // spares the repeat requests, and the no-session test was refused before
    // signedIn). Anything else touching the client throws a distinct stub
    // error and fails the test - the real client is not in the import chain,
    // so a connection attempt is structurally impossible and the recorded
    // writes are the receipt.
    expect(noteSeenWrites).toEqual(['last_seen_at', 'last_seen_at']);
  });
});
