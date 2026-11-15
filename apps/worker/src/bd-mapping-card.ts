// The per-card half of the bd mapper (split out of bd-mapping.ts, Root P0
// 2026-11-15: new leaves stay under the 400-line cap, split by actual
// responsibility, no chain of shims). bd-mapping.ts keeps the snapshot
// orchestration, the views and the token/title contracts; this leaf owns the
// three per-card derivations mapBdSource used to do inline:
//
//   - collectBdCardUnmapped: the source fields with no target column ride the
//     unmapped sink verbatim (assignee/owner tokens, off-scale priority,
//     unknown status, raw notes/owner content - Root P0: preserve raw
//     fields);
//   - mapBdCard: one card's canonical issue - parent edge with the depth-cap
//     retention rule, the numeric sequence root from the LOCAL token, the
//     exact source issue kind (8429 R1), the identity-owner title contract;
//   - collectBdDependencyEdges: the blocked_by/related edges, deduped, with
//     absent-target retention.
//
// The behavior is exactly the former inline logic: same push order, same
// values, same refusal. The context carries the shared accumulators the
// orchestrator owns, so the orchestrator keeps single ownership of the
// snapshot arrays and the stable sorts.
import type { CanonicalIssue, CanonicalRelation } from './canonical';
import type { BdCardView, BdRetainedTitle, BdUnmappedField } from './bd-mapping';
import type { BdParentSelection } from './bd-mapping-edges';
import {
  bdPairKey,
  mapBdEdgeRelations,
  pushBdNativeRelation,
  type BdEdgeSinks,
} from './bd-mapping-edges';
import { PRIORITY_BY_LEVEL, STATUS_CATEGORY, bdLocalToken, iso, prefixedTitle } from './bd-mapping';

// The shared accumulators the orchestrator passes in: the per-card derivations
// append here exactly where the old inline loop did.
export interface BdCardContext {
  rigPrefix: string;
  maxDepth: number;
  byId: Map<string, BdCardView>;
  // The explicit-edge parent selection (selectBdParents): the ONLY source of a
  // native parent. No decimal inference (Root ruling 2026-11-15).
  parents: Map<string, BdParentSelection>;
  relations: CanonicalRelation[];
  unmapped: BdUnmappedField[];
  retainedTitles: BdRetainedTitle[];
  // Per-pair projection counts shared with the edge collector (unordered
  // pair + kind), so the cap-relates rows and the raw-edge projections
  // dedupe against the SAME native links (Root preflight control 2026-11-15).
  pairProjections: Record<string, number>;
  // Raw blocks edges per ORDERED pair ("a blocks b"): the mutual-blocks pass
  // (CT 2026-11-15 E2) withholds the native edge when both directions exist.
  blockDirections: Record<string, number>;
}

// The unmapped source-field sink, one pass over the cards (the same pass and
// order the old mapper used).
export function collectBdCardUnmapped(cards: BdCardView[], out: BdUnmappedField[]): void {
  for (const card of cards) {
    // Assignees are bd lane/user tokens, not project-member emails; the
    // pipeline only links authors it can match, so the token is retained for
    // reconciliation instead of being dropped.
    if (card.assignee) {
      out.push({
        bdId: card.id,
        field: 'assignee',
        value: card.assignee,
        retention: 'unmapped_report',
        note: 'bd assignee token is not a project-member email; retained for reconciliation',
      });
    }
    if (card.priority != null && PRIORITY_BY_LEVEL[card.priority] == null) {
      out.push({
        bdId: card.id,
        field: 'priority',
        value: String(card.priority),
        retention: 'unmapped_report',
        note: 'bd priority outside 0..3; retained for reconciliation',
      });
    }
    if (!STATUS_CATEGORY[card.status]) {
      out.push({
        bdId: card.id,
        field: 'status',
        value: card.status,
        retention: 'unmapped_report',
        note: 'unknown bd status kept as its own named state (category unstarted)',
      });
    }
    // The export's own source fields beyond the card headline ride the sink
    // verbatim (Root P0 2026-11-15: preserve raw notes/unknown fields). notes
    // can be huge (143KB measured) - it is content, carried whole.
    if (card.notes) {
      out.push({
        bdId: card.id,
        field: 'notes',
        value: card.notes,
        retention: 'unmapped_report',
        note: 'bd notes field has no target column; carried verbatim',
      });
    }
    if (card.owner) {
      out.push({
        bdId: card.id,
        field: 'owner',
        value: card.owner,
        retention: 'unmapped_report',
        note: 'bd owner token is not a project-member email; retained for reconciliation',
      });
    }
  }
}

