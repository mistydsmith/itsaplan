// Shared target guard for the 8363.1 prepared PostgreSQL suites (split from
// bead_import_identity.test.ts, Root 2026-11-15: keep the witness files under
// 400 lines). Both PG test files import targetUrl + RUN so the exact same
// proof flag, loopback-only, port-5433, exact-DB and BUN_TEST_WORKER_ID
// refusals gate every client construction.
// PREPARED, NOT RUN: execution is held for Root's serial DB slot (8363.1 GO: no
// actual DB calls from the lane). The file is discriminating on purpose - it
// fails loudly if the writer regresses any of the reviewed behaviors. It follows
// the issue_identity.test.ts conventions exactly: a dedicated database, loopback
// only, and rig/ledger rows that are never deleted because the C1 guards forbid
// it (the counts left behind are asserted instead).
//
// Target: loopback on port 5433, database exactly itsaplan_8364_d2_test, and the
// caller must export ITSAPLAN_8363_1_IMPORT_IDENTITY_PROOF=granted. The proof flag
// is checked before any database client is constructed, so an accidental env file
// can never point this fixture at prod (C1). The required schema is nothing:
// issues.bead_id and the bead_identity ledger already exist in main schema/app.ts.
// The cleanup removes only the fixture issues, column, project, team and
// workspace in foreign-key order. The rig is NEVER deleted, in ANY outcome - a
// successful run's immutable rig + ledger is asserted by count, and a failed
// run's rig is preserved and reported (Root 2026-11-15: immutable owned rig
// retention was explicit; re-runs add distinct rigs under the random prefix, the
// C1 guards stay in force). The suite also refuses to run inside a bun test
// worker process (BUN_TEST_WORKER_ID set): this fixture owns its own connection
// lifecycle for Root's single serial slot, not a parallel test worker. The
// fixtures deliberately carry no worker or agent identity: the ledger rows they
// create are origin 'imported' with no worker attribution, exactly the import
// path.
// One random suffix per process: re-runs add distinct rigs/fixtures, never
// collide, and a failed run's rig is preserved for inspection.
export const RUN = Math.random().toString(36).slice(2, 10);

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const PROOF_FLAG = 'ITSAPLAN_8363_1_IMPORT_IDENTITY_PROOF';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  // The proof flag gates the suite before any client exists: without it this
  // throws, so a checked-in CI default can never hold a live target.
  if (process.env[PROOF_FLAG] !== 'granted') {
    throw new Error(`${PROOF_FLAG}=granted is required to run this suite.`);
  }
  // No bun test worker: this fixture owns its own connection lifecycle for one
  // serial run; a parallel worker would interleave its fixtures with the suite's.
  if (process.env.BUN_TEST_WORKER_ID) {
    throw new Error(
      'this suite runs outside bun test workers (BUN_TEST_WORKER_ID set); use a single serial process',
    );
  }
  if (nodeEnv !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL does not parse');
  }
  const name = url.pathname.replace(/^\//, '');
  const port = url.port || '5432';
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(`refusing non-loopback host ${url.hostname}`);
  if (port !== '5433') throw new Error(`refusing port ${port}; this suite uses 5433`);
  if (/sentinel|trial/i.test(name))
    throw new Error('refusing a persistent trial or Sentinel database');
  if (name !== REQUIRED_DB)
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}
