import type {
  CanonicalIssue,
  CanonicalLabel,
  CanonicalRelation,
  CanonicalState,
  CanonicalStateCategory,
} from './canonical';
import {
  collectBdCardUnmapped,
  collectBdDependencyEdges,
  mapBdCard,
  resolveBdMutualBlocks,
} from './bd-mapping-card';
import { collectBdParentCycleDispositions } from './bd-mapping-cycles';
import {
  bdEdgeCounts,
  collectBdParentDispositions,
  selectBdParents,
  type BdParentSelection,
} from './bd-mapping-edges';

// Pure mapping from bd --json card views to the canonical import shape the
// worker's Create phase consumes. No @repo/db access, no bd process, no I/O:
// bd-adapter.ts (the SourceReader) produces the views, this file only decides
// where every field goes. Root decisions on sentinel-prod-8363.1 (2026-11-15):
// - no silent blocked/review/deferred folding: every source status gets its own
//   state whose NAME preserves the status; the category is the coarse mapping;
// - nesting follows the current tree owner (packages/db issue-tree.ts:
//   MAX_SUBTASK_DEPTH = 8; a rig-gated project has no cap at all), so the old
//   trial's 2-level ceiling is gone. An edge past the limit is never dropped or
//   flattened: it stays an explicit 'relates' relation plus a retained note.
// - the exact source id rides issues.bead_id + the bead_identity ledger (the
//   @repo/db writer, sentinel-prod-8363.1), so the title stays pure here.
// - Root P0 export contract (2026-11-15): the source is ONE readonly
//   `bd export --all` JSONL snapshot. Every _type:'issue' record is a NATIVE
//   issue regardless of issue_type (the old task/bug/epic/decision ticket set
//   wrongly retained 333 real issues as non-tickets: feature 284, chore 33,
//   molecule 7, spike 5, event 3, merge-request 1). Only _type:'memory'
//   records are retained - the adapter carries them as memory:<key> rows that
//   never become bead ids or tombstones; the generic bead tombstone primitive
//   is kept for true bead retention only.
// - Root P0 dependency contract (2026-11-15, msg_7aa859bd5727 + ruling
//   msg_ba3d90875534): the ACTUAL exported edges are authoritative. The
//   native parent is a SINGLE explicit parent-child edge (issue_id = child,
//   depends_on_id = parent); NO decimal inference - a dotted card with no
//   explicit parent keeps its native parent null and its dotted token
//   unchanged. Multi-parent / cycle / self-edge cards withhold the native
//   parent, keep every raw edge in the durable ticket metadata, emit an
//   explicit per-card disposition and native relates for non-self edges. Edge
//   kinds project per the bd 1.3.1 `bd dep add` orientation (blocks:
//   source = depends_on_id the blocker, target = issue_id the blocked):
//   blocks/depends-on -> blocks, related/relates-to -> relates,
//   duplicates -> duplicates, discovered-from/supersedes -> relates with raw
//   retention (the explicit Root-authorized projection), unknown kinds raw
//   only. Every edge is retained raw on the child card's unmapped port so the
//   ticket_metadata retained row preserves it under the artifact digest.
// - unsupported fields are not merely warned: each gets a BdUnmappedField entry
//   that says where the value is retained, so reconciliation can close the loop.

// The measured bd export --all JSONL consumer shape (Root 2026-11-15 baseline:
// 13.5k issues + 90 memories; comments/dependencies present-only-when-
// non-empty). A port boundary, not a duplication of any bd source.
export interface BdCommentView {
  // The measured comment object: {id, issue_id, author, text, created_at}.
  // `text`, not `body` - the old show shape is gone with the show crawl.
  id?: string;
  issue_id?: string;
  author: string | null;
  text: string;
  created_at: string | null;
  // The measured bd show JSON may carry more keys on a comment object than
  // these three name - the known fields are named, and the adapter retains the
  // runtime objects verbatim (their raw JSON keeps any unknown keys; CT
  // 2026-11-15 fix 1: raw retention must not lose facts).
  [key: string]: unknown;
}

