// Pure explicit-edge contract for the bd import mapping (Root P0 2026-11-15,
// msg_7aa859bd5727 + ruling msg_ba3d90875534). The measured source (13,497
// issues) carries 9,548 dependency edges across EIGHT kinds: parent-child
// 5407, blocks 2140, discovered-from 732, relates-to 99, supersedes 83,
// related 29, duplicates 3, depends-on 1. The old collector only accepted
// blocked_by/related (29 relations) and the card mapper invented decimal
// parents - 3,114 of the 5,407 explicit parent-child edges disagree with the
// decimal inference. This module is the repair:
//
// - The ACTUAL exported edges are authoritative. The native parent comes from
//   a single explicit parent-child edge: issue_id is the CHILD, depends_on_id
//   is the PARENT (bd stores the edge on the dependent side - bd 1.3.1
//   `bd dep add <issue> <depends-on-id>` means the issue depends on the id).
// - NO decimal inference: a dotted card with no explicit parent keeps its
//   native parent null and its dotted identity token unchanged (719 measured).
// - Multiple explicit parents / cycles / self-edges CANNOT silently pick one
//   or fail the whole import: every raw edge is retained in the ticket's
//   durable metadata, the card gets an explicit disposition, non-self edges
//   become native relates links, and the native parent stays null until
//   reviewed. The final preflight lists those IDs + dispositions.
// - Edge-kind projection (explicit Root-authorized, never a guess):
//     blocks, depends-on  -> native blocks (source = depends_on_id, the
//                            blocker; target = issue_id, the blocked issue)
//     related, relates-to -> native relates
//     duplicates          -> native duplicates
//     discovered-from,
//     supersedes          -> native relates + raw retention (unsupported
//                            native kind, projected explicitly)
//     parent-child        -> the native parent when single; native relates
//                            when unsupported (multi/cycle); self-edges
//                            never pretend a native edge exists
//     anything else       -> raw retention only; unknown kinds are never
//                            projected and never dropped
// - Every stored edge rides the child card's unmapped port (field
//   dependency:<raw-kind>, value the raw edge JSON) so the ticket_metadata
//   retained row preserves it durably under the artifact digest. No ID is
//   ever invented or renamed.

import type { CanonicalRelation } from './canonical';
import type { BdCardView, BdUnmappedField } from './bd-mapping';
import { collectBdParentCycles } from './bd-mapping-cycles';

export type BdParentDisposition =
  'single-parent' | 'no-explicit-parent' | 'multi-parent' | 'self-parent' | 'cycle';

export interface BdParentSelection {
  cardId: string;
  // The native parent: ONLY a single explicit parent-child edge qualifies.
  parentSourceId: string | null;
  disposition: BdParentDisposition;
  // Every explicit parent id the source named for this card, stable order.
  rawParents: string[];
  // The depth in the EXPLICIT parent graph (1 = top-level): 1 + the parent's
  // graph depth for a single parent, and 1 when there is no explicit parent,
  // the parent is absent from the snapshot, or the native parent is withheld
  // (multi/cycle/self - the card sits top-level). The tree-cap check walks
  // this graph, never the dotted-id count (Root preflight control 2026-11-15).
  depth: number;
}

// The explicit parent-child edges of ONE card: the export stores the edge on
// the child, so the card's own dependency rows with issue_id === card.id and
// type 'parent-child' name its parent in depends_on_id.
function explicitParentsOf(card: BdCardView): string[] {
  const out: string[] = [];
  for (const dep of card.dependencies ?? []) {
    if (dep.type === 'parent-child' && dep.issue_id === card.id) out.push(dep.depends_on_id);
  }
  return out;
}