// One card's canonical issue. The native parent comes from the EXPLICIT
// parent-child edge the source stored (the single-parent selection in
// selectBdParents): an absent parent is retained unmapped; a parent past the
// tree cap stays an explicit relates edge plus a retained note. NO decimal
// inference: a dotted card with no explicit parent keeps parentSourceId null
// and its dotted identity token unchanged (Root ruling 2026-11-15).
export function mapBdCard(card: BdCardView, ctx: BdCardContext): CanonicalIssue {
  const { rigPrefix, maxDepth, byId, unmapped, retainedTitles, parents } = ctx;
  const parent = parents.get(card.id)?.parentSourceId ?? null;
  // The tree-cap check walks the EXPLICIT parent graph (the selection's
  // graph depth), never the dotted-id count (Root preflight control
  // 2026-11-15): a card whose explicit chain is shallow nests even when its
  // dotted id is deep, and a shallow dotted id with a deep explicit chain
  // is held at the cap.
  const graphDepth = parents.get(card.id)?.depth ?? 1;
  let parentSourceId: string | null = null;
  if (parent != null) {
    if (!byId.has(parent)) {
      unmapped.push({
        bdId: card.id,
        field: 'parent',
        value: parent,
        retention: 'unmapped_report',
        note: 'explicit parent id is absent from the source snapshot; edge retained',
      });
    } else if (graphDepth <= maxDepth) {
      parentSourceId = parent;
    } else {
      // Past the tree owner's cap: the edge is never dropped or flattened.
      // It stays an explicit relation plus a retained note, deduped by the
      // unordered pair + kind like every other native link.
      parentSourceId = null;
      pushBdNativeRelation(ctx, 'relates', parent, card.id, byId);
      unmapped.push({
        bdId: card.id,
        field: 'parent',
        value: parent,
        retention: 'relates_edge',
        note: `explicit parent edge is past max depth ${maxDepth}; kept as an explicit relates edge`,
      });
    }
  }

  return {
    sourceId: card.id,
    // The source's own human-readable number, from the card's LOCAL token: a
    // real bd id is <rig>-<token> (sentinel-prod-8363.1), so the root is 8363,
    // not the 0 that Number('sentinel-prod-8363') returns. Rewrite resolves
    // cross- references like "8363.1" with it. A hash token has no
    // human-readable number and keeps 0 (cross-refs are dotted numerics).
    sequenceId: (() => {
      const token = bdLocalToken(rigPrefix, card.id);
      return Number(token.split('.').shift()) || 0;
    })(),
    // Root native-READY ruling (8429 R1, 2026-11-15): the import MUST
    // preserve the OPERATIONAL issue kind, not only the artifact. The exact
    // source issue_type name is machine-bound by the actual input - never a
    // translated UI guess: an epic stays 'epic', never defaulted to task.
    // The worker's existing seam materializes this exact name into the
    // native issue_type table and sets issue.type_id.
    typeSourceId: card.issue_type,
    // The gated identity owner (tools/tracker_rule_identity.py _title_matches)
    // requires the title to begin with the card's LOCAL token and a separator:
    // the owner strips the rig prefix from the bead id before checking the
    // title, so a title prefixed with the FULL bd id is refused for every
    // later update - and after the identity attach the native title is
    // uneditable, so the prefix must be right at import. One prefix only - a
    // title that already carries it is kept as-is, so a re-import never
    // double-prefixes - and the original text is retained in retainedTitles
    // for reconciliation (the full source id stays in sourceId).
    title: prefixedTitle(card.id, bdLocalToken(rigPrefix, card.id), card.title, retainedTitles),
    descriptionMarkdown: card.description ?? '',
    stateSourceId: `status:${card.status}`,
    assigneeEmail: null,
    watcherEmails: [],
    labelSourceIds: (card.labels ?? []).map((l) => `label:${l}`),
    cycleSourceId: null,
    parentSourceId,
    priority: card.priority != null ? (PRIORITY_BY_LEVEL[card.priority] ?? null) : null,
    startDate: null,
    dueDate: null,
    customFields: [],
    createdAt: iso(card.created_at),
    updatedAt: iso(card.updated_at),
    archivedAt: null,
  };
}

