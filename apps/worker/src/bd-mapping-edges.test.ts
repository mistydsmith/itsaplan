import { describe, expect, test } from 'bun:test';
import type { BdCardView, BdDependencyView } from './bd-mapping';
import type { CanonicalRelation } from './canonical';
import type { BdUnmappedField } from './bd-mapping';
import { bdPairKey, mapBdEdgeRelations, nativeEdgeKind, selectBdParents } from './bd-mapping-edges';

// Root P0 dependency contract (2026-11-15, msg_7aa859bd5727 + ruling
// msg_ba3d90875534): the ACTUAL exported edges are authoritative. Synthetic
// fixtures for EVERY measured bd 1.3.1 edge kind (parent-child 5407, blocks
// 2140, discovered-from 732, relates-to 99, supersedes 83, related 29,
// duplicates 3, depends-on 1 on the measured 13,497-issue source), plus the
// withhold cases: multi-parent, cycle, self-edge, and the 719-card
// no-explicit-parent default. No decimal inference anywhere.

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

describe('nativeEdgeKind (the explicit per-kind projection)', () => {
  test('every measured kind projects exactly per the Root ruling; unknown kinds project to nothing', () => {
    // blocks, depends-on -> blocks (the blocker is the source).
    expect(nativeEdgeKind('blocks')).toBe('blocks');
    expect(nativeEdgeKind('depends-on')).toBe('blocks');
    // related, relates-to -> relates.
    expect(nativeEdgeKind('related')).toBe('relates');
    expect(nativeEdgeKind('relates-to')).toBe('relates');
    // duplicates -> duplicates.
    expect(nativeEdgeKind('duplicates')).toBe('duplicates');
    // discovered-from, supersedes -> relates (explicit Root-authorized
    // projection; the raw fact is retained alongside).
    expect(nativeEdgeKind('discovered-from')).toBe('relates');
    expect(nativeEdgeKind('supersedes')).toBe('relates');
    // Unknown kinds (including the legacy 'blocked_by' string) are NEVER
    // projected: raw retention only, never a guess.
    expect(nativeEdgeKind('blocked_by')).toBeNull();
    expect(nativeEdgeKind('parent-child')).toBeNull();
    expect(nativeEdgeKind('')).toBeNull();
  });
});

