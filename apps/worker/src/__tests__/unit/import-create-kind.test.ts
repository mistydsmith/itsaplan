// 8363.1, Root status 2026-11-15: "Native kind materialization GO msg 9912 -
// important for 124 epic readiness; source kind cannot ONLY live in job
// artifact". This is the NO-DB pipeline proof that the bd source's exact
// issue kind is MATERIALIZED NATIVELY by the real Create phase, not merely
// recorded in the retained artifact:
//
//   Discover records the exact source issue_type names (from the reader's
//   listIssueTypes, fed by the ONE whole-board export) as issue_type import
//   records -> Create materializes each uncreated record through the EXISTING
//   createLocalIssueTypeAndRecord (native issue_type row, exact name) ->
//   each issue's Create resolves its typeSourceId to the materialized record
//   and binds issue.type_id to it.
//
// The REAL runCreate (import-worker.ts) is driven with a bd-style fake reader.
// The only DB boundaries in the graph are the @repo/db client and the
// import-store functions; both are mock.module-supersets of the REAL modules
// (repo convention, packages/agent-tools client.test.ts: a mock must carry
// every name the graph binds). Nothing connects: the overridden store
// functions capture their calls while the test window is open and DELEGATE to
// the real implementations otherwise, so the process-global mock can never
// change behavior for another test file that shares the registry.
import { afterEach, describe, expect, it, mock } from 'bun:test';

// The @repo/db client module refuses to load without DATABASE_URL; the suite
// convention is the loopback test database (apps/worker runs with
// --env-file=../../.env.test, which carries it). Set it only when absent,
// before the real modules load; no connection is ever opened here.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://misty@127.0.0.1:5433/itsaplan_8364_d2_test';
}

// Capture the REAL modules first; the mocks are supersets of these exports.
const realDb = await import('@repo/db');
const realStore = await import('../../import-store');
const realStoreIssue = await import('../../import-store-issue');

const captured: {
  types: { sourceId: string; name: string }[];
  issues: { sourceId: string; typeId: number | null }[];
} = { types: [], issues: [] };

// True only while this file's test runs: the overridden store functions
// capture then, and pass straight through to the real implementation at any
// other time (another file sharing the process registry gets real behavior).
let capturing = false;

function gate<A extends unknown[], R>(
  real: (...args: A) => Promise<R>,
  stub: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => (capturing ? stub(...args) : real(...args));
}

// The drizzle transaction executor type, derived from the real driver - the
// tripwire fake is a partial of it on purpose (its only method throws), so
// the single cast below is the documented boundary, not a dummy.
type RealTxArg = Parameters<(typeof realDb.db)['transaction']>[0] extends (tx: infer TX) => unknown
  ? TX
  : never;

const tripwireTx = {
  execute: async (): Promise<never> => {
    throw new Error('the kind pipeline proof must not touch the database');
  },
} as unknown as RealTxArg;

