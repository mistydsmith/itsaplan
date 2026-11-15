import { describe, expect, test } from 'bun:test';
import {
  mapBdSource,
  type BdCardView,
  type BdDependencyView,
  type BdUnmappedField,
} from './bd-mapping';
import type { CanonicalRelation } from './canonical';
import {
  bdEdgeCounts,
  collectBdParentDispositions,
  formatBdParentPreflight,
  selectBdParents,
} from './bd-mapping-edges';

// Root P0 dependency contract (2026-11-15, msg_7aa859bd5727 + ruling
// msg_ba3d90875534): the mapper-level half of the synthetic edge-kind suite
// (the pure-helper half is bd-mapping-edges.test.ts). Every measured bd 1.3.1
// edge kind through the REAL mapper with the exact native orientation, the
// withhold cases (multi-parent / cycle / self-edge / no-explicit-parent),
// raw retention of every stored edge, and the exact count reconciliation +
// the final-preflight listing. No decimal inference anywhere.

function card(id: string, deps: Array<Partial<BdDependencyView>> = []): BdCardView {
  return {
    id,
    title: `card ${id}`,
    description: '',
    status: 'open',
    priority: null,
    assignee: null,
    issue_type: 'task',
    labels: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    dependencies: deps.map((d) => ({
      issue_id: id,
      depends_on_id: '',
      type: 'parent-child',
      ...d,
    })),
  };
}

const RIG = 'sentinel-prod';
const map = (cards: BdCardView[]) => mapBdSource(cards, { rigPrefix: RIG });
const rel = (
  kind: CanonicalRelation['kind'],
  source: string,
  target: string,
): CanonicalRelation => ({
  kind,
  sourceIssueSourceId: source,
  targetIssueSourceId: target,
});