describe('selectBdParents (explicit edges only, no decimal inference)', () => {
  test('a single explicit parent-child edge IS the native parent (issue_id = child, depends_on_id = parent)', () => {
    const sel = selectBdParents([
      card('sentinel-prod-1'),
      card('sentinel-prod-1.1', [{ depends_on_id: 'sentinel-prod-1' }]),
    ]);
    expect(sel.get('sentinel-prod-1.1')).toEqual({
      cardId: 'sentinel-prod-1.1',
      parentSourceId: 'sentinel-prod-1',
      disposition: 'single-parent',
      rawParents: ['sentinel-prod-1'],
      depth: 2,
    });
    expect(sel.get('sentinel-prod-1')!.disposition).toBe('no-explicit-parent');
    expect(sel.get('sentinel-prod-1')!.depth).toBe(1);
  });

  test('graph depth walks the EXPLICIT parent chain, never the dotted-id count (preflight control)', () => {
    // G has no explicit parent: graph depth 1 (its dotted id is deep, the
    // count is irrelevant).
    const g = 'sentinel-prod-32.8';
    const f = 'sentinel-prod-32.9'; // explicit parent G -> depth 2
    const e = 'sentinel-prod-32'; // explicit parent F -> depth 3 (dotted depth 1!)
    const d = 'sentinel-prod-33.1'; // explicit parent E -> depth 4 (dotted depth 2!)
    const sel = selectBdParents([
      card(g),
      card(f, [{ depends_on_id: g }]),
      card(e, [{ depends_on_id: f }]),
      card(d, [{ depends_on_id: e }]),
    ]);
    expect(sel.get(g)!.depth).toBe(1);
    expect(sel.get(f)!.depth).toBe(2);
    expect(sel.get(e)!.depth).toBe(3);
    expect(sel.get(d)!.depth).toBe(4);
  });

  test('a withheld card and a card with an absent parent are top-level (depth 1)', () => {
    const sel = selectBdParents([
      card('sentinel-prod-34', [
        { depends_on_id: 'sentinel-prod-34.9' },
        { depends_on_id: 'sentinel-prod-34.8' },
      ]), // multi-parent -> withheld
      card('sentinel-prod-35', [{ depends_on_id: 'sentinel-prod-9999' }]), // absent parent
      card('sentinel-prod-34.9'),
      card('sentinel-prod-34.8'),
    ]);
    expect(sel.get('sentinel-prod-34')!.depth).toBe(1);
    expect(sel.get('sentinel-prod-35')!.depth).toBe(1);
  });

  test('a dotted card with no explicit parent keeps parent null (the 719-card default; decimal inference is gone)', () => {
    const sel = selectBdParents([
      card('sentinel-prod-719'),
      card('sentinel-prod-719.1.1.1'),
      card('sentinel-prod-719.2.3.4.5'),
    ]);
    for (const s of sel.values()) {
      expect(s.parentSourceId).toBeNull();
      expect(s.disposition).toBe('no-explicit-parent');
    }
  });

  test("an explicit edge stored on the PARENT (issue_id = parent) is NOT this card's parent", () => {
    // The export stores the edge on the dependent side: issue_id = child.
    // A row with issue_id = the other card is that card's parent edge.
    const sel = selectBdParents([
      card('sentinel-prod-2', [{ issue_id: 'sentinel-prod-3', depends_on_id: 'sentinel-prod-2' }]),
      card('sentinel-prod-3'),
    ]);
    expect(sel.get('sentinel-prod-2')!.disposition).toBe('no-explicit-parent');
    expect(sel.get('sentinel-prod-3')!.disposition).toBe('no-explicit-parent');
  });

  test('multiple explicit parents withhold the native parent; the raw parents are listed', () => {
    const sel = selectBdParents([
      card('sentinel-prod-3.1', [
        { depends_on_id: 'sentinel-prod-3' },
        { depends_on_id: 'sentinel-prod-3.9' },
      ]),
      card('sentinel-prod-3'),
      card('sentinel-prod-3.9'),
    ]);
    const s = sel.get('sentinel-prod-3.1')!;
    expect(s.parentSourceId).toBeNull();
    expect(s.disposition).toBe('multi-parent');
    expect(s.rawParents).toEqual(['sentinel-prod-3', 'sentinel-prod-3.9']);
  });

  test('a self-edge (the card names itself) withholds the native parent; raw metadata only', () => {
    const sel = selectBdParents([card('sentinel-prod-4', [{ depends_on_id: 'sentinel-prod-4' }])]);
    const s = sel.get('sentinel-prod-4')!;
    expect(s.parentSourceId).toBeNull();
    expect(s.disposition).toBe('self-parent');
  });

  test('a parent cycle withholds the loop members; a card hanging off a member keeps nothing ambiguous', () => {
    const sel = selectBdParents([
      card('sentinel-prod-5.1', [{ depends_on_id: 'sentinel-prod-5.2' }]),
      card('sentinel-prod-5.2', [{ depends_on_id: 'sentinel-prod-5.1' }]),
    ]);
    expect(sel.get('sentinel-prod-5.1')!.disposition).toBe('cycle');
    expect(sel.get('sentinel-prod-5.2')!.disposition).toBe('cycle');
    expect(sel.get('sentinel-prod-5.1')!.parentSourceId).toBeNull();
  });

  test('a duplicate explicit parent edge (same parent twice) is ONE parent, not multi-parent', () => {
    const sel = selectBdParents([
      card('sentinel-prod-6.1', [
        { depends_on_id: 'sentinel-prod-6' },
        { depends_on_id: 'sentinel-prod-6' },
      ]),
      card('sentinel-prod-6'),
    ]);
    const s = sel.get('sentinel-prod-6.1')!;
    expect(s.disposition).toBe('single-parent');
    expect(s.parentSourceId).toBe('sentinel-prod-6');
    expect(s.rawParents).toEqual(['sentinel-prod-6']);
  });

  test('a cycle member whose own choice is single-parent is still withheld: full-graph detection before pruning (Root R6 ruling, anonymized measured shape)', () => {
    // The measured shape: M names BOTH C and O as parents (multi-parent),
    // while C's single explicit parent is M - the loop runs through the
    // multi-parent card. C's own per-card choice would be single-parent,
    // but the cycle is detected on the FULL raw parent graph, so C gets
    // native parent null + the named cycle disposition (all raw parents
    // retained).
    const sel = selectBdParents([
      card('sentinel-prod-3059', [
        { depends_on_id: 'sentinel-prod-3059.35' },
        { depends_on_id: 'sentinel-prod-3058' },
      ]),
      card('sentinel-prod-3059.35', [{ depends_on_id: 'sentinel-prod-3059' }]),
      card('sentinel-prod-3058'),
    ]);
    expect(sel.get('sentinel-prod-3059')!.disposition).toBe('cycle');
    expect(sel.get('sentinel-prod-3059')!.parentSourceId).toBeNull();
    expect(sel.get('sentinel-prod-3059')!.rawParents).toEqual([
      'sentinel-prod-3059.35',
      'sentinel-prod-3058',
    ]);
    expect(sel.get('sentinel-prod-3059.35')!.disposition).toBe('cycle');
    expect(sel.get('sentinel-prod-3059.35')!.parentSourceId).toBeNull();
    expect(sel.get('sentinel-prod-3059.35')!.rawParents).toEqual(['sentinel-prod-3059']);
    expect(sel.get('sentinel-prod-3058')!.disposition).toBe('no-explicit-parent');
  });
});