mock.module('@repo/db', () => ({
  ...realDb,
  // The ONLY override: the client itself - and even that is a Proxy that
  // delegates EVERYTHING to the real client (typed as its real driver type,
  // no dummy cast): another file sharing the registry keeps real db.insert /
  // db.select behavior. Only transaction is intercepted INSIDE this file's
  // test window, as a fail-closed tripwire - runCreate's retained path is
  // its sole caller and this fixture does not reach it (issues are still
  // pending).
  db: new Proxy(realDb.db, {
    get(target, prop) {
      if (prop === 'transaction') {
        const realTransaction = Reflect.get(target, 'transaction') as (
          fn: Parameters<typeof target.transaction>[0],
        ) => ReturnType<typeof target.transaction>;
        // Outside this file's test window the REAL transaction runs
        // untouched: every other integration file drives the store through
        // it.
        if (!capturing) return realTransaction.bind(target);
        return (fn: Parameters<typeof target.transaction>[0]) => fn(tripwireTx);
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof realDb.db,
}));

// The worker binds createLocalIssueAndRecord directly from import-store-issue
// (A4 moved the function there), so that module is mocked too: a superset of
// the real exports with only the issue create gated.
mock.module('../../import-store-issue', () => ({
  ...realStoreIssue,
  createLocalIssueAndRecord: gate(
    realStoreIssue.createLocalIssueAndRecord,
    async (
      _jobId: number,
      sourceId: string,
      _displayId: string,
      input: { typeId?: number | null },
    ) => {
      captured.issues.push({ sourceId, typeId: input.typeId ?? null });
      return sourceId === 'bd-epic-1' ? 500 : 501;
    },
  ),
}));

mock.module('../../import-store', () => ({
  ...realStore,
  findImportRecord: gate(
    realStore.findImportRecord,
    async (_jobId: number, entity: string, sourceId: string) => {
      if (entity === 'issue_type' && sourceId === 'epic')
        return {
          id: 1,
          importJobId: 1,
          sourceEntityType: 'issue_type',
          sourceId,
          localEntityType: 'issue_type',
          localId: 100,
          sourceDisplayId: null,
        };
      if (entity === 'issue_type' && sourceId === 'task')
        return {
          id: 2,
          importJobId: 1,
          sourceEntityType: 'issue_type',
          sourceId,
          localEntityType: 'issue_type',
          localId: 101,
          sourceDisplayId: null,
        };
      return null;
    },
  ),
  listImportRecords: gate(realStore.listImportRecords, async (_jobId: number, entity: string) => {
    if (entity === 'issue')
      return [
        { id: 10, sourceId: 'bd-epic-1' },
        { id: 11, sourceId: 'bd-task-1' },
      ];
    return [];
  }),
  listUncreatedImportRecords: gate(
    realStore.listUncreatedImportRecords,
    async (_jobId: number, entity: string, afterId: number) => {
      // The Discover phase recorded the reader's exact source kind names. The
      // pager loops until an empty page, so only the first page is non-empty.
      if (entity === 'issue_type' && afterId === 0)
        return [
          { id: 1, sourceId: 'epic', localId: null },
          { id: 2, sourceId: 'task', localId: null },
        ];
      return [];
    },
  ),
  firstProjectColumnId: gate(realStore.firstProjectColumnId, async () => 5),
  saveImportJobCursor: gate(realStore.saveImportJobCursor, async () => undefined),
  turnOnProjectTracking: gate(realStore.turnOnProjectTracking, async () => undefined),
  addIssueWatchers: gate(realStore.addIssueWatchers, async () => undefined),
  createLocalIssueTypeAndRecord: gate(
    realStore.createLocalIssueTypeAndRecord,
    async (_jobId: number, sourceId: string, _projectId: number, type: { name: string }) => {
      captured.types.push({ sourceId, name: type.name });
      return sourceId === 'epic' ? 100 : 101;
    },
  ),
}));

const { runCreate } = await import('../../import-worker');
import type { ClaimedImportJob } from '../../import-store';
import type { SourceReader } from '../../reader';
import type {
  CanonicalAttachment,
  CanonicalChecklist,
  CanonicalComment,
  CanonicalIssue,
} from '../../canonical';

function canonicalIssue(sourceId: string, kind: 'epic' | 'task'): CanonicalIssue {
  return {
    sourceId,
    title: `kind ${kind} ${sourceId}`,
    descriptionMarkdown: '',
    stateSourceId: 'task',
    labelSourceIds: [],
    typeSourceId: kind,
    cycleSourceId: null,
    parentSourceId: null,
    assigneeEmail: null,
    watcherEmails: [],
    customFields: [],
    sequenceId: kind === 'epic' ? 9001 : 9002,
    priority: null,
    startDate: null,
    dueDate: null,
    estimatePoints: null,
    estimateMinutes: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    archivedAt: null,
  } as CanonicalIssue;
}

function bdStyleReader(): SourceReader {
  return {
    getIssue: async (sourceId: string) =>
      canonicalIssue(sourceId, sourceId === 'bd-epic-1' ? 'epic' : 'task'),
    listIssues: async () => ({
      items: [canonicalIssue('bd-epic-1', 'epic'), canonicalIssue('bd-task-1', 'task')],
      cursor: null,
    }),
    listStates: async () => [],
    listLabels: async () => [],
    listCycles: async () => [],
    listCustomFields: async () => [],
    // The bd reader serves these from the ONE whole-board export: the exact
    // source kind names, machine-bound, never translated.
    listIssueTypes: async () => [
      { sourceId: 'epic', name: 'epic' },
      { sourceId: 'task', name: 'task' },
    ],
    listIssueComments: async (): Promise<CanonicalComment[]> => [],
    listIssueAttachments: async (): Promise<CanonicalAttachment[]> => [],
    listIssueChecklists: async (): Promise<CanonicalChecklist[]> => [],
    listIssueWorklogs: async () => [],
  } as unknown as SourceReader;
}

const job: ClaimedImportJob = {
  id: 1,
  projectId: 7,
  source: 'bd',
  phase: 'create',
  status: 'running',
  config: {},
  cursor: {},
  attempts: 1,
  credentialCiphertext: null,
  credentialIv: null,
  credentialAuthTag: null,
};

afterEach(() => {
  capturing = false;
  captured.types.length = 0;
  captured.issues.length = 0;
});

describe('the real Create phase materializes the bd source kind NATIVELY (not artifact-only)', () => {
  it('materializes the exact source kind names and binds each issue to its exact-name type row', async () => {
    capturing = true;
    try {
      await runCreate(job, bdStyleReader());
    } finally {
      capturing = false;
    }

    // 1. The pipeline MATERIALIZED the kinds natively, through the existing
    // createLocalIssueTypeAndRecord seam, with the EXACT source names - this
    // is what gives the 124 epics their native epic readiness later; the
    // artifact receipt alone could never do it.
    expect(captured.types).toEqual(
      expect.arrayContaining([
        { sourceId: 'epic', name: 'epic' },
        { sourceId: 'task', name: 'task' },
      ]),
    );

    // 2. Each issue's Create bound its type_id to the EXACT-name record: the
    // imported epic is the epic row (100), the task the task row (101) -
    // never a default, never swapped.
    const epic = captured.issues.find((i) => i.sourceId === 'bd-epic-1')!;
    const task = captured.issues.find((i) => i.sourceId === 'bd-task-1')!;
    expect(epic.typeId).toBe(100);
    expect(task.typeId).toBe(101);
    expect(epic.typeId).not.toBe(task.typeId);
  });
});
