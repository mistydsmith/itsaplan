// The facts half of the anchor chain (sentinel-prod-8428 slice S2a): what ThisPlan's board actually
// says, read in at most two bounded statements and converted into the record shape the shared chain
// rule (sentinel-prod-8427's `tools/anchor_map_chain.py --plan-json`) already reads for `bd`.
//
// WHERE THE RULE LIVES: nowhere here. This module reads facts and shapes them. It chooses no order,
// picks no pair, judges no cycle and writes nothing - the shared tool owns all of that, and
// `anchor-chain.ts` (slice S2b) is the only caller that asks for a plan and applies one.
//
// What this module guarantees, and why each guarantee matters to the shared rule:
//   * The record is the native one - the keys `bd show --json` gives the planner - so the planner
//     needs no ItsPlan-specific shape, and its unknown-fact test means the same thing on both boards.
//   * Status is DERIVED from this checkout's own lifecycle, never invented: an archived row or a
//     terminal column state is closed, a claim or an assignee is in_progress, only a genuinely free
//     unfinished row is open. That is what makes the shared `claimed` rule bite here.
//   * A project that is absent, null or unparseable is UNKNOWN, not zero, so "no project" is never
//     treated as a project two issues share.
//   * The existing 'blocks' relations travel as native dependency objects, so the shared rule can
//     call an edge `present` and judge a cycle against what is already on the board. A relation
//     keeps its far end even when this read did not keep that end (a closed issue, an archived one,
//     a candidate beyond the bound): the edge is a fact the board has, and erasing it would show the
//     rule a cycle-free graph it never saw. The rule's own unknown-fact test is what refuses.
//   * One capped read carries both the unfinished issues and their relations (the relation rides in
//     on a left join), and a read that stopped short says so through `truncated` - incomplete facts
//     are never presented as complete ones. Two ways to stop short are watched separately: the
//     distinct-issue bound, and the row bound the relations multiply.
//   * The bound is spent on candidates. The reader is told which files this chain is about and selects
//     coarsely for them - in the statement, so the LIMIT cannot do the excluding, and again in the
//     shaping, so rows the chain has no business with cannot push a same-file peer out of the shared
//     rule's own sibling bound (Root's 8428 crowded-board review). Coarse on purpose: exact matching,
//     order and cycles stay the shared rule's, and this module still names no pair.

import { and, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, issue, issueLink, projectColumn } from '@repo/db';

// The shared rule's own sibling bound, kept identical here so the two sides disagree about nothing.
export const SIBLING_CAP = 10;
// A relation multiplies rows, not issues, so the row limit is derived from the issue bound.
export const LINKS_PER_ISSUE = 4;

/** The record the shared planner reads: the same keys `bd show --json` gives it. Its status
 * vocabulary is the native one; the values derived here (open, in_progress, closed) are members of
 * it, and a value the tool does not know makes the tool report the record as unknown facts, which
 * the adapter never overrides. */
export interface NativeDependency {
  depends_on_id: string;
  issue_id: string;
  type: string;
}

export interface NativeIssue {
  id: string;
  status: string;
  assignee: string | null;
  owner: string | null;
  description: string;
  notes: string;
  created_at: string;
  dependencies: NativeDependency[];
}

/** Per-file anchors this issue's own body names. The shared planner derives start lines from the
 * record text itself, so the ranges travel as the file list; `starts` is kept because it is what
 * this checkout's stamp computed, and it is the exact payload an optional planner `anchors` field
 * (A4's proposal, awaiting Root's word) would need. */
export interface FileAnchors {
  file: string;
  starts: number[];
}

export interface ChainFacts {
  issues: Record<string, unknown>[];
  blockedBy: Map<string, string[]>;
  /** True when this read stopped short of the whole graph - because a candidate lay beyond the
   * distinct-issue bound, or because the rows it asked for were all the rows it was allowed to ask
   * for. The shared rule has the same guard (`siblings bounded to 10; the graph is incomplete`, and
   * A4's `graph_truncated`), and the adapter withholds permission on this flag as well as on the
   * plan's own. */
  truncated: boolean;
}

/** What this chain is about, handed to the reader so the bound is spent on issues the chain could
 * actually pair with (Root's 8428 review: on a board with 11 unrelated unfinished rows the global
 * first-11 bound consumed itself on those rows and the same-file peer never reached the rule).
 * This is a selection bound, not a pairing rule: the reader still names no order, no pair and no
 * match - the shared rule keeps sole ownership of exact anchor matching, order and cycle. */
export interface CandidateScope {
  /** The stamped issue travels whatever its body says: it is the record the plan is asked about. */
  issueId: number;
  /** The normalized paths whose anchors this chain was asked about, as the stamp computed them. */
  files: string[];
}

export type FactsFn = (cap: number, scope: CandidateScope) => Promise<ChainFacts>;

