import { describe, expect, test } from 'bun:test';
import { mapBdSource, type BdCardView } from './bd-mapping';

function card(over: Partial<BdCardView> & { id: string }): BdCardView {
  return {
    title: `card ${over.id}`,
    description: '',
    status: 'open',
    priority: null,
    assignee: null,
    issue_type: 'task',
    labels: [],
    dependencies: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    ...over,
  };
}
// Every fixture card on this board carries the trusted rig prefix.
const RIG = 'sentinel-prod';
const map = (cards: BdCardView[], over: { maxDepth?: number; rigPrefix?: string } = {}) =>
  mapBdSource(cards, { rigPrefix: RIG, ...over });

// The full-graph parent-cycle disposition (CT 2026-11-15 E4; Root R1: the
// measured board carries exactly one explicit parent cycle, and it runs
// through a multi-parent card). Split from bd-mapping.test.ts so both stay
// under the 400-line new-leaf cap (test bodies byte-identical).
describe('mapBdSource: the full-graph parent-cycle disposition', () => {
  test('a cycle that runs through a multi-parent card is named and counted once (Root R1 shape)', () => {
    // The measured shape: 1059 names BOTH 1059.35 and another card as parents
    // (multi-parent, native parent withheld), while 1059.35's single explicit
    // parent is 1059 - the loop runs through the multi-parent card and is
    // invisible to the per-card selection.
    const snap = map([
      card({
        id: 'sentinel-prod-1059',
        dependencies: [
          {
            issue_id: 'sentinel-prod-1059',
            depends_on_id: 'sentinel-prod-1059.35',
            type: 'parent-child',
          },
          {
            issue_id: 'sentinel-prod-1059',
            depends_on_id: 'sentinel-prod-1058',
            type: 'parent-child',
          },
        ],
      }),
      card({
        id: 'sentinel-prod-1059.35',
        dependencies: [
          {
            issue_id: 'sentinel-prod-1059.35',
            depends_on_id: 'sentinel-prod-1059',
            type: 'parent-child',
          },
        ],
      }),
      card({ id: 'sentinel-prod-1058' }),
    ]);
    expect(snap.edgeCounts.parentCycles).toEqual([['sentinel-prod-1059', 'sentinel-prod-1059.35']]);
    const disp = snap.unmapped.filter((u) => u.field === 'edge-disposition:parent-cycle');
    expect(disp).toHaveLength(1);
    expect(disp[0]!.value).toBe('sentinel-prod-1059|sentinel-prod-1059.35');
    // Root cycle ruling (2026-11-15 R6): EVERY actual cycle member gets
    // native parent null + the named cycle disposition - 1059.35's own
    // per-card choice would have been single-parent (parent 1059), but the
    // loop is detected on the FULL raw parent graph before any pruning.
    expect(snap.parentSelections.get('sentinel-prod-1059')!.disposition).toBe('cycle');
    expect(snap.parentSelections.get('sentinel-prod-1059')!.parentSourceId).toBeNull();
    expect(snap.parentSelections.get('sentinel-prod-1059')!.rawParents).toEqual([
      'sentinel-prod-1059.35',
      'sentinel-prod-1058',
    ]);
    expect(snap.parentSelections.get('sentinel-prod-1059.35')!.disposition).toBe('cycle');
    expect(snap.parentSelections.get('sentinel-prod-1059.35')!.parentSourceId).toBeNull();
    expect(snap.parentSelections.get('sentinel-prod-1059.35')!.rawParents).toEqual([
      'sentinel-prod-1059',
    ]);
    expect(
      snap.issues.find((i) => i.sourceId === 'sentinel-prod-1059.35')!.parentSourceId,
    ).toBeNull();
    // Both cards' raw parent edges keep their non-self relates projection:
    // 1059's two raw parents (1059.35, 1058) and 1059.35's raw parent (1059)
    // dedupe to TWO native relates pairs; every raw edge stays retained.
    expect(snap.relations.filter((r) => r.kind === 'relates')).toEqual([
      {
        kind: 'relates',
        sourceIssueSourceId: 'sentinel-prod-1059',
        targetIssueSourceId: 'sentinel-prod-1058',
      },
      {
        kind: 'relates',
        sourceIssueSourceId: 'sentinel-prod-1059',
        targetIssueSourceId: 'sentinel-prod-1059.35',
      },
    ]);
    expect(
      snap.edgeCounts.pairProjections['relates:sentinel-prod-1059::sentinel-prod-1059.35'],
    ).toBe(2);
  });

  test('a plain parent chain has no cycle, and a pure single-parent loop is reported once with its own disposition', () => {
    // Plain chain: no cycle at all.
    const chain = map([
      card({ id: 'sentinel-prod-91' }),
      card({
        id: 'sentinel-prod-91.1',
        dependencies: [
          {
            issue_id: 'sentinel-prod-91.1',
            depends_on_id: 'sentinel-prod-91',
            type: 'parent-child',
          },
        ],
      }),
    ]);
    expect(chain.edgeCounts.parentCycles).toEqual([]);
    // Pure single-parent loop A->B->C->A: the per-card selection already
    // reclassifies the loop members as 'cycle'; the full-graph pass names the
    // same ids (one row), never a second cycle.
    const loop = map([
      card({
        id: 'sentinel-prod-92',
        dependencies: [
          { issue_id: 'sentinel-prod-92', depends_on_id: 'sentinel-prod-94', type: 'parent-child' },
        ],
      }),
      card({
        id: 'sentinel-prod-93',
        dependencies: [
          { issue_id: 'sentinel-prod-93', depends_on_id: 'sentinel-prod-92', type: 'parent-child' },
        ],
      }),
      card({
        id: 'sentinel-prod-94',
        dependencies: [
          { issue_id: 'sentinel-prod-94', depends_on_id: 'sentinel-prod-93', type: 'parent-child' },
        ],
      }),
    ]);
    expect(loop.edgeCounts.parentCycles).toEqual([
      ['sentinel-prod-92', 'sentinel-prod-93', 'sentinel-prod-94'],
    ]);
    expect(loop.edgeCounts.parentDispositions['cycle']).toBe(3);
  });
});