// Select every card's native parent from the explicit edges ONLY (no decimal
// inference). Dispositions: self-parent beats multi/single (the card names
// itself); a single-parent chain that loops is a cycle - only the members of
// the loop are reclassified, a card whose PARENT is in the loop keeps its
// parent (the loop member is a real card; the ambiguity is the member's).
export function selectBdParents(cards: BdCardView[]): Map<string, BdParentSelection> {
  const rawByCard = new Map<string, string[]>();
  for (const card of cards) rawByCard.set(card.id, explicitParentsOf(card));

  // Root cycle ruling (2026-11-15, import_dependency_review_R6): cycle
  // membership is computed on the FULL raw parent graph (every explicit
  // parent-child edge, including the extra rows of multi-parent cards) BEFORE
  // any per-card pruning. Every actual cycle member - not just the members
  // of a pure single-parent loop - gets native parent null + the named
  // 'cycle' disposition, even when its own per-card choice would have been
  // single-parent (measured case: 1059.35, single parent 1059, inside the
  // 1059 <-> 1059.35 loop that runs through multi-parent 1059).
  const cycleMembers = new Set<string>();
  for (const scc of collectBdParentCycles(cards))
    for (const member of scc) cycleMembers.add(member);

  const sel = new Map<string, BdParentSelection>();
  for (const card of cards) {
    const raw = rawByCard.get(card.id) ?? [];
    const distinct = [...new Set(raw)];
    let disposition: BdParentDisposition;
    let parent: string | null = null;
    if (distinct.includes(card.id)) disposition = 'self-parent';
    else if (cycleMembers.has(card.id)) disposition = 'cycle';
    else if (distinct.length === 0) disposition = 'no-explicit-parent';
    else if (distinct.length === 1) {
      disposition = 'single-parent';
      parent = distinct[0];
    } else disposition = 'multi-parent';
    sel.set(card.id, {
      cardId: card.id,
      parentSourceId: parent,
      disposition,
      rawParents: distinct,
      depth: 1,
    });
  }

  // Graph depth (the preflight control: the cap walks the EXPLICIT parent
  // graph, never the dotted-id count). A single-parent card sits one below
  // its parent's graph depth; a parent absent from the snapshot leaves the
  // card parentless (depth 1); withheld cards stay top-level (depth 1).
  const depthOf = new Map<string, number>();
  const walk = (id: string, trail: Set<string>): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 1; // defensive: unreachable after the cycle pass
    trail.add(id);
    const s = sel.get(id);
    let d = 1;
    if (s?.disposition === 'single-parent' && s.parentSourceId) {
      const p = sel.get(s.parentSourceId);
      d = p ? walk(s.parentSourceId, trail) + 1 : 1;
    }
    depthOf.set(id, d);
    return d;
  };
  for (const card of cards) {
    const d = walk(card.id, new Set());
    sel.set(card.id, { ...sel.get(card.id)!, depth: d });
  }
  return sel;
}

// The native projection of a raw edge kind. null = unsupported natively:
// raw retention only (discovered-from/supersedes project to relates because
// Root authorized that explicit projection; truly unknown kinds do not).
export function nativeEdgeKind(rawType: string): CanonicalRelation['kind'] | null {
  switch (rawType) {
    case 'blocks':
    case 'depends-on':
      return 'blocks';
    case 'related':
    case 'relates-to':
    case 'discovered-from':
    case 'supersedes':
      return 'relates';
    case 'duplicates':
      return 'duplicates';
    default:
      return null;
  }
}

export interface BdEdgeSinks {
  relations: CanonicalRelation[];
  unmapped: BdUnmappedField[];
  // Per-pair projection counts: every RAW edge that projected onto a native
  // (unordered) pair + kind is counted, so the preflight never claims one
  // native edge per raw edge when raw edges merged (Root preflight control
  // 2026-11-15: issue_link uniqueness is the unordered pair + kind).
  pairProjections: Record<string, number>;
  // Raw blocks edges counted per ORDERED pair, key `blocks:${a}>::${b}` =
  // "a blocks b". Only `blocks` carries a readiness direction, so only it is
  // direction-tracked: a mutual pair (both directions present) must not merge
  // into one native edge (CT 2026-11-15 E2 - the merged direction loses the
  // other side's readiness).
  blockDirections: Record<string, number>;
}

