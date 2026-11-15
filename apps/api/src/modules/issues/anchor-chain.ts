// The adapter half of the anchor chain (sentinel-prod-8428 slice S2b): ask the shared rule for its
// plan over the facts slice S2a read, apply what the plan says is appliable through ItsPlan's own
// existing relation writer, and report the rest on the issue that was just stamped.
//
// WHERE THE RULE LIVES: nowhere here. The order (bottom-up by line start, ties by creation then id),
// the adjacent-pair construction (three members give two edges, never a star), the same-file candidate
// test, the claimed test, the presence test, the cycle test and the truncation guard are
// sentinel-prod-8427's `tools/anchor_map_chain.py --plan-json` - one shared implementation, no second
// copy (Misty's 8427 scope note). This module supplies the facts, runs the tool, and does what its
// answer says. Nothing here picks an order, chooses a pair or judges a cycle.
//
// Gates (Root's decisions D2, D3, D4, D5, plus A4's published contract):
//   * `appliable` is the only permission to write. If the shared plan says the input was refused (`ok`
//     false) or that anything is unknown, claimed, cyclic, truncated or in conflict (`appliable`
//     false), this step writes NOTHING and reports what the plan said, in the tool's own words.
//     A4 confirmed the JSON path refuses on the planner's `graph_unknown` and `graph_truncated`
//     before any link, so `appliable` carries both guards. Per-edge flags are re-checked as a second
//     net, never as an independent decision.
//   * A candidate read that itself had to cut the graph (slice S2a's `truncated`) withholds the same
//     permission here: incomplete facts are never treated as a licence to write.
//   * Edges go ONLY through the existing `addIssueLink`: it inserts the pair in one statement, keeps
//     it unique in either order through issue_link_pair_kind_idx, and writes the history entries for
//     BOTH issue ids in the same transaction. No raw insert, no second writer, no second pair table.
//   * D2 as Root clarified it: the sanctioned auto hook - the post-stamp tail in `anchor-stamp.ts` -
//     names the internal actor itself, the existing named system actor `AnchorMap`, so the auto
//     behavior works with no configuration step and no environment variable. Any other, direct call
//     is PLAN-ONLY unless a name is configured. Client input can never choose the internal actor: it
//     is a constant in this module, not an option, and the id passed to the writer always stays
//     null - a system change, never a fabricated user.
//   * Scope is one project. A candidate in another project is still SENT to the plan (so an overlap is
//     visible) and its edges are REPORTED, never written; a side whose project is unknown is refused
//     too, and an issue with no known project declines the whole step rather than guessing a scope.
//   * Symbol-only anchors need no extra symbol resolution: they are named as files with no line, which
//     is the shared rule's creation/id fallback case rather than a guessed line.
//
// Bounded: the two statements slice S2a reads, one planner subprocess with a timeout and a buffer, one
// report entry. The proofs run against the recorded fake the 8428 tests already use; no live database
// is assumed, and `SKIP` in a proof log means the shared tool was not installed, never a pass.

import { execFile } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { recordActivity } from './activity';
import {
  LINKS_PER_ISSUE,
  SIBLING_CAP,
  candidateFacts,
  failureText,
  knownProject,
  nativeRecord,
  projectsOf,
  selfRow,
  type ChainFacts,
  type FactsFn,
  type FileAnchors,
} from './anchor-chain-facts';

export type { ChainFacts, FileAnchors, FactsFn, NativeIssue } from './anchor-chain-facts';

// The shared chain tool, beside the shared map tool on the sentinel checkout. Overridden by
// ITSAPLAN_ANCHOR_CHAIN_TOOL exactly as the stamp overrides ITSAPLAN_ANCHOR_MAP_TOOL: the tool itself
// reads no environment variable, so the adapter owns which path it runs and passes it as argv - the
// direction of dependency stays the right way round. (Canonical HEAD carries this file; the serving
// checkout's working tree does not materialise it, which is why proofs name a checkout that does.)
export const CANONICAL_ANCHOR_CHAIN_TOOL =
  '/Users/misty/sentinel/sentinel-prod/tools/anchor_map_chain.py';
