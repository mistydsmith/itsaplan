// Shared recording context for the 8428 proof tests: the fake db appends every
// operation here; tests read it to prove what the real code paths wrote.
import { makeFakeDb, type FakeLog } from './fake_db';

export const LOG: FakeLog = { ops: [], rolledBack: false, mode: 'ordinary' };
export const FAKE_DB = makeFakeDb(LOG);

export function resetLog(rig: 'ordinary' | 'gated' = 'ordinary'): void {
  LOG.ops.length = 0;
  LOG.rolledBack = false;
  LOG.mode = rig;
  delete process.env.ITSAPLAN_FAKE_RIG; // mode lives on the fake, not the environment
}

export function stampedReceipts(): Record<string, unknown>[] {
  return LOG.ops
    .filter((o) => o.op === 'insert.values' && o.table === 'issue_activity')
    .flatMap((o) => (Array.isArray(o.values) ? o.values : [o.values]))
    .filter((r) => JSON.stringify(r).includes('anchor_map_stamped')) as Record<string, unknown>[];
}

export function issueInserts(): Record<string, unknown>[] {
  return LOG.ops
    .filter((o) => o.op === 'insert.values' && o.table === 'issue')
    .flatMap((o) => (Array.isArray(o.values) ? o.values : [o.values])) as Record<string, unknown>[];
}