// The unordered-pair key for a native link: the issue_link store treats
// (A, B, kind) and (B, A, kind) as the SAME link, so the dedupe and the
// projection count key on the sorted pair, never on direction.
export function bdPairKey(kind: CanonicalRelation['kind'], a: string, b: string): string {
  return a < b ? `${kind}:${a}::${b}` : `${kind}:${b}::${a}`;
}

// Push a native relation with the unordered-pair + kind dedupe: the first
// raw edge wins the direction, later raw edges on the same pair only
// increment the projection count (the raw side keeps every stored edge).
export function pushBdNativeRelation(
  sinks: Pick<BdEdgeSinks, 'relations' | 'pairProjections' | 'blockDirections'>,
  kind: CanonicalRelation['kind'],
  source: string,
  target: string,
  byId: Map<string, BdCardView>,
): void {
  if (!byId.has(source) || !byId.has(target)) return; // raw entry keeps the fact
  const key = bdPairKey(kind, source, target);
  sinks.pairProjections[key] = (sinks.pairProjections[key] ?? 0) + 1;
  if (kind === 'blocks') {
    // The readiness direction of THIS raw edge, for the mutual-blocks pass.
    const dir = `${key}=${source}>${target}`;
    sinks.blockDirections[dir] = (sinks.blockDirections[dir] ?? 0) + 1;
  }
  if (
    sinks.relations.some(
      (r) => bdPairKey(r.kind, r.sourceIssueSourceId, r.targetIssueSourceId) === key,
    )
  )
    return;
  sinks.relations.push({ kind, sourceIssueSourceId: source, targetIssueSourceId: target });
}
const RAW_EDGE_NOTE = 'raw source dependency edge, retained verbatim in the ticket metadata';
const PROJECTED_NOTE = (raw: string) =>
  `raw kind ${raw} has no native kind; projected to relates per the explicit Root ruling, raw fact retained`;
const UNKNOWN_NOTE = (raw: string) =>
  `raw kind ${raw} is not in the measured set; retained raw, never projected and never dropped`;

// Project every stored edge: native relation where the kind supports it (and
// both endpoints exist, and the edge is not a self edge), and ALWAYS the raw
// retention entry on the child card. Dedupe the native side only - the raw
// side keeps every stored edge exactly as the source stored it.
export function mapBdEdgeRelations(
  cards: BdCardView[],
  byId: Map<string, BdCardView>,
  parents: Map<string, BdParentSelection>,
  sinks: BdEdgeSinks,
): void {
  for (const card of cards) {
    const sel = parents.get(card.id);
    for (const dep of card.dependencies ?? []) {
      sinks.unmapped.push({
        bdId: card.id,
        field: `dependency:${dep.type}`,
        value: JSON.stringify(dep),
        retention: 'unmapped_report',
        note:
          nativeEdgeKind(dep.type) == null && dep.type !== 'parent-child'
            ? UNKNOWN_NOTE(dep.type)
            : dep.type === 'discovered-from' || dep.type === 'supersedes'
              ? PROJECTED_NOTE(dep.type)
              : RAW_EDGE_NOTE,
      });
      if (dep.type === 'parent-child') {
        // The supported case is the native parent (no relation row). The
        // unsupported cases (multi-parent, cycle) emit native relates for
        // non-self edges; a self-edge never pretends a native edge exists.
        const unsupported =
          sel != null && (sel.disposition === 'multi-parent' || sel.disposition === 'cycle');
        if (!unsupported || dep.depends_on_id === card.id) continue;
        pushBdNativeRelation(sinks, 'relates', card.id, dep.depends_on_id, byId);
        continue;
      }
      const kind = nativeEdgeKind(dep.type);
      if (kind == null) continue; // unknown kind: raw retention only
      if (dep.issue_id === dep.depends_on_id) continue; // self-edge: raw only
      // Orientation (bd 1.3.1 `bd dep add <issue> <depends-on-id>`: the issue
      // depends on / is blocked by depends_on_id): the blocker is the SOURCE.
      const source = kind === 'blocks' ? dep.depends_on_id : dep.issue_id;
      const target = kind === 'blocks' ? dep.issue_id : dep.depends_on_id;
      pushBdNativeRelation(sinks, kind, source, target, byId);
    }
  }
}

