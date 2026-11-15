// The pure bd id helpers of the 8363.1 mapper: the strict local token, the
// dotted-id level and decimal parent (trial-era semantics, retained for
// reachability - the dependency-edge contract no longer infers parents
// from them), and the ISO timestamp default. Split from bd-mapping.ts so
// the orchestrator module stays under the 400-line new-leaf cap
// (CT 2026-11-15, no compression, no proof deletion).
import type { CanonicalComment } from './canonical';
import type { BdCommentView } from './bd-mapping';
// The card's number WITHIN its rig, from the trusted prefix (the same
// semantics the @repo/db writer and the pinned identity owner use: the part
// after '<prefix>-'). Explicit and exact - the whole marker is required, so a
// multi-hyphen rig prefix (sentinel-prod) strips correctly (Office RETURN3 /
// Root 8363.1: consistent prefix-bound local token semantics).
//
// STRICT ONLY (Root ruling 2026-11-15): a source id that does not carry the
// rig's exact prefix is REFUSED - the pinned owner's refusal is not permission
// to rename a source ID, and there is no fallback that turns a foreign id
// (measured legacy record: b-4500 on the sentinel-prod store) into a stamped
// <rig>-<id>. Root preserves that legacy record separately: a legacy project
// under its own rig prefix `b` maps `b-4500` to token `4500` through this
// SAME strict path - no generic multi-rig framework, no permissive fallback.
export function bdLocalToken(rigPrefix: string, sourceId: string): string {
  const marker = `${rigPrefix}-`;
  if (!sourceId.startsWith(marker)) {
    throw new Error(
      `bd id ${sourceId} does not carry the rig prefix ${rigPrefix}: refused - ` +
        `a foreign or legacy-prefix id is never renamed into this rig; it belongs to its own rig`,
    );
  }
  const token = sourceId.slice(marker.length);
  if (!token) {
    throw new Error(`bd id ${sourceId} is the rig prefix itself; there is no token to map`);
  }
  return token;
}

// A dotted bd id's level: the top card is level 1 (issue-tree.ts: "an issue
// with no parent is on level 1"). A non-dotted id is a top-level card.
// Exported for the per-card leaf (bd-mapping-card.ts).
export function bdLevel(id: string): number {
  return (id.match(/\./g) ?? []).length + 1;
}

// The dotted id's parent: the id with its final '.<child>' removed.
// Exported for the per-card leaf (bd-mapping-card.ts).
export function decimalParentOf(id: string): string | null {
  const dot = id.lastIndexOf('.');
  return dot > 0 ? id.slice(0, dot) : null;
}

// The canonical shape requires ISO strings; a bd row missing the timestamp
// keeps the epoch, never a blank. Exported for the per-card leaf
// (bd-mapping-card.ts).
export function iso(value: string | null): string {
  // The canonical shape requires ISO strings; a bd row missing the timestamp
  // keeps the epoch, never a blank.
  return value ?? new Date(0).toISOString();
}

/** Map one card's bd export comments to the canonical comment shape. */
export function mapBdComments(
  issueSourceId: string,
  comments: BdCommentView[] | undefined,
): CanonicalComment[] {
  if (!comments) return [];
  // bd orders comments oldest first; the export carries a real uuid id, which
  // is the stable dedupe key - the index only stands in when a record omits
  // it (never assume the export will keep printing it).
  return comments.map((c, i) => ({
    sourceId: c.id ? `${issueSourceId}:${c.id}` : `${issueSourceId}:c${i}`,
    authorEmail: null,
    // Authorship is preserved as the bd author token, not dropped.
    authorName: c.author ?? 'bd import',
    bodyMarkdown: c.text,
    createdAt: iso(c.created_at),
    replyToSourceId: null,
  }));
}