// A path is containment-tested, never pattern-matched: `_` is a single-character wildcard in LIKE and
// `%` is any run, so an unescaped `mod_a.py` would match `modXay.py` and, worse, read as a pattern
// rather than as the file. The shared rule derives an anchor from "<path>:<first>-<last>" inside the
// body, so any record that truly names the path contains the path: this test cannot drop one.
function likePattern(file: string): string {
  return `%${file.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Body-level relevance, the same containment the SQL prefilter applies, kept here because the bound
 * is applied to the rows this read actually got back. */
function namesAnyFile(row: Record<string, unknown>, files: string[]): boolean {
  const text = String(row.description ?? '');
  return files.some((file) => text.includes(file));
}

export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\n/g, ' ').slice(0, 160);
}

// A project id that is absent, null or unparseable is unknown, not zero: the same-project rule must
// not treat "no project" as a project two issues share.
export function knownProject(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// ItsPlan has no bead status column, so the native status is derived from the row's own lifecycle: a
// terminal column state (the schema check allows backlog | unstarted | started | completed | canceled
// - the same pair the existing blocks and board filters use) or an archived row is closed, and only a
// genuinely free unfinished row is open. A row on a `started` column IS in progress in this board's own
// terms - it has been moved onto the doing column - and a claim or an assignee says the same thing.
// Reporting a started row as open is what let a fresh-open chain auto-link onto work a person already
// began (Root's 8428 review): in_progress is the fact, and the shared rule's own claimed rule is what
// refuses on it. backlog and unstarted rows stay open, so fresh work can still be chained.
export function statusOf(row: Record<string, unknown>): string {
  if (row.archivedAt) return 'closed';
  if (row.stateType === 'completed' || row.stateType === 'canceled') return 'closed';
  if (row.stateType === 'started') return 'in_progress';
  if (row.claimOwner || row.assigneeUserId) return 'in_progress';
  return 'open';
}

/** One row of this checkout's issue table, in the keys the shared planner reads, with the existing
 * 'blocks' relations attached as native dependency objects. `notes` is empty because the chain needs
 * no comment text and reading it would widen the statement for no rule's benefit. */
export function nativeRecord(
  row: Record<string, unknown>,
  blockedBy: Map<string, string[]>,
): NativeIssue {
  const id = String(row.id);
  return {
    id,
    status: statusOf(row),
    assignee: (row.assigneeUserId as string | null) ?? null,
    owner: (row.claimOwner as string | null) ?? null,
    description: String(row.description ?? ''),
    notes: '',
    created_at:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ''),
    dependencies: (blockedBy.get(id) ?? []).map((source) => ({
      depends_on_id: source,
      issue_id: id,
      type: 'blocks',
    })),
  };
}

/** Project per issue id, with unknown kept as null so an edge can be named rather than guessed. */
export function projectsOf(
  issueId: number,
  project: number,
  others: Record<string, unknown>[],
): Map<string, number | null> {
  const projectOf = new Map<string, number | null>();
  projectOf.set(String(issueId), project);
  for (const row of others) projectOf.set(String(row.id), knownProject(row.projectId));
  return projectOf;
}

/** The stamped issue's own row: the chain needs its project, its column state and its body. */
export async function selfRow(issueId: number): Promise<Record<string, unknown> | null> {
  const rows = (await db
    .select({
      id: issue.id,
      projectId: issue.projectId,
      description: issue.description,
      archivedAt: issue.archivedAt,
      claimOwner: issue.claimOwner,
      assigneeUserId: issue.assigneeUserId,
      stateType: projectColumn.stateType,
      createdAt: issue.createdAt,
    })
    .from(issue)
    .leftJoin(projectColumn, sql`${projectColumn.id} = ${issue.columnId}`)
    .where(eq(issue.id, issueId))) as unknown as Record<string, unknown>[];
  return rows.find((row) => Number(row.id) === issueId) ?? null;
}

// Unfinished issues in this checkout, whatever project they are in, together with the 'blocks'
// relations each of them already has - the two facts the shared rule needs, to call a pair present
// and to judge a cycle against what is already on the board. ONE capped read carries both: the
// relation rides in on a left join instead of a second statement per stamped issue.
//
// The project is NOT filtered here on purpose: the project test is done on the facts, so an overlap
// with an issue in another project can be NAMED in the report instead of vanishing from it. The
// terminal filter is null-safe - the same selection the landing restamp and the board filters use -
// so an issue whose joined column row is absent stays selected.
//
// The column join is LAST deliberately. The landing restamp's selection proof (8428's own
// restamp_landed.test.ts) reads the LAST recorded join and where out of the recorded db, and the
// chain step runs inside the stamp that sweep calls; joining the column last, under the same
// null-safe filter, keeps that capture honest.
const blocksHere = alias(issueLink, 'anchor_chain_blocks');

export async function candidateFacts(cap: number, scope: CandidateScope): Promise<ChainFacts> {
  const unfinished = and(
    isNull(issue.archivedAt),
    or(
      isNull(projectColumn.stateType),
      notInArray(projectColumn.stateType, ['completed', 'canceled']),
    ),
  );
  // Coarse relevance in the statement itself, so the LIMIT cannot do the excluding: a board row that
  // names none of these paths is not a candidate for this chain, and the shared rule - which owns the
  // exact match - is the only thing that decides whether a row that names one is a pair.
  const relevant = or(
    eq(issue.id, scope.issueId),
    ...scope.files.map((file) => sql`${issue.description} ilike ${likePattern(file)} escape '\\'`),
  );
  const sel = and(unfinished, relevant);
  // The bound is on rows read (a relation multiplies rows, not issues). The shaping keeps at most
  // `cap + 1` distinct issues - the stamped issue plus the shared rule's own sibling bound, which is
  // what that rule treats as a complete graph - and reads one distinct issue more so that a cut is
  // reported instead of passing silently as complete facts.
  const candidateCap = cap + 1;
  const rowLimit = (candidateCap + 1) * LINKS_PER_ISSUE;
  const rows = (await db
    .select({
      id: issue.id,
      projectId: issue.projectId,
      description: issue.description,
      archivedAt: issue.archivedAt,
      claimOwner: issue.claimOwner,
      assigneeUserId: issue.assigneeUserId,
      createdAt: issue.createdAt,
      blockedBySource: blocksHere.sourceIssueId,
      stateType: projectColumn.stateType,
    })
    .from(issue)
    .leftJoin(
      blocksHere,
      and(eq(blocksHere.targetIssueId, issue.id), eq(blocksHere.kind, 'blocks')),
    )
    .leftJoin(projectColumn, sql`${projectColumn.id} = ${issue.columnId}`)
    .where(sel)
    .orderBy(issue.id)
    .limit(rowLimit)) as unknown as Record<string, unknown>[];

  const issues: Record<string, unknown>[] = [];
  const seen = new Map<number, Record<string, unknown>>();
  const relations = new Map<string, string[]>(); // every relation the rows carried, by target
  let issueBoundHit = false;
  // Relevance first, then whatever room is left: the bound is the shared rule's sibling bound, and a
  // row the chain has no business with must not be what uses it up (Root's crowded-board probe).
  // Relevance here is only the containment test on the paths this chain was asked about - naming a
  // path is not being a pair, and the rule still decides that.
  const relevantOf = new Map<number, boolean>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || relevantOf.has(id)) continue;
    relevantOf.set(id, id === scope.issueId || namesAnyFile(row, scope.files));
  }
  for (const wantRelevant of [true, false]) {
    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      if (relevantOf.get(id) !== wantRelevant) continue;
      if (seen.size >= candidateCap) {
        // Only a cut CANDIDATE makes this read incomplete for the shared rule: a board row that names
        // none of these paths is not a member of this chain, so its absence is not a missing edge.
        if (wantRelevant) issueBoundHit = true;
        continue;
      }
      seen.set(id, row);
      issues.push(row);
    }
  }
  // Relations are collected from every row the read returned, including an issue the bound cut: an
  // edge the board has is a fact, and whether it is knowable is the rule's question, not this one's.
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    // A join row that carried no relation is not a relation to issue 0: the left join answers NULL,
    // and Number(null) is 0, so an unreadable source must be read as "no relation", not as an id.
    if (row.blockedBySource === null || row.blockedBySource === undefined) continue; // no relation here
    const source = Number(row.blockedBySource);
    if (!Number.isFinite(source) || source === id) continue; // unparseable, or a self relation
    const key = String(id);
    if (!relations.has(key)) relations.set(key, []);
    const list = relations.get(key)!;
    if (!list.includes(String(source))) list.push(String(source));
  }
  // Two ways this read can stop short, each with its own witness. A candidate beyond the bound is one;
  // the other is the row bound itself: a read that came back with as many rows as it asked for has no
  // proof that nothing further matched, and few distinct issues is not such a proof either - 48 joined
  // rows can be 47 rows of one issue and one row of another. Filling the row bound is reported.
  const rowBoundReached = rows.length >= rowLimit;
  // A relation keeps its far end even when this read did not keep that end, because the edge is a fact
  // the board has (Root's 8428 review: with 999 erased, 101 -> 999 -> 102 reached the shared rule as no
  // relation at all and it called the graph cycle-free and appliable). Sending it is not a judgement:
  // the rule's own unknown-fact test answers `appliable false`, "unknown facts for 1 record(s): 999",
  // and its cycle test refuses when the far end is a closed node it can read. Nothing here judges.
  // Only a relation whose TARGET this read cut cannot travel - and that is the truncated case.
  const blockedBy = new Map<string, string[]>();
  for (const [id, sources] of relations) {
    if (!seen.has(Number(id)) || !sources.length) continue;
    blockedBy.set(id, sources);
  }
  return { issues, blockedBy, truncated: issueBoundHit || rowBoundReached };
}