export interface BdDependencyView {
  // The measured export edge: {issue_id, depends_on_id, type, created_at,
  // created_by, metadata}; the type is an open string (measured: parent-child
  // and blocked_by among others) - unknown types are retained, not guessed.
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at?: string | null;
  created_by?: string | null;
  metadata?: string;
}

export interface BdCardView {
  id: string;
  title: string;
  // Present-only-when-non-empty in the export (362 of 13,498 measured records
  // omit it): the mapper treats absent as an empty body.
  description?: string;
  status: string;
  priority: number | null;
  // Omitted-when-null in the export (2,821 measured records): absent is no
  // assignee - never an unknown value.
  assignee?: string | null;
  issue_type: string;
  // Omitted-when-empty in the export (827 measured records).
  labels?: string[];
  // Present-only-when-non-empty in the export; a record with no edges omits
  // the key (the mapper treats absent as no edges).
  dependencies?: BdDependencyView[];
  created_at: string | null;
  updated_at: string | null;
  // The export's named source fields beyond the card headline (measured
  // 2026-11-15): notes is a plain string and can be huge (143KB measured) -
  // it rides the unmapped sink verbatim; owner is the bd owner token.
  notes?: string;
  owner?: string | null;
  created_by?: string | null;
  started_at?: string | null;
  // bd's authoritative counts when the record prints them (informational now
  // that the export carries the complete comments/dependencies inline - no
  // show crawl; a missing count is NOT assumed to be zero).
  comment_count?: number;
  dependency_count?: number;
  dependent_count?: number;
  comments?: BdCommentView[];
}

// Coarse category only; the state NAME preserves the source status (no
// silent folding of blocked/review/deferred).
// Exported for the per-card leaf (bd-mapping-card.ts): the unknown-status
// retention check.
export const STATUS_CATEGORY: Record<string, CanonicalStateCategory> = {
  open: 'unstarted',
  queued: 'backlog',
  in_progress: 'started',
  blocked: 'started',
  review: 'started',
  deferred: 'backlog',
  closed: 'completed',
};

const STATUS_NAME: Record<string, string> = {
  open: 'Open',
  queued: 'Queued',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  review: 'Review',
  deferred: 'Deferred',
  closed: 'Closed',
};

// The tree owner's cap. Kept pure on purpose (no @repo/db import, so this
// file stays directly unit-testable like cross-reference.ts): the adapter
// passes the value read from packages/db/src/issue-tree.ts
// (MAX_SUBTASK_DEPTH = 8), or Number.POSITIVE_INFINITY for a rig-gated
// project, which has no cap at all (issue-tree.ts line 72).
const DEFAULT_MAX_DEPTH = 8;

// bd priorities are 0-based with 0 the most important; 0..3 map onto the
// canonical set and anything else is retained, not guessed.
// Exported for the per-card leaf (bd-mapping-card.ts): the off-scale-priority
// check. Private to the bd mapper, never to the rest of the worker.
export const PRIORITY_BY_LEVEL: Record<number, string> = {
  0: 'urgent',
  1: 'high',
  2: 'medium',
  3: 'low',
};

export interface BdRetainedRow {
  sourceId: string;
  issueType: string;
  title: string;
  // Where the row is preserved in the target.
  retention: 'tombstone_identity';
  reason: string;
  // The row's full source content, carried verbatim (Office RETURN3 D2, 8363.1):
  // the adapter moves it onto the retained row's unmapped port so the artifact
  // digest covers the body - two distinct nonempty memory bodies must never
  // collapse to the same durable artifact.
  raw: BdCardView;
}

// The native issue title carries the bead token prefix the gated identity owner
// requires (tools/tracker_rule_identity.py _title_matches: the title must begin
// with its own token and a separator, or the card can never be edited again).
// The ORIGINAL title is preserved here so the import mapping can reconcile
// "what the card said" from "what the target title says".
export interface BdRetainedTitle {
  sourceId: string;
  originalTitle: string;
  // True when the source title already carried the exact prefix and was kept as-is.
  alreadyPrefixed: boolean;
}

export interface BdUnmappedField {
  bdId: string;
  field: string;
  value: string;
  // Target retention + reconciliation, never a bare warning.
  retention: 'unmapped_report' | 'relates_edge' | 'tombstone_identity';
  note: string;
}