// The interpreter A4 item 5 fixed for the stamp: the sanctioned env, never a bare python3.
export const SANCTIONED_CHAIN_PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';
// The mode the shared tool publishes today (A4's exact spelling, landed at sentinel master
// 2dfa0024): the earlier draft name from slice S1 was never implemented and the tool does not accept it.
export const CHAIN_PLAN_MODE = '--plan-json';

export function anchorChainTool(): string {
  return process.env.ITSAPLAN_ANCHOR_CHAIN_TOOL ?? CANONICAL_ANCHOR_CHAIN_TOOL;
}
export function anchorChainPython(): string {
  return process.env.ITSAPLAN_ANCHOR_MAP_PYTHON ?? SANCTIONED_CHAIN_PYTHON;
}

// The one internal name this adapter may run under: the named system actor the 8428 stamp already
// uses for its own activity entry. It is a constant, not an option, so no caller outside this
// repository's own stamp tail can put a name on the chain, and no client request can either.
export const INTERNAL_CHAIN_ACTOR = 'AnchorMap';

/** A configured name, or undefined when nothing is configured. An explicitly empty value means
 * "plan only", which is how a deployment turns the auto write off without a code change. */
function actorOverride(): string | undefined {
  const raw = process.env.ITSAPLAN_ANCHOR_CHAIN_ACTOR;
  return raw === undefined ? undefined : raw.trim();
}

/** What a direct call may write: nothing, unless a name is configured. `chainStampedAnchors` below is
 * the entry the sanctioned post-stamp tail uses, and it does not need this to be set. */
export function chainActor(): string {
  return actorOverride() ?? '';
}

/** What the sanctioned auto hook runs as: the internal name, with no configuration required. */
export function stampChainActor(): string {
  return actorOverride() ?? INTERNAL_CHAIN_ACTOR;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** One planned adjacency of the shared order: `lower` must land before `upper`. `known` = the tool
 * knew both records, `present` = the edge already exists, `claimed` = the upper is not a fresh open
 * unassigned bead, `cycle` = applying it would close a cycle, `status` = the upper's own status. */
export interface ChainPlanEdge {
  lower: string;
  upper: string;
  known: boolean;
  present: boolean;
  claimed: boolean;
  cycle: boolean;
  status?: string;
}

export interface ChainPlanFile {
  path: string;
  order: string[];
  edges: ChainPlanEdge[];
  conflict: boolean;
}

export interface ChainPlan {
  ok?: boolean;
  appliable?: boolean;
  me_id?: string;
  files?: ChainPlanFile[];
  conflict_files?: string[];
  diagnostics?: string[];
}

export interface ChainOutcome {
  status: 'reported' | 'no_siblings' | 'no_self_row' | 'failed';
  text: string;
  applied: number;
  reported: number;
  reason?: string;
}

export type PlannerFn = (payload: unknown, timeoutMs: number) => Promise<ChainPlan>;
export type LinkWriterFn = (
  issueId: number,
  targetIssueId: number,
  kind: 'blocks',
  actorUserId: string | null,
) => Promise<unknown>;

export interface ChainOptions {
  /** Injectable so a proof can show a plan, a refusal, or a contained write failure without a live
   * database. There is deliberately no actor field: an actor is chosen by which entry point runs, not
   * by a caller. Production calls pass none of these. */
  planner?: PlannerFn;
  linkWriter?: LinkWriterFn;
  facts?: FactsFn;
  timeoutMs?: number;
  siblingCap?: number;
}

/** A 409 from the existing writer is the idempotent outcome Root ruled on: the edge is already there.
 * Any other failure stays visible in the report. */
function isAlreadyLinked(error: unknown): boolean {
  return (error as { status?: number })?.status === 409;
}

// The shipped planner call: the shared tool, its published plan mode, the facts on the child's stdin,
// the plan on stdout. No shell, no temp file, no second implementation, bounded by timeout and buffer.
// A refusal (the tool's own exit 2 with `ok` false and its diagnostics on stdout) is returned as the
// plan it is, so the report can quote the tool instead of a stack trace.
const shippedPlanner: PlannerFn = (payload, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      anchorChainPython(),
      ['-B', anchorChainTool(), CHAIN_PLAN_MODE],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (error: ExecException | null, stdout: string) => {
        let plan: ChainPlan | null = null;
        try {
          plan = JSON.parse(stdout) as ChainPlan;
        } catch {
          plan = null;
        }
        if (plan && typeof plan.ok === 'boolean') return resolve(plan);
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout) as ChainPlan);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    // The facts go to the child's own stdin: no shell, no temp file, no argument-list limit, and a
    // body of any size reaches the shared tool unchanged.
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
    child.stdin?.on('error', reject);
  });