describe('mapBdSource: the measured edge kinds through the real mapper', () => {
  test('blocks: the blocker is the SOURCE (bd 1.3.1 orientation)', () => {
    const snap = map([
      card('sentinel-prod-10.1', [{ depends_on_id: 'sentinel-prod-10.2', type: 'blocks' }]),
      card('sentinel-prod-10.2'),
    ]);
    expect(snap.relations).toEqual([rel('blocks', 'sentinel-prod-10.2', 'sentinel-prod-10.1')]);
  });

  test('depends-on: the depended-upon card is the SOURCE (same orientation as blocks)', () => {
    const snap = map([
      card('sentinel-prod-11.1', [{ depends_on_id: 'sentinel-prod-11.2', type: 'depends-on' }]),
      card('sentinel-prod-11.2'),
    ]);
    expect(snap.relations).toEqual([rel('blocks', 'sentinel-prod-11.2', 'sentinel-prod-11.1')]);
  });

  test('related and relates-to: symmetric relates edges', () => {
    const snap = map([
      card('sentinel-prod-12.1', [{ depends_on_id: 'sentinel-prod-12.2', type: 'related' }]),
      card('sentinel-prod-12.3', [{ depends_on_id: 'sentinel-prod-12.4', type: 'relates-to' }]),
      card('sentinel-prod-12.2'),
      card('sentinel-prod-12.4'),
    ]);
    expect(snap.relations).toEqual([
      rel('relates', 'sentinel-prod-12.1', 'sentinel-prod-12.2'),
      rel('relates', 'sentinel-prod-12.3', 'sentinel-prod-12.4'),
    ]);
  });

  test('duplicates: native duplicates edge', () => {
    const snap = map([
      card('sentinel-prod-13.1', [{ depends_on_id: 'sentinel-prod-13.2', type: 'duplicates' }]),
      card('sentinel-prod-13.2'),
    ]);
    expect(snap.relations).toEqual([rel('duplicates', 'sentinel-prod-13.1', 'sentinel-prod-13.2')]);
  });

  test('discovered-from and supersedes: explicit relates projection with the raw fact retained', () => {
    const snap = map([
      card('sentinel-prod-14.1', [
        { depends_on_id: 'sentinel-prod-14.2', type: 'discovered-from' },
      ]),
      card('sentinel-prod-14.3', [{ depends_on_id: 'sentinel-prod-14.4', type: 'supersedes' }]),
      card('sentinel-prod-14.2'),
      card('sentinel-prod-14.4'),
    ]);
    expect(snap.relations).toEqual([
      rel('relates', 'sentinel-prod-14.1', 'sentinel-prod-14.2'),
      rel('relates', 'sentinel-prod-14.3', 'sentinel-prod-14.4'),
    ]);
    // The raw kind rides the child card's unmapped port (durable ticket metadata).
    const raw = snap.unmapped.filter(
      (u) => u.field === 'dependency:discovered-from' || u.field === 'dependency:supersedes',
    );
    expect(raw).toHaveLength(2);
    for (const u of raw) {
      expect(u.retention).toBe('unmapped_report');
      expect(u.value).toContain('"type"');
    }
  });

  test('parent-child: the single explicit edge is the native PARENT, and emits no relation row', () => {
    const snap = map([
      card('sentinel-prod-15.1'),
      card('sentinel-prod-15.2', [{ depends_on_id: 'sentinel-prod-15.1' }]),
    ]);
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-15.2')!.parentSourceId).toBe(
      'sentinel-prod-15.1',
    );
    // The parent-child kind never also becomes a relations row for the supported case.
    expect(snap.relations).toEqual([]);
  });

  test('EVERY edge is retained raw on the child card, including the native-projected ones', () => {
    const snap = map([
      card('sentinel-prod-16.1', [{ depends_on_id: 'sentinel-prod-16.2', type: 'blocks' }]),
      card('sentinel-prod-16.2'),
    ]);
    const raw = snap.unmapped.filter((u) => u.field === 'dependency:blocks');
    expect(raw).toHaveLength(1);
    expect(raw[0].bdId).toBe('sentinel-prod-16.1');
    expect(JSON.parse(raw[0].value)).toEqual({
      issue_id: 'sentinel-prod-16.1',
      depends_on_id: 'sentinel-prod-16.2',
      type: 'blocks',
    });
  });

  test('an unknown kind (legacy blocked_by) is raw-only: no native edge, no guess', () => {
    const snap = map([
      card('sentinel-prod-17.1', [{ depends_on_id: 'sentinel-prod-17.2', type: 'blocked_by' }]),
      card('sentinel-prod-17.2'),
    ]);
    expect(snap.relations).toEqual([]);
    const raw = snap.unmapped.filter((u) => u.field === 'dependency:blocked_by');
    expect(raw).toHaveLength(1);
    expect(raw[0].value).toContain('"type":"blocked_by"');
  });

  test('multi-parent: parent withheld, raw edges retained, non-self edges become native relates', () => {
    const snap = map([
      card('sentinel-prod-18.1', [
        { depends_on_id: 'sentinel-prod-18' },
        { depends_on_id: 'sentinel-prod-18.9' },
      ]),
      card('sentinel-prod-18'),
      card('sentinel-prod-18.9'),
    ]);
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-18.1')!.parentSourceId).toBeNull();
    expect(snap.relations).toEqual([
      rel('relates', 'sentinel-prod-18.1', 'sentinel-prod-18'),
      rel('relates', 'sentinel-prod-18.1', 'sentinel-prod-18.9'),
    ]);
    // The explicit disposition rides the card's durable unmapped port.
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-18.1',
      field: 'parent-disposition',
      value: 'multi-parent:sentinel-prod-18,sentinel-prod-18.9',
      retention: 'unmapped_report',
      note: 'multiple explicit parent-child edges; native parent withheld until reviewed, raw edges retained, non-self edges are native relates',
    });
  });

  test('a cycle: loop members withhold their parent, no native edge between them is invented', () => {
    const snap = map([
      card('sentinel-prod-19.1', [{ depends_on_id: 'sentinel-prod-19.2' }]),
      card('sentinel-prod-19.2', [{ depends_on_id: 'sentinel-prod-19.1' }]),
    ]);
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-19.1')!.parentSourceId).toBeNull();
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-19.2')!.parentSourceId).toBeNull();
    // The cycle members' raw parent-child edges are retained (2 raw rows).
    expect(snap.unmapped.filter((u) => u.field === 'dependency:parent-child')).toHaveLength(2);
    for (const d of ['sentinel-prod-19.1', 'sentinel-prod-19.2']) {
      expect(snap.unmapped.some((u) => u.bdId === d && u.field === 'parent-disposition')).toBe(
        true,
      );
    }
  });

  test('a self-edge: raw metadata only, no native edge invented', () => {
    const snap = map([card('sentinel-prod-20.1', [{ depends_on_id: 'sentinel-prod-20.1' }])]);
    expect(snap.relations).toEqual([]);
    expect(snap.issues[0].parentSourceId).toBeNull();
    expect(
      snap.unmapped.some(
        (u) => u.bdId === 'sentinel-prod-20.1' && u.field === 'parent-disposition',
      ),
    ).toBe(true);
  });

  test('an edge whose blocker is ABSENT gets no native edge; the raw entry keeps the fact', () => {
    const snap = map([
      card('sentinel-prod-21.1', [{ depends_on_id: 'sentinel-prod-21.9', type: 'blocks' }]),
    ]);
    expect(snap.relations).toEqual([]);
    expect(snap.unmapped.filter((u) => u.field === 'dependency:blocks')).toHaveLength(1);
  });

  test('edge counts reconcile edge-for-edge: every stored edge counted, every disposition counted', () => {
    const cards = [
      card('sentinel-prod-22.1', [
        { depends_on_id: 'sentinel-prod-22', type: 'parent-child' },
        { depends_on_id: 'sentinel-prod-22.9', type: 'blocks' },
        { depends_on_id: 'sentinel-prod-22.9', type: 'discovered-from' },
        { depends_on_id: 'sentinel-prod-22.8', type: 'blocked_by' },
      ]),
      card('sentinel-prod-22.2', [
        { depends_on_id: 'sentinel-prod-22.1', type: 'parent-child' },
        { depends_on_id: 'sentinel-prod-22.3', type: 'parent-child' },
      ]),
      card('sentinel-prod-22'),
      card('sentinel-prod-22.9'),
      card('sentinel-prod-22.8'),
      card('sentinel-prod-22.3'),
    ];
    const snap = map(cards);
    const counts = bdEdgeCounts(cards, snap.parentSelections);
    expect(counts.edgeKinds).toEqual({
      'parent-child': 3,
      blocks: 1,
      'discovered-from': 1,
      blocked_by: 1,
    });
    // 22.2 has two explicit parents -> multi-parent; 22.1 single; the rest none.
    expect(counts.parentDispositions).toEqual({
      'single-parent': 1,
      'no-explicit-parent': 4,
      'multi-parent': 1,
    });
  });

  test('collectBdParentDispositions lists ONLY the withheld cards (multi/cycle/self), never the default', () => {
    const parents = selectBdParents([
      card('sentinel-prod-23.1', [{ depends_on_id: 'sentinel-prod-23.2' }]),
      card('sentinel-prod-23.2', [{ depends_on_id: 'sentinel-prod-23.3' }]),
      card('sentinel-prod-23.3', [{ depends_on_id: 'sentinel-prod-23.1' }]),
      card('sentinel-prod-23.4'),
    ]);
    const out: BdUnmappedField[] = [];
    collectBdParentDispositions(parents, out);
    const fields = out.map((u: { bdId: string; field: string }) => `${u.bdId}:${u.field}`);
    // The 3-cycle members each get a disposition row; the bare card gets none.
    expect(fields).toHaveLength(3);
    expect(fields.filter((f) => f.endsWith(':parent-disposition'))).toHaveLength(3);
    expect(fields.some((f) => f.startsWith('sentinel-prod-23.4'))).toBe(false);
  });

  test('the preflight listing names every withheld card with its disposition and raw parents; counts cover everything', () => {
    const parents = selectBdParents([
      card('sentinel-prod-24.1', [
        { depends_on_id: 'sentinel-prod-24' },
        { depends_on_id: 'sentinel-prod-24.9' },
      ]),
      card('sentinel-prod-24.2', [{ depends_on_id: 'sentinel-prod-24.2' }]),
      card('sentinel-prod-24.3', [{ depends_on_id: 'sentinel-prod-24.4' }]),
      card('sentinel-prod-24.4', [{ depends_on_id: 'sentinel-prod-24.3' }]),
      card('sentinel-prod-24.5', [{ depends_on_id: 'sentinel-prod-24' }]),
      card('sentinel-prod-24.6'),
      card('sentinel-prod-24'),
      card('sentinel-prod-24.9'),
    ]);
    const { lines, counts, countsLine } = formatBdParentPreflight(parents);
    expect(lines).toEqual([
      'sentinel-prod-24.1: multi-parent (raw parents: sentinel-prod-24, sentinel-prod-24.9) - native parent withheld until reviewed',
      'sentinel-prod-24.2: self-parent (raw parents: sentinel-prod-24.2) - native parent withheld until reviewed',
      'sentinel-prod-24.3: cycle (raw parents: sentinel-prod-24.4) - native parent withheld until reviewed',
      'sentinel-prod-24.4: cycle (raw parents: sentinel-prod-24.3) - native parent withheld until reviewed',
    ]);
    expect(counts).toEqual({
      'multi-parent': 1,
      'self-parent': 1,
      cycle: 2,
      'single-parent': 1,
      'no-explicit-parent': 3,
    });
    // The single-parent and no-explicit-parent cards are never listed.
    expect(lines.join('\n')).not.toContain('sentinel-prod-24.5');
    expect(lines.join('\n')).not.toContain('sentinel-prod-24.6');
    // The disposition summary NAMES every class (the 719 no-explicit-parent
    // default is counted, never silent - Root preflight control 2026-11-15).
    expect(countsLine).toBe(
      'parent dispositions: single-parent 1; no-explicit-parent 3; multi-parent 1; cycle 2; self-parent 1',
    );
  });

  test('opposite-direction relates edges MERGE into one native link with the per-pair projection count (unordered pair + kind)', () => {
    // issue_link uniqueness is the unordered pair + kind: A relates B stored
    // on A AND B relates A stored on B are the SAME native link. One row,
    // count 2 - never two rows, never a false one-native-per-raw claim.
    const snap = map([
      card('sentinel-prod-25.1', [{ depends_on_id: 'sentinel-prod-25.2', type: 'relates-to' }]),
      card('sentinel-prod-25.2', [{ depends_on_id: 'sentinel-prod-25.1', type: 'related' }]),
    ]);
    expect(snap.relations).toEqual([rel('relates', 'sentinel-prod-25.1', 'sentinel-prod-25.2')]);
    expect(snap.edgeCounts.pairProjections).toEqual({
      'relates:sentinel-prod-25.1::sentinel-prod-25.2': 2,
    });
    // Both raw edges stay in the durable ticket metadata (one per child).
    expect(snap.unmapped.filter((u) => u.field.startsWith('dependency:'))).toHaveLength(2);
  });

  test('a mutual blocks pair (both raw directions) is WITHHELD: no native blocks row, the pair stays visible as relates, and the named disposition counts both raw edges', () => {
    const snap = map([
      card('sentinel-prod-26.1', [{ depends_on_id: 'sentinel-prod-26.2', type: 'blocks' }]),
      card('sentinel-prod-26.2', [{ depends_on_id: 'sentinel-prod-26.1', type: 'blocks' }]),
    ]);
    // CT 2026-11-15 E2: the unordered native pair cannot merge - one surviving
    // direction would silently drop the other side's readiness. The native
    // blocks edge is withheld (neither direction is "the" edge), the pair is
    // kept visible as relates, and the named mutual-blocks disposition rides
    // the retained port with its raw count. The raw side keeps BOTH stored
    // edges either way.
    expect(snap.relations).toEqual([rel('relates', 'sentinel-prod-26.1', 'sentinel-prod-26.2')]);
    expect(snap.edgeCounts.pairProjections).toEqual({
      'blocks:sentinel-prod-26.1::sentinel-prod-26.2': 2,
    });
    expect(snap.edgeCounts.mutualBlocks).toEqual([
      { pair: ['sentinel-prod-26.1', 'sentinel-prod-26.2'], rawEdgeCount: 2 },
    ]);
    expect(snap.unmapped.filter((u) => u.field === 'dependency:blocks')).toHaveLength(2);
    const disp = snap.unmapped.filter((u) => u.field === 'edge-disposition:mutual-blocks');
    expect(disp).toHaveLength(1);
    expect(disp[0]!.value).toBe('sentinel-prod-26.1::sentinel-prod-26.2:2');
  });

  test('two raw blocks edges in the SAME direction are not mutual: the single native blocks row stays and counts both raw edges', () => {
    const snap = map([
      card('sentinel-prod-26.1', [
        { depends_on_id: 'sentinel-prod-26.2', type: 'blocks' },
        { depends_on_id: 'sentinel-prod-26.2', type: 'blocks' },
      ]),
      card('sentinel-prod-26.2'),
    ]);
    expect(snap.relations).toEqual([rel('blocks', 'sentinel-prod-26.2', 'sentinel-prod-26.1')]);
    expect(snap.edgeCounts.mutualBlocks).toEqual([]);
    expect(snap.edgeCounts.pairProjections).toEqual({
      'blocks:sentinel-prod-26.1::sentinel-prod-26.2': 2,
    });
  });

  test('a mutual relates pair (both directions) merges as before: one native row, no disposition', () => {
    const snap = map([
      card('sentinel-prod-27.1', [{ depends_on_id: 'sentinel-prod-27.2', type: 'related' }]),
      card('sentinel-prod-27.2', [{ depends_on_id: 'sentinel-prod-27.1', type: 'related' }]),
    ]);
    expect(snap.relations).toHaveLength(1);
    expect(snap.relations[0]!.kind).toBe('relates');
    expect(snap.edgeCounts.mutualBlocks).toEqual([]);
  });

  test('the graph-depth cap: a deep dotted id with a shallow explicit chain nests; a shallow dotted id with a deep explicit chain is held', () => {
    // maxDepth 3. C's dotted id is depth 5 but its explicit chain is depth 3
    // -> nested. D's dotted id is depth 2 but its explicit chain is depth 4
    // -> held as an explicit relates edge (the cap walks the graph).
    const g = 'sentinel-prod-36.8';
    const f = 'sentinel-prod-36.9';
    const e = 'sentinel-prod-36';
    const c = 'sentinel-prod-30.1.1.1.1'; // explicit chain 30 -> 30.1 -> C: depth 3
    const d = 'sentinel-prod-37.1'; // explicit chain E: depth 4
    const cards = [
      card('sentinel-prod-30'),
      card('sentinel-prod-30.1', [{ depends_on_id: 'sentinel-prod-30' }]),
      card(c, [{ depends_on_id: 'sentinel-prod-30.1' }]),
      card(g),
      card(f, [{ depends_on_id: g }]),
      card(e, [{ depends_on_id: f }]),
      card(d, [{ depends_on_id: e }]),
    ];
    const snap = mapBdSource(cards, { rigPrefix: RIG, maxDepth: 3 });
    expect(snap.issues.find((i) => i.sourceId === c)!.parentSourceId).toBe('sentinel-prod-30.1');
    expect(snap.issues.find((i) => i.sourceId === d)!.parentSourceId).toBeNull();
    expect(snap.relations).toContainEqual(rel('relates', e, d));
  });
});