// The dependency edges: blocked_by stored on the blocked card becomes a
// canonical 'blocks' relation naming the blocker first; 'related' stays a
// plain edge. Deduped per (kind, source, target); an edge onto an absent row
// is retained, not dropped.
// Project EVERY stored dependency edge (Root P0 2026-11-15: the old collector
// only accepted blocked_by/related and silently dropped the other six kinds -
// 2,140 blocks, 5,407 parent-child, ...). The pure contract lives in
// bd-mapping-edges.ts: native blocks/relates/duplicates with the bd 1.3.1
// orientation, the Root-authorized relates projection for
// discovered-from/supersedes, raw retention of every edge, and the withheld-
// parent dispositions. This function is the thin wiring into the card ctx.
// The named unsupported disposition of a mutual blocks pair (CT 2026-11-15
// E2): the unordered pair + the raw blocks edges that sit on it in BOTH
// directions. The native blocks edge is withheld and the pair stays visible
// as relates; every raw fact remains retained on both cards.
export interface BdMutualBlockPair {
  pair: [string, string]; // sorted
  rawEdgeCount: number;
}

// The mutual-blocks pass (CT 2026-11-15 E2). A blocks pair whose raw edges
// run in BOTH directions cannot merge into one native edge: the issue_link
// store is unordered, so the surviving direction would silently drop the
// other side's readiness. The native blocks edge is WITHHELD (neither
// direction is "the" edge), the pair stays visible as a native relates (the
// same withhold-and-relates pattern the parent ruling uses for multi/cycle),
// and the pair gets the named `mutual-blocks` disposition with its raw count.
// Every raw edge stays retained on both cards' unmapped ports either way.
export function resolveBdMutualBlocks(
  sinks: Pick<BdEdgeSinks, 'relations' | 'blockDirections'>,
): BdMutualBlockPair[] {
  const out: BdMutualBlockPair[] = [];
  const mutualPairs = new Set<string>();
  for (const dir of Object.keys(sinks.blockDirections)) {
    const count = sinks.blockDirections[dir]!;
    if (count <= 0) continue;
    const eq = dir.lastIndexOf('=');
    const pairKey = dir.slice(0, eq); // blocks:a::b (sorted)
    const arrow = dir.lastIndexOf('>');
    const a = dir.slice(eq + 1, arrow);
    const b = dir.slice(arrow + 1);
    const opposite = `${pairKey}=${b}>${a}`;
    if ((sinks.blockDirections[opposite] ?? 0) > 0) mutualPairs.add(pairKey);
  }
  if (mutualPairs.size === 0) return out;
  for (const pairKey of mutualPairs) {
    const sep = pairKey.indexOf(':');
    const body = pairKey.slice(sep + 1);
    const [x, y] = body.split('::');
    const pair: [string, string] = [x!, y!];
    // Withhold the native blocks edge (both directions present: merging
    // would lose one side's readiness).
    for (let i = sinks.relations.length - 1; i >= 0; i--) {
      const r = sinks.relations[i]!;
      if (
        r.kind === 'blocks' &&
        bdPairKey('blocks', r.sourceIssueSourceId, r.targetIssueSourceId) === pairKey
      ) {
        sinks.relations.splice(i, 1);
      }
    }
    // Keep the pair visible natively as relates (no readiness claim).
    const relatesKey = bdPairKey('relates', pair[0]!, pair[1]!);
    if (
      !sinks.relations.some(
        (r) => bdPairKey(r.kind, r.sourceIssueSourceId, r.targetIssueSourceId) === relatesKey,
      )
    ) {
      sinks.relations.push({
        kind: 'relates',
        sourceIssueSourceId: pair[0]!,
        targetIssueSourceId: pair[1]!,
      });
    }
    const rawEdgeCount =
      (sinks.blockDirections[`${pairKey}=${pair[0]}>${pair[1]}`] ?? 0) +
      (sinks.blockDirections[`${pairKey}=${pair[1]}>${pair[0]}`] ?? 0);
    out.push({ pair, rawEdgeCount });
  }
  out.sort((p, q) => p.pair[0]!.localeCompare(q.pair[0]!) || p.pair[1]!.localeCompare(q.pair[1]!));
  return out;
}

export function collectBdDependencyEdges(
  cards: BdCardView[],
  byId: Map<string, BdCardView>,
  ctx: Pick<
    BdCardContext,
    'relations' | 'unmapped' | 'parents' | 'pairProjections' | 'blockDirections'
  >,
): void {
  mapBdEdgeRelations(cards, byId, ctx.parents, {
    relations: ctx.relations,
    unmapped: ctx.unmapped,
    pairProjections: ctx.pairProjections,
    blockDirections: ctx.blockDirections,
  });
}