describe('the duplicate contract (bd duplicate <id> --of <canonical>)', () => {
  test('the exported issue_id is the duplicate and depends_on_id the canonical; the native duplicates edge keeps that orientation (Root 2026-11-15, msg_47641ba64daa)', () => {
    // The CLI contract: `bd duplicate <id> --of <canonical>` auto-closes the
    // duplicate with a reference to the canonical. The export stores that as
    // a 'duplicates' dependency row on the duplicate card with
    // issue_id = duplicate, depends_on_id = canonical. The three measured
    // raw edges (ids only, RETAINED_BLOCK_PAIR_PREFLIGHT_R1):
    const raw = [
      { issue_id: 'sentinel-prod-8033', depends_on_id: 'sentinel-prod-7660' },
      { issue_id: 'sentinel-prod-7973', depends_on_id: 'sentinel-prod-6326.2' },
      { issue_id: 'sentinel-prod-6462.15.1', depends_on_id: 'sentinel-prod-6462.15.2' },
    ];
    const cards: BdCardView[] = [
      ...raw.map((e) => card(e.issue_id, [{ depends_on_id: e.depends_on_id, type: 'duplicates' }])),
      ...raw.map((e) => card(e.depends_on_id)),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    const parents = selectBdParents(cards);
    const relations: CanonicalRelation[] = [];
    const unmapped: BdUnmappedField[] = [];
    const sinks = {
      relations,
      unmapped,
      pairProjections: {} as Record<string, number>,
      blockDirections: {} as Record<string, number>,
    };
    mapBdEdgeRelations(cards, byId, parents, sinks);
    // One native duplicates edge per raw edge, source = the duplicate
    // (issue_id), target = the canonical (depends_on_id) - the raw
    // orientation, never flipped.
    for (const e of raw) {
      expect(sinks.relations).toContainEqual({
        kind: 'duplicates',
        sourceIssueSourceId: e.issue_id,
        targetIssueSourceId: e.depends_on_id,
      });
      expect(sinks.relations).not.toContainEqual({
        kind: 'duplicates',
        sourceIssueSourceId: e.depends_on_id,
        targetIssueSourceId: e.issue_id,
      });
      expect(sinks.pairProjections[bdPairKey('duplicates', e.issue_id, e.depends_on_id)]).toBe(1);
      // The raw fact is retained on the duplicate card's unmapped port.
      expect(
        unmapped.some(
          (u) =>
            u.bdId === e.issue_id &&
            u.field === 'dependency:duplicates' &&
            u.value.includes(e.depends_on_id),
        ),
      ).toBe(true);
    }
    expect(sinks.relations.filter((r) => r.kind === 'duplicates')).toHaveLength(3);
  });
});