// The writer the shipped code uses: ItsPlan's existing relation writer, imported at call time so this
// module's import graph stays acyclic (`links.ts` imports `./service`, and `service.ts` imports the
// stamp that calls this module). It is the only place this step may write, and the actor id it receives
// stays null.
const shippedWriter: LinkWriterFn = async (issueId, targetIssueId, kind, actorUserId) => {
  const { addIssueLink } = await import('./links');
  return addIssueLink(issueId, targetIssueId, kind, actorUserId);
};

/**
 * Ask the shared rule, then apply what it says is appliable and report the rest. Never throws and
 * never rejects: a chain step that could not run is its own truthful report entry, exactly like the
 * stamp it follows, and it writes nothing on its own authority.
 */
async function runChain(
  issueId: number,
  anchors: FileAnchors[],
  options: ChainOptions,
  actor: string,
): Promise<ChainOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.siblingCap ?? SIBLING_CAP;
  const planner = options.planner ?? shippedPlanner;
  const linkWriter = options.linkWriter ?? shippedWriter;
  const readFacts = options.facts ?? candidateFacts;

  if (!anchors.length) return { status: 'no_siblings', text: '', applied: 0, reported: 0 };

  let self: Record<string, unknown> | null;
  let facts: ChainFacts;
  try {
    self = await selfRow(issueId);
    facts = await readFacts(cap, { issueId, files: anchors.map((anchor) => anchor.file) });
  } catch (error) {
    return {
      status: 'failed',
      text: `anchor chain: candidate read failed: ${failureText(error)}`,
      applied: 0,
      reported: 0,
      reason: failureText(error),
    };
  }

  if (!self) return { status: 'no_self_row', text: '', applied: 0, reported: 0 };
  const others = facts.issues.filter((row) => Number(row.id) !== issueId);
  if (!others.length) return { status: 'no_siblings', text: '', applied: 0, reported: 0 };

  // Without a known project for the stamped issue the same-project rule cannot be honoured, so the
  // chain declines instead of guessing a scope.
  const project = knownProject(self.projectId);
  if (project === null)
    return {
      status: 'no_siblings',
      text: `anchor chain: issue ${issueId} has no known project, nothing linked`,
      applied: 0,
      reported: 0,
    };
  const own = projectsOf(issueId, project, others);

  const payload = {
    me_id: String(issueId),
    // Exact normalized paths, the same grammar the restamp matches on. The shared planner reads the
    // start lines out of each record's own text, so no separate range list is sent.
    files: anchors.map((a) => ({ path: a.file })),
    issues: [
      nativeRecord(self, facts.blockedBy),
      ...others.map((row) => nativeRecord(row, facts.blockedBy)),
    ],
  };

  let plan: ChainPlan;
  try {
    plan = await planner(payload, timeoutMs);
  } catch (error) {
    const text = `anchor chain: shared planner ${anchorChainTool()}: ${failureText(error)}`;
    await recordChain(issueId, text);
    return { status: 'failed', text, applied: 0, reported: 0, reason: failureText(error) };
  }

  const files = Array.isArray(plan.files) ? plan.files : [];
  const refused = plan.ok === false;
  // `appliable` is the plan's own permission to change anything, and a candidate read that had to cut
  // the graph short withholds permission here too. Nothing else decides it.
  const permission = !refused && plan.appliable === true && !facts.truncated;
  const withholdReason = facts.truncated
    ? 'this read was capped, the graph is incomplete'
    : 'the plan is not appliable';
  const lines: string[] = [];
  const diagnostics: string[] = [];
  let applied = 0;
  let reported = 0;

  for (const file of files) {
    if (file.conflict)
      diagnostics.push(`  conflict: ${file.path} is claimed at more than one place`);
    if (Array.isArray(file.order) && file.order.length)
      lines.push(`  ${file.path} landing order: ${file.order.join(', ')}`);
    for (const e of file.edges ?? []) {
      const label = `  ${file.path}: ${e.lower} blocks ${e.upper}`;
      const lowerProject = own.get(e.lower);
      const upperProject = own.get(e.upper);
      if (!e.known) {
        lines.push(`${label} - unknown facts, nothing written`);
        reported += 1;
      } else if (
        lowerProject === null ||
        upperProject === null ||
        lowerProject === undefined ||
        upperProject === undefined
      ) {
        lines.push(`${label} - project unknown on one side, not linked`);
        reported += 1;
      } else if (lowerProject !== project || upperProject !== project) {
        lines.push(`${label} - CROSS-PROJECT, not linked`);
        diagnostics.push(
          `  cross-project overlap on ${file.path}: ${e.lower} (project ${lowerProject}) and ${e.upper} (project ${upperProject}) are not both in project ${project}`,
        );
        reported += 1;
      } else if (e.cycle) {
        lines.push(`${label} - CYCLE refused, nothing of this file written`);
        reported += 1;
      } else if (e.claimed) {
        lines.push(
          `${label} - reported only: the blocked issue is claimed (${e.status ?? 'status'})`,
        );
        reported += 1;
      } else if (!permission) {
        lines.push(`${label} - planned only: ${withholdReason}`);
        reported += 1;
      } else if (e.present) {
        lines.push(`${label} - edge present`);
        reported += 1;
      } else if (!actor) {
        lines.push(`${label} - planned only: no chain actor named`);
        reported += 1;
      } else {
        try {
          await linkWriter(Number(e.lower), Number(e.upper), 'blocks', null);
          lines.push(`${label} - linked`);
          applied += 1;
        } catch (error) {
          if (isAlreadyLinked(error)) {
            lines.push(`${label} - edge present (rejected as a duplicate)`);
            reported += 1;
          } else {
            lines.push(`${label} - write failed: ${failureText(error)}`);
            reported += 1;
          }
        }
      }
    }
  }

  if (!files.length) diagnostics.push('  the shared plan named no shared file: nothing to chain');
  if (facts.truncated)
    diagnostics.push(
      // Both bounds are named, because either one can be the bound the read hit: the distinct-issue
      // bound, or the row bound the relations multiply. The owner reading this needs the real limits.
      `  candidate read capped at ${cap + 1} issues / ${(cap + 2) * LINKS_PER_ISSUE} joined rows: the graph is incomplete, nothing written`,
    );
  for (const conflict of plan.conflict_files ?? [])
    diagnostics.push(`  conflict file: ${conflict}`);
  for (const note of plan.diagnostics ?? []) diagnostics.push(`  planner: ${note}`);

  const head = `anchor chain (same-file blocks): ${files.length} shared file(s), actor ${actor || 'none: plan-only'}, plan ${refused ? 'refused' : permission ? 'appliable' : 'not appliable'}`;
  const text = [head, ...lines, ...diagnostics].join('\n');
  await recordChain(issueId, text);
  return { status: 'reported', text, applied, reported };
}

/** The sanctioned auto hook: the tail of the 8428 stamp, running as the internal system actor with no
 * configuration step. Client input is not a parameter here, so it cannot name an actor. */
export function chainStampedAnchors(
  issueId: number,
  anchors: FileAnchors[],
  options: ChainOptions = {},
): Promise<ChainOutcome> {
  return runChain(issueId, anchors, options, stampChainActor());
}

/** Any other caller: the same plan and the same report, but plan-only unless a name is configured. */
export function chainSameFileAnchors(
  issueId: number,
  anchors: FileAnchors[],
  options: ChainOptions = {},
): Promise<ChainOutcome> {
  return runChain(issueId, anchors, options, chainActor());
}

// One report entry on the issue that was just stamped: a system-actor entry, so it reaches the feed
// without mentioning an agent, and it never edits the body. The per-edge history entries are the
// existing writer's own, written to both issue ids inside its transaction.
async function recordChain(issueId: number, text: string): Promise<void> {
  try {
    await recordActivity(issueId, [{ action: 'anchor_chain_report', subject: { value: text } }], {
      system: 'AnchorChain',
    });
  } catch {
    // A report that could not be recorded is not a reason to fail the stamp it follows.
  }
}
