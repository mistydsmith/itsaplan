// 8363.1 BdReader snapshot single-flight controls (Root FULL_PIPELINE_D2_R1,
// 2026-11-15). PURE - no database, no grant guard, no bd invocation: a fake
// BdCommandRunner stands in for the export and the REAL BdReader does the
// rest. The frozen contract under test: ONE readonly `bd export --all` per
// reader/tick. Before the fix, runDiscover's Promise.all(listStates,
// listLabels, listIssueTypes) saw snapshot===null three times before any
// await resolved and started THREE concurrent exports; these controls prove
// the single-flight promise is shared, that a failed export is evicted (with
// its partial cards/memories reset) so a retry re-exports cleanly, and that
// the one-export assertion was not weakened - the runner's call count is the
// witness.
import { describe, expect, test } from 'bun:test';
import { BdReader, type BdCommandRunner } from '../../bd-adapter';

// A mutable export source: the tests swap the payload between attempts.
function fakeExport(payload: { text: string }) {
  const calls: string[][] = [];
  const run: BdCommandRunner = async (args: string[]) => {
    calls.push(args);
    // Yield a macrotask so concurrent callers genuinely race through
    // loadSnapshot before the first export resolves.
    await new Promise((r) => setTimeout(r, 5));
    return payload.text;
  };
  return { calls, run, payload };
}

const CARD = {
  _type: 'issue',
  id: 'snapboard-1',
  title: 'snapshot control card',
  description: 'body',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-11-15T00:00:00Z',
  updated_at: '2026-11-15T00:00:00Z',
};
const POISON_CARD = { ...CARD, id: 'otherboard-1' }; // foreign prefix: the mapper refuses it
const MEMORY = { _type: 'memory', key: 'k', value: 'v' };
const exportOf = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');

const CONFIG = { boardPath: '/boards/snapboard', maxDepth: Number.POSITIVE_INFINITY };

describe('8363.1 BdReader snapshot single-flight (pure controls)', () => {
  test('three concurrent reader methods share ONE export read', async () => {
    const fx = fakeExport({ text: exportOf(CARD, MEMORY) });
    const reader = new BdReader(CONFIG, fx.run);
    const [states, labels, types] = await Promise.all([
      reader.listStates(),
      reader.listLabels(),
      reader.listIssueTypes(),
    ]);
    expect(fx.calls).toEqual([['bd', 'export', '--all']]); // exactly one, nothing else
    expect(states.map((s) => s.name)).toEqual(['Open']); // the shared snapshot, consistent
    expect(labels).toEqual([]);
    expect(types.map((t) => t.name)).toEqual(['task']);
  });

  test('concurrent callers of a FAILED export all reject on the same single read', async () => {
    const fx = fakeExport({ text: exportOf(CARD, POISON_CARD) });
    const reader = new BdReader(CONFIG, fx.run);
    const results = await Promise.allSettled([reader.listStates(), reader.listLabels()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(
      /does not carry the rig prefix/,
    );
    expect(fx.calls).toHaveLength(1); // the race started ONE export, not two
  });

  test('a failed export is evicted with its partial state, and a retry re-exports', async () => {
    const fx = fakeExport({ text: exportOf(CARD, POISON_CARD, MEMORY) });
    const reader = new BdReader(CONFIG, fx.run);
    await expect(reader.listStates()).rejects.toThrow();
    // The poisoned attempt parsed the valid card and the memory BEFORE the
    // mapper refused the foreign id: if eviction did not reset them, the
    // retry would see a half-filled board. Swap in the clean export and
    // retry on the SAME reader.
    fx.payload.text = exportOf(CARD, MEMORY);
    const states = await reader.listStates();
    expect(states.map((s) => s.name)).toEqual(['Open']);
    expect(fx.calls).toHaveLength(2); // exactly one re-export, no more
    // The poisoned card must NOT survive the eviction in the cards map.
    await expect(reader.listIssueComments('snapboard-1')).resolves.toEqual([]);
    await expect(reader.listIssueComments('otherboard-1')).rejects.toThrow(
      /not in this board snapshot/,
    );
  });

  test('a parse failure (unknown _type) evicts too, before any mutation', async () => {
    const fx = fakeExport({ text: exportOf({ _type: 'bead', id: 'snapboard-9' }) });
    const reader = new BdReader(CONFIG, fx.run);
    await expect(reader.listIssueTypes()).rejects.toThrow(/unknown _type/);
    fx.payload.text = exportOf(CARD);
    const types = await reader.listIssueTypes();
    expect(types.map((t) => t.name)).toEqual(['task']);
    expect(fx.calls).toHaveLength(2);
  });

  test('a second reader still owns its own single export (no cross-reader sharing)', async () => {
    const fx = fakeExport({ text: exportOf(CARD) });
    const a = new BdReader(CONFIG, fx.run);
    const b = new BdReader(CONFIG, fx.run);
    await Promise.all([a.listStates(), b.listStates()]);
    expect(fx.calls).toHaveLength(2); // one per reader - single-flight is per reader/tick
  });
});
