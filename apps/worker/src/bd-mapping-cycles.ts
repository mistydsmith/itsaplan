// The full-graph explicit parent-cycle detection of the 8363.1 mapper.
//
// Root cycle ruling (2026-11-15, import_dependency_review_R6): cycles must
// be detected on ALL explicit parent edges BEFORE any per-card pruning - a
// loop that runs through a multi-parent card is a real cycle even though the
// multi-parent card's own choice is pruned to "withheld". Every ACTUAL cycle
// member therefore gets native parent null + the named 'cycle' disposition
// (all raw parents retained; non-self edges keep their relates projection).
//
// Every explicit parent-child edge (child -> parent, all rows) forms the
// directed graph; each strongly connected component of more than one card (or
// a self-loop) is one cycle, reported by ids only. Split from
// bd-mapping-card.ts so selectBdParents (bd-mapping-edges.ts) can consume the
// membership without a module cycle.
import type { BdCardView, BdUnmappedField } from './bd-mapping';

// The pure graph pass: every explicit parent-child edge (child -> parent,
// all rows, including the extra rows of multi-parent cards) as a directed
// edge; iterative Tarjan strong components; each SCC of more than one card
// (or a self-loop) is one cycle, member ids sorted, cycles ordered by first
// member. Deterministic for the same board state.
export function collectBdParentCycles(cards: BdCardView[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const card of cards)
    for (const dep of card.dependencies ?? [])
      if (dep.type === 'parent-child' && dep.issue_id === card.id) {
        const edges = graph.get(card.id) ?? [];
        edges.push(dep.depends_on_id);
        graph.set(card.id, edges);
      }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let next = 0;
  for (const card of cards) {
    if (!graph.has(card.id) || index.has(card.id)) continue;
    // Frame: [node, edge cursor]. On entry the node gets its index and
    // joins the SCC stack.
    const work: [string, number][] = [];
    const enter = (v: string) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      work.push([v, 0]);
    };
    enter(card.id);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const node = frame[0];
      const edges = graph.get(node) ?? [];
      if (frame[1] < edges.length) {
        const w = edges[frame[1]!]!;
        work[work.length - 1] = [node, frame[1] + 1];
        if (!index.has(w)) {
          enter(w);
        } else if (onStack.has(w)) {
          low.set(node, Math.min(low.get(node)!, index.get(w)!));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]![0];
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
        }
        if (low.get(node) === index.get(node)) {
          const scc: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === node) break;
          }
          if (scc.length > 1 || (graph.get(node) ?? []).includes(node)) {
            scc.sort();
            cycles.push(scc);
          }
        }
      }
    }
  }
  cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return cycles;
}

// The operator-facing disposition rows (CT 2026-11-15 E4): one ids-only row
// per cycle on the retained unmapped port, so the preflight lists the exact
// cards before the import. A cycle member's native parent is null by its own
// 'cycle' disposition (selectBdParents), so no native loop can form.
export function collectBdParentCycleDispositions(
  cards: BdCardView[],
  out: BdUnmappedField[],
): string[][] {
  const cycles = collectBdParentCycles(cards);
  for (const scc of cycles) {
    out.push({
      bdId: scc[0]!,
      field: 'edge-disposition:parent-cycle',
      value: scc.join('|'),
      retention: 'unmapped_report',
      note: 'explicit parent-child edges loop through these cards; every member carries the named cycle disposition with native parent null, all raw parents are retained and non-self edges keep their relates projection - ids listed for operator review',
    });
  }
  return cycles;
}