export interface BdSourceSnapshot {
  states: CanonicalState[];
  labels: CanonicalLabel[];
  issues: CanonicalIssue[];
  relations: CanonicalRelation[];
  retained: BdRetainedRow[];
  // The original titles of every imported ticket, retained for reconciliation
  // (the native title carries the required `${token}: ` prefix).
  retainedTitles: BdRetainedTitle[];
  unmapped: BdUnmappedField[];
  // The explicit-edge parent selection for every card (single-parent ->
  // native parent; multi/cycle/self -> withheld; no-explicit -> null). The
  // final preflight lists the withheld IDs + dispositions for review.
  parentSelections: Map<string, BdParentSelection>;
  // Exact reconciliation counts: every raw edge kind and every parent
  // disposition, checked edge-for-edge against the measured source.
  edgeCounts: {
    edgeKinds: Record<string, number>;
    parentDispositions: Record<string, number>;
    // Per-pair projection counts (unordered pair + kind): every raw edge that
    // projected onto a native link is counted, so merged pairs are never
    // claimed as one native edge per raw edge (Root preflight control
    // 2026-11-15: issue_link uniqueness is the unordered pair + kind).
    pairProjections: Record<string, number>;
    // Mutual blocks pairs (both raw directions on one unordered pair): the
    // named unsupported disposition (CT 2026-11-15 E2 - merging would lose a
    // side's readiness).
    mutualBlocks: { pair: [string, string]; rawEdgeCount: number }[];
    // The full-graph explicit parent-child loops (ids only), including a
    // cycle that runs through a multi-parent card (CT 2026-11-15 E4; Root R1
    // measured exactly one on the actual board).
    parentCycles: string[][];
  };
}

export interface BdMapOptions {
  // The tree owner's cap (issue-tree.ts MAX_SUBTASK_DEPTH, 8). Pass
  // Number.POSITIVE_INFINITY for a rig-gated project, which has no cap.
  maxDepth?: number;
  // The trusted rig prefix this board's ids carry (the board directory is the
  // repo: sentinel-prod's cards are sentinel-prod-8363.1). The reader passes it
  // from the operator-configured board address - it is server config, never
  // request input. The mapper derives every card's LOCAL token from it (title,
  // sequence root); a card id that does not carry it is a foreign board's card
  // and the mapping fails loudly instead of guessing (Root, 8363.1: mandatory -
  // a mapping without a trusted prefix has no correct local token to bind).
  rigPrefix: string;
}

export { bdLocalToken, bdLevel, decimalParentOf, iso } from './bd-mapping-id';

/**
 * Map a full bd card view to the canonical source snapshot. Deterministic:
 * every list is stably ordered by its id, so two runs over the same board
 * produce identical snapshots (the digest in the mapper stays comparable).
 * The options object is REQUIRED: the trusted rig prefix is mandatory (T3,
 * Root GO 8363.1) and a `{}` default would silently re-allow an untrusted
 * mapping - the caller must name both the cap and the trusted prefix.
 */
