// bun test --preload entry for the 8428 proof tests (NO LIVE DB).
// The fake db stands in for the @repo/db CLIENT only: every other export of
// the real package (schema tables, pure helpers, domain functions) is loaded
// from its real source and passed through, so every import in the createIssue
// chain is the real one. DATABASE_URL names a database that is never connected
// to (the real client is lazy; nothing queries it).
process.env.DATABASE_URL ??= 'postgres://fake-db-transport-only/unused';
// Import-time config the real chain reads (origins, auth). These are inert
// transport values: no request ever reaches them in a transport-mocked test.
process.env.APP_URL ??= 'http://127.0.0.1:3000';
process.env.API_URL ??= 'http://127.0.0.1:4000';
process.env.APP_ENCRYPTION_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

import { mock } from 'bun:test';
import path from 'node:path';
import { FAKE_DB } from './fake_log';

const DB_SRC = path.resolve(import.meta.dir, '../../../../../../../packages/db/src');

// Mutable per-test stubs for the gate/identity policy packages (no DB inside
// them is reached; they answer the gated path's policy questions).
export const gateStub = { refusal: null as null | { message: string }, calls: [] as unknown[] };
export const identityStub = { attachOk: true, message: 'identity already attached' };

// A refusal shaped like the real TrackerGateRefusal (isTrackerGateRefusal must
// accept it, because service.ts maps it to the 409 next to the write it stopped).
class TestGateRefusal extends Error {
  readonly code = 'tracker-rules-violation';
  readonly rule = 'test-refusal';
  readonly safe_form = '';
  readonly violations: never[] = [];
  constructor(message: string) {
    super(message);
    this.name = 'TrackerGateRefusal';
  }
}

// The real export surface of @repo/db, loaded by absolute source path (the
// mock registry keys on '@repo/db', so these paths bypass it). Mirrors
// packages/db/src/index.ts: client.ts is the ONLY replaced source.
const REAL_DB_EXPORTS = Object.assign(
  {},
  await import(path.join(DB_SRC, 'schema/index.ts')),
  await import(path.join(DB_SRC, 'permissions.ts')),
  await import(path.join(DB_SRC, 'settings.ts')),
  await import(path.join(DB_SRC, 'secrets.ts')),
  await import(path.join(DB_SRC, 'workspace.ts')),
  await import(path.join(DB_SRC, 'team.ts')),
  await import(path.join(DB_SRC, 'issue-tree.ts')),
  await import(path.join(DB_SRC, 'domains/telegram-bot.ts')),
  await import(path.join(DB_SRC, 'domains/instance-email.ts')),
  await import(path.join(DB_SRC, 'domains/notification-settings.ts')),
  await import(path.join(DB_SRC, 'domains/job-settings.ts')),
  await import(path.join(DB_SRC, 'domains/storage.ts')),
);

mock.module('@repo/db', () => ({ ...REAL_DB_EXPORTS, db: FAKE_DB }));
mock.module('@repo/db/tracker-gate', () => ({
  gateIssueWrite: async (input: unknown) => {
    gateStub.calls.push(input);
    if (gateStub.refusal) throw new TestGateRefusal(gateStub.refusal.message);
  },
  isTrackerGateRefusal: (value: unknown): boolean => value instanceof TestGateRefusal,
}));
mock.module('@repo/db/tracker-issue-facts', () => ({
  snapshotIdFacts: async () => ({
    rig_prefix: 'TST',
    existing_ids: [],
    root_high_water: 6,
    parent_id: null,
  }),
  isIdFactsRefusal: (): boolean => false,
}));
mock.module('@repo/db/issue-identity', () => ({
  allocateBeadToken: async () => ({
    ok: true,
    allocation: {
      rigId: 5,
      prefix: 'TST',
      root: 7,
      child: 0,
      localToken: 'TST-7',
      beadId: 'sentinel-prod-9999',
    },
  }),
  attachBeadIdentity: async () =>
    identityStub.attachOk
      ? { ok: true }
      : { ok: false, code: 'issue-not-ready', message: identityStub.message },
}));
