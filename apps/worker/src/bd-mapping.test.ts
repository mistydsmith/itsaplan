import { describe, expect, test } from 'bun:test';
import { mapBdSource, prefixedTitle, type BdCardView, type BdRetainedTitle } from './bd-mapping';

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
// Every fixture card on this board carries the trusted rig prefix, exactly the
// real shape: map() binds it, and the mapping fails without it.
const RIG = 'sentinel-prod';
const map = (cards: BdCardView[], over: { maxDepth?: number; rigPrefix?: string } = {}) =>
  mapBdSource(cards, { rigPrefix: RIG, ...over });

describe('mapBdSource', () => {
  test('every source status gets its own named state; coarse category only', () => {
    const statuses = ['open', 'queued', 'in_progress', 'blocked', 'review', 'deferred', 'closed'];
    const snap = map(
      statuses.map((s, i) => card({ id: `sentinel-prod-9001.${i + 1}`, status: s })),
    );
    expect(snap.states).toEqual([
      { sourceId: 'status:blocked', name: 'Blocked', category: 'started' },
      { sourceId: 'status:closed', name: 'Closed', category: 'completed' },
      { sourceId: 'status:deferred', name: 'Deferred', category: 'backlog' },
      { sourceId: 'status:in_progress', name: 'In Progress', category: 'started' },
      { sourceId: 'status:open', name: 'Open', category: 'unstarted' },
      { sourceId: 'status:queued', name: 'Queued', category: 'backlog' },
      { sourceId: 'status:review', name: 'Review', category: 'started' },
    ]);
    // No folding: the blocked card sits in the named Blocked state.
    const blocked = snap.issues.find((i) => i.sourceId === 'sentinel-prod-9001.4')!;
    expect(blocked.stateSourceId).toBe('status:blocked');
  });

  test('an unknown status keeps its own named state and a retained note', () => {
    const snap = map([card({ id: 'sentinel-prod-9002.1', status: 'spiked' })]);
    expect(snap.states).toEqual([
      { sourceId: 'status:spiked', name: 'spiked', category: 'unstarted' },
    ]);
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-9002.1',
      field: 'status',
      value: 'spiked',
      retention: 'unmapped_report',
      note: 'unknown bd status kept as its own named state (category unstarted)',
    });
  });

  test('EVERY issue_type is a native issue: feature/chore/molecule/spike/event/merge-request/closed are never retained (Root P0)', () => {
    // The old task/bug/epic/decision ticket set wrongly retained 333 real
    // issues as non-tickets on the measured board (feature 284, chore 33,
    // molecule 7, spike 5, event 3, merge-request 1). The contract: every
    // _type:'issue' record is an issue, regardless of issue_type - and the
    // mapper's retained port stays EMPTY (the Dolt memories are not beads and
    // never ride it; they are memory:<key> rows on the reader).
    const types = [
      'task',
      'bug',
      'epic',
      'decision',
      'feature',
      'chore',
      'molecule',
      'spike',
      'event',
      'merge-request',
    ];
    const cards = types.map((t, i) =>
      card({ id: `sentinel-prod-9012.${i + 1}`, issue_type: t, status: 'closed' }),
    );
    const snap = map(cards);
    expect(snap.issues).toHaveLength(types.length);
    expect(snap.retained).toEqual([]);
    // All closed, all present: the state set carries closed once.
    expect(snap.states).toEqual([
      { sourceId: 'status:closed', name: 'Closed', category: 'completed' },
    ]);
  });

  test('a dependency onto an ABSENT row is retained, not dropped silently', () => {
    const dep = {
      issue_id: 'sentinel-prod-9004.1',
      depends_on_id: 'sentinel-prod-9004.2',
      type: 'blocks',
    };
    const snap = map([card({ id: 'sentinel-prod-9004.1', dependencies: [dep] })]);
    // No native edge can name the absent row; the RAW edge is retained
    // verbatim on the child card's unmapped port (never silently dropped).
    expect(snap.relations).toEqual([]);
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-9004.1',
      field: 'dependency:blocks',
      value: JSON.stringify(dep),
      retention: 'unmapped_report',
      note: 'raw source dependency edge, retained verbatim in the ticket metadata',
    });
  });

  test('dotted nesting nests to the tree owner cap; past it the edge stays explicit', () => {
    const chain = [
      'sentinel-prod-8441',
      'sentinel-prod-8441.1',
      'sentinel-prod-8441.1.1',
      'sentinel-prod-8441.1.1.1',
      'sentinel-prod-8441.1.1.1.1',
      'sentinel-prod-8441.1.1.1.1.1',
    ];
    // The ACTUAL edges are authoritative: every child carries the explicit
    // parent-child edge the measured board exports (issue_id = child).
    const withEdges = chain.map((id, i) =>
      card({
        id,
        dependencies: i
          ? [{ issue_id: id, depends_on_id: chain[i - 1], type: 'parent-child' }]
          : [],
      }),
    );
    const snap = map(withEdges);
    // Depth 3 of 8: the explicit parent-child edge is the native parent.
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-8441.1.1')!.parentSourceId).toBe(
      'sentinel-prod-8441.1',
    );
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-8441')!.parentSourceId).toBeNull();

    // A dotted card with NO explicit parent edge keeps its dotted token
    // unchanged and its native parent null - the decimal inference is gone
    // (Root P0: 3,114/5,407 invented parents on the measured board).
    const noEdge = map([
      card({ id: 'sentinel-prod-8441.1.1' }),
      card({ id: 'sentinel-prod-8441.1' }),
    ]);
    expect(noEdge.issues.find((i) => i.sourceId === 'sentinel-prod-8441.1.1')!.parentSourceId).toBe(
      null,
    );
    expect(noEdge.relations).toEqual([]);

    // maxDepth 2: the explicit parent edge past the cap is never dropped or
    // flattened - it becomes an explicit relates edge + retained note.
    const shallow = map(withEdges, { maxDepth: 2 });
    const level3 = shallow.issues.find((i) => i.sourceId === 'sentinel-prod-8441.1.1')!;
    expect(level3.parentSourceId).toBeNull();
    expect(shallow.relations).toContainEqual({
      kind: 'relates',
      sourceIssueSourceId: 'sentinel-prod-8441.1',
      targetIssueSourceId: 'sentinel-prod-8441.1.1',
    });
    expect(shallow.unmapped).toContainEqual({
      bdId: 'sentinel-prod-8441.1.1',
      field: 'parent',
      value: 'sentinel-prod-8441.1',
      retention: 'relates_edge',
      note: 'explicit parent edge is past max depth 2; kept as an explicit relates edge',
    });
    // Depth 2 is still plain nesting at maxDepth 2 (explicit parent, within cap).
    expect(shallow.issues.find((i) => i.sourceId === 'sentinel-prod-8441.1')!.parentSourceId).toBe(
      'sentinel-prod-8441',
    );
  });

  test('a level-9 card is over the default cap of 8 and keeps an explicit edge', () => {
    const nine = [
      'sentinel-prod-1',
      'sentinel-prod-1.1',
      'sentinel-prod-1.1.1',
      'sentinel-prod-1.1.1.1',
      'sentinel-prod-1.1.1.1.1',
      'sentinel-prod-1.1.1.1.1.1',
      'sentinel-prod-1.1.1.1.1.1.1',
      'sentinel-prod-1.1.1.1.1.1.1.1',
      'sentinel-prod-1.1.1.1.1.1.1.1.1',
    ];
    // Explicit parent-child chain: the measured board exports these edges.
    const snap = map(
      nine.map((id, i) =>
        card({
          id,
          dependencies: i
            ? [{ issue_id: id, depends_on_id: nine[i - 1], type: 'parent-child' }]
            : [],
        }),
      ),
    );
    const level9 = snap.issues.find((i) => i.sourceId === nine[8])!;
    expect(level9.parentSourceId).toBeNull();
    expect(snap.relations).toContainEqual({
      kind: 'relates',
      sourceIssueSourceId: nine[7],
      targetIssueSourceId: nine[8],
    });
  });

  test('a measured blocks edge becomes a blocks relation naming the blocker first (bd 1.3.1 orientation)', () => {
    // bd 1.3.1: `bd dep add <issue> <depends-on-id>` stores type 'blocks' with
    // issue_id = the blocked issue and depends_on_id = the blocker. The
    // native edge points blocker -> blocked.
    const snap = map([
      card({
        id: 'sentinel-prod-9005.1',
        status: 'blocked',
        dependencies: [
          {
            issue_id: 'sentinel-prod-9005.1',
            depends_on_id: 'sentinel-prod-9005.2',
            type: 'blocks',
          },
        ],
      }),
      card({ id: 'sentinel-prod-9005.2', status: 'in_progress' }),
    ]);
    expect(snap.relations).toEqual([
      {
        kind: 'blocks',
        sourceIssueSourceId: 'sentinel-prod-9005.2',
        targetIssueSourceId: 'sentinel-prod-9005.1',
      },
    ]);
  });

  test('a legacy blocked_by string is NOT a measured kind: raw retention only, never guessed', () => {
    // bd 1.3.1 exports type 'blocks', not 'blocked_by'. The old permissive
    // fallback silently dropped every edge of the other 7 kinds; an unknown
    // kind now gets a verbatim raw retention entry and no native edge.
    const dep = {
      issue_id: 'sentinel-prod-9006.1',
      depends_on_id: 'sentinel-prod-9006.2',
      type: 'blocked_by',
    };
    const snap = map([
      card({ id: 'sentinel-prod-9006.1', dependencies: [dep] }),
      card({ id: 'sentinel-prod-9006.2' }),
    ]);
    expect(snap.relations).toEqual([]);
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-9006.1',
      field: 'dependency:blocked_by',
      value: JSON.stringify(dep),
      retention: 'unmapped_report',
      note: 'raw kind blocked_by is not in the measured set; retained raw, never projected and never dropped',
    });
  });

  test('priority maps 0..3 and retains the rest; assignee tokens are retained', () => {
    const snap = map([
      card({ id: 'sentinel-prod-9006.1', priority: 0, assignee: 'qwen' }),
      card({ id: 'sentinel-prod-9006.2', priority: 4 }),
    ]);
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-9006.1')!.priority).toBe('urgent');
    expect(
      snap.issues.find((i) => i.sourceId === 'sentinel-prod-9006.1')!.assigneeEmail,
    ).toBeNull();
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-9006.2')!.priority).toBeNull();
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-9006.1',
      field: 'assignee',
      value: 'qwen',
      retention: 'unmapped_report',
      note: 'bd assignee token is not a project-member email; retained for reconciliation',
    });
    expect(snap.unmapped).toContainEqual({
      bdId: 'sentinel-prod-9006.2',
      field: 'priority',
      value: '4',
      retention: 'unmapped_report',
      note: 'bd priority outside 0..3; retained for reconciliation',
    });
  });

  test('sequenceId is the numeric head so Rewrite can resolve cross-references', () => {
    const snap = map([card({ id: 'sentinel-prod-8363.1' })]);
    expect(snap.issues[0].sequenceId).toBe(8363);
    expect(snap.issues[0].title).toBe('8363.1: card sentinel-prod-8363.1');
    expect(snap.retainedTitles).toEqual([
      {
        sourceId: 'sentinel-prod-8363.1',
        originalTitle: 'card sentinel-prod-8363.1',
        alreadyPrefixed: false,
      },
    ]);
  });

  test('the title carries exactly one token prefix and the original is retained', () => {
    const snap = map([
      card({ id: 'sentinel-prod-9009.1', title: 'plain card' }),
      card({ id: 'sentinel-prod-9009.2', title: '9009.2: already prefixed' }),
    ]);
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-9009.1')!.title).toBe(
      '9009.1: plain card',
    );
    // No double prefix on a title that already carries the exact canonical form.
    expect(snap.issues.find((i) => i.sourceId === 'sentinel-prod-9009.2')!.title).toBe(
      '9009.2: already prefixed',
    );
    expect(snap.retainedTitles).toEqual([
      { sourceId: 'sentinel-prod-9009.1', originalTitle: 'plain card', alreadyPrefixed: false },
      {
        sourceId: 'sentinel-prod-9009.2',
        originalTitle: '9009.2: already prefixed',
        alreadyPrefixed: true,
      },
    ]);
    // The pure helper is what the mapping uses, and it never mutates its input title.
    const out: BdRetainedTitle[] = [];
    const plain = 'before';
    expect(prefixedTitle('sentinel-prod-7', '7', plain, out)).toBe('7: before');
    expect(plain).toBe('before');
    expect(out).toEqual([
      { sourceId: 'sentinel-prod-7', originalTitle: 'before', alreadyPrefixed: false },
    ]);
  });

  test('the snapshot is deterministic for the same board state', () => {
    const cards = [
      card({ id: 'sentinel-prod-9007.1', status: 'queued', labels: ['b'] }),
      card({ id: 'sentinel-prod-9007.2', status: 'open', labels: ['a'] }),
      card({ id: 'sentinel-prod-9007.1.1' }),
      card({ id: 'sentinel-prod-9007.3', issue_type: 'memory' }),
    ];
    const a = map(cards);
    const b = map([...cards].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