export function mapBdSource(cards: BdCardView[], options: BdMapOptions): BdSourceSnapshot {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rigPrefix = options.rigPrefix;
  if (!rigPrefix) {
    throw new Error(
      'mapBdSource requires the trusted rig prefix: without it no card has a correct local token to bind (Root, 8363.1)',
    );
  }
  const sorted = [...cards].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((c) => [c.id, c]));

  const unmapped: BdUnmappedField[] = [];
  // Root P0 export contract: EVERY _type:'issue' record is a native issue
  // regardless of issue_type - there is no ticket-class filter anymore. The
  // retained port stays on the snapshot for true bead retention (a future
  // source that carries non-issue BEADS with real ids keeps the tombstone
  // primitive); this source's non-issue records are memories, which the
  // adapter carries as memory:<key> rows and never through this port.
  const retained: BdRetainedRow[] = [];
  const tickets = sorted;

  // The per-card derivations live in bd-mapping-card.ts (Root P0 2026-11-15
  // leaf cap): the unmapped source-field sink, one canonical issue per card
  // (parent edge, sequence root, exact issue kind, title contract) and the
  // dependency edges - the exact former inline logic, now with single
  // ownership of the accumulators here.
  collectBdCardUnmapped(sorted, unmapped);

  const states = sorted
    .map((c) => c.status)
    .filter((s, i, all) => all.indexOf(s) === i)
    .sort()
    .map((status) => ({
      sourceId: `status:${status}`,
      name: STATUS_NAME[status] ?? status,
      category: STATUS_CATEGORY[status] ?? 'unstarted',
    }));

  const labelNames = new Set<string>();
  for (const card of tickets) for (const l of card.labels ?? []) labelNames.add(l);
  const labels = [...labelNames].sort().map((name) => ({ sourceId: `label:${name}`, name }));

  const issues: CanonicalIssue[] = [];
  const relations: CanonicalRelation[] = [];
  const retainedTitles: BdRetainedTitle[] = [];
  // The explicit-edge parent selection runs BEFORE the card mapping: the
  // native parent is the single explicit parent-child edge, never a decimal
  // inference (Root P0 + ruling 2026-11-15).
  const parents = selectBdParents(tickets);
  // Per-pair projection counts (Root preflight control 2026-11-15): every
  // raw edge that projects onto a native unordered pair + kind is counted,
  // so the preflight never claims one native edge per raw edge.
  const pairProjections: Record<string, number> = {};
  // Raw blocks edges per ordered pair (the mutual-blocks pass keys on it).
  const blockDirections: Record<string, number> = {};
  const ctx = {
    rigPrefix,
    maxDepth,
    byId,
    parents,
    relations,
    unmapped,
    retainedTitles,
    pairProjections,
    blockDirections,
  };

  for (const card of tickets) {
    issues.push(mapBdCard(card, ctx));
  }

  collectBdDependencyEdges(tickets, byId, ctx);
  collectBdParentDispositions(parents, unmapped);
  // The mutual-blocks pass runs AFTER every raw edge projected (both
  // directions must be counted before the native edge is withheld, CT
  // 2026-11-15 E2); the cycle pass keys on the RAW edges (E4).
  const mutualBlocks = resolveBdMutualBlocks({ relations, blockDirections });
  const parentCycles = collectBdParentCycleDispositions(tickets, unmapped);
  for (const mb of mutualBlocks) {
    unmapped.push({
      bdId: mb.pair[0],
      field: 'edge-disposition:mutual-blocks',
      value: `${mb.pair[0]}::${mb.pair[1]}:${mb.rawEdgeCount}`,
      retention: 'unmapped_report',
      note: 'blocks edges in BOTH directions on one unordered pair; the native blocks edge is withheld (a merged direction would lose readiness), the pair stays visible as relates, every raw edge is retained on both cards',
    });
  }
  const edgeCounts = {
    ...bdEdgeCounts(tickets, parents),
    pairProjections,
    mutualBlocks,
    parentCycles,
  };

  issues.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  relations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.sourceIssueSourceId.localeCompare(b.sourceIssueSourceId) ||
      a.targetIssueSourceId.localeCompare(b.targetIssueSourceId),
  );
  retained.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  unmapped.sort(
    (a, b) =>
      a.bdId.localeCompare(b.bdId) ||
      a.field.localeCompare(b.field) ||
      a.value.localeCompare(b.value),
  );

  return {
    states,
    labels,
    issues,
    relations,
    retained,
    retainedTitles,
    unmapped,
    parentSelections: parents,
    edgeCounts,
  };
}

// The one required prefix the identity owner checks. Canonical form is
// `${token}: `; exactly that prefix is the only shape left alone, anything
// else gets the prefix prepended. The durable retention names the FULL source
// id (the token is what the owner checks in the title; the id is what
// reconciliation matches).
export function prefixedTitle(
  sourceId: string,
  token: string,
  title: string,
  out: BdRetainedTitle[],
): string {
  const prefix = `${token}: `;
  const already = title.startsWith(prefix);
  out.push({ sourceId, originalTitle: title, alreadyPrefixed: already });
  return already ? title : `${prefix}${title}`;
}
export { mapBdComments } from './bd-mapping-id';