// The explicit per-card dispositions the preflight must list so the operator
// can review before the actual import: every card whose native parent was
// WITHHELD (multi-parent, cycle, self-parent). no-explicit-parent is the
// measured default (719 cards) and needs no review row; single-parent is
// unambiguous.
export function collectBdParentDispositions(
  parents: Map<string, BdParentSelection>,
  out: BdUnmappedField[],
): void {
  const NOTES: Record<string, string> = {
    'multi-parent':
      'multiple explicit parent-child edges; native parent withheld until reviewed, raw edges retained, non-self edges are native relates',
    cycle:
      'explicit parent chain loops; native parent withheld until reviewed, raw edges retained, non-self edges are native relates',
    'self-parent':
      'the source names the card as its own parent; raw metadata only, no native edge invented',
  };
  for (const sel of parents.values()) {
    if (sel.disposition === 'single-parent' || sel.disposition === 'no-explicit-parent') continue;
    out.push({
      bdId: sel.cardId,
      field: 'parent-disposition',
      value: `${sel.disposition}${sel.rawParents.length ? `:${sel.rawParents.join(',')}` : ''}`,
      retention: 'unmapped_report',
      note: NOTES[sel.disposition],
    });
  }
}

// The operator-facing listing the final preflight prints before the actual
// import (Root ruling msg_ba3d90875534): one line per card whose native
// parent was WITHHELD (multi-parent / cycle / self-parent), with the raw
// parents the source named, plus the exact disposition counts. The
// no-explicit-parent default (719 measured) and the single-parent majority
// are reported as counts only - they are never listed individually.
export function formatBdParentPreflight(parents: Map<string, BdParentSelection>): {
  lines: string[];
  counts: Record<string, number>;
  // The named disposition summary the preflight prints so the 719-card
  // no-explicit-parent class is NAMED and COUNTED, never silent (Root
  // preflight control 2026-11-15). Every disposition name appears even at
  // zero.
  countsLine: string;
} {
  const counts: Record<string, number> = {
    'single-parent': 0,
    'no-explicit-parent': 0,
    'multi-parent': 0,
    cycle: 0,
    'self-parent': 0,
  };
  for (const sel of parents.values()) counts[sel.disposition] = (counts[sel.disposition] ?? 0) + 1;
  const countsLine =
    'parent dispositions: ' +
    (Object.keys(counts) as BdParentDisposition[]).map((d) => `${d} ${counts[d]}`).join('; ');
  const lines: string[] = [];
  const withheld = new Set<string>();
  for (const sel of parents.values()) {
    if (sel.disposition === 'single-parent' || sel.disposition === 'no-explicit-parent') continue;
    withheld.add(sel.cardId);
  }
  for (const id of [...withheld].sort()) {
    const sel = parents.get(id)!;
    lines.push(
      `${id}: ${sel.disposition}` +
        (sel.rawParents.length ? ` (raw parents: ${sel.rawParents.join(', ')})` : '') +
        ' - native parent withheld until reviewed',
    );
  }
  return { lines, counts, countsLine };
}

// The exact reconciliation counts the preflight prints: every raw edge kind
// and every parent disposition, so the measured source counts (parent-child
// 5407, blocks 2140, discovered-from 732, relates-to 99, supersedes 83,
// related 29, duplicates 3, depends-on 1) can be checked edge-for-edge.
export function bdEdgeCounts(
  cards: BdCardView[],
  parents: Map<string, BdParentSelection>,
): { edgeKinds: Record<string, number>; parentDispositions: Record<string, number> } {
  const edgeKinds: Record<string, number> = {};
  for (const card of cards)
    for (const dep of card.dependencies ?? []) edgeKinds[dep.type] = (edgeKinds[dep.type] ?? 0) + 1;
  const parentDispositions: Record<string, number> = {};
  for (const sel of parents.values())
    parentDispositions[sel.disposition] = (parentDispositions[sel.disposition] ?? 0) + 1;
  return { edgeKinds, parentDispositions };
}
