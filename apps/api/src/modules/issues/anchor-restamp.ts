// Landing restamp (sentinel-prod-8428, A4 item 3): after a landing, re-stamp the issues whose exact
// anchored file paths changed in the landed range. Selection is unfinished, non-archived work on a
// LEFT join, so an issue off any column row is selected rather than dropped, and body refs match
// `git diff --name-only` entries exactly. A per-issue failure is recorded, never aborting the sweep;
// an issue cap and a wall-clock deadline bound the diff, the candidate read and each tool call; caps
// must be finite and positive. The boundary advances only after a completed sweep, a capped run leaves a
// resumable cursor, and a failed run keeps both so the issues it could not stamp stay pending.

import { execFileSync } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db, issue, projectColumn } from '@repo/db';
import { fileRefs, mapStoreDir, stampIssueAnchors, type StampOutcome } from './anchor-stamp';

// The terminal column states in the existing lifecycle (schema check:
// backlog | unstarted | started | completed | canceled).
export const TERMINAL_STATE_TYPES = ['completed', 'canceled'] as const;

// Boundary bookkeeping: the AFTER sha of the last landing whose sweep RAN TO
// COMPLETION; the next sweep starts here, so a capped or failed run widens the
// next range instead of losing commits.
export function boundaryFile(): string {
  return (
    process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE ?? path.join(mapStoreDirBoundary(), '.last_landed')
  );
}
function mapStoreDirBoundary(): string {
  // Same Output/anchor_maps store the stamp writes to (issue-id part removed).
  return path.join(mapStoreDir(0), '..');
}

// Resumable cursor for an unfinished range: the issue a capped sweep worked on
// last in [before, after]. Written by a capped run, cleared when a sweep
// completes, and honoured by the next sweep of the same range.
export interface PendingRange {
  before: string;
  after: string;
  last_issue_id: number;
}

export function pendingFile(): string {
  return `${boundaryFile()}.pending`;
}

// Awaited, rename-into-place write: a caller cannot continue with a boundary it
// did not finish writing.
async function writeTextAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await Bun.write(tmp, content);
  await fsp.rename(tmp, file);
}

export function readBoundary(): string | null {
  try {
    const v = readFileSync(boundaryFile(), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function writeBoundary(after: string): Promise<boolean> {
  try {
    await writeTextAtomic(boundaryFile(), `${after}\n`);
    return true;
  } catch {
    // Boundary bookkeeping never fails a landing; the next range just reuses
    // the previous boundary.
    return false;
  }
}

export async function readPending(): Promise<PendingRange | null> {
  try {
    const doc = JSON.parse(await Bun.file(pendingFile()).text()) as PendingRange;
    if (typeof doc?.before !== 'string' || typeof doc?.after !== 'string') return null;
    if (!Number.isFinite(doc?.last_issue_id)) return null;
    return doc;
  } catch {
    return null;
  }
}

async function writePending(pending: PendingRange): Promise<void> {
  try {
    await writeTextAtomic(pendingFile(), `${JSON.stringify(pending)}\n`);
  } catch {
    // A cursor that could not be written means the next run restarts the range.
  }
}

async function clearPending(): Promise<void> {
  try {
    await fsp.rm(pendingFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Persist the checkpoint for a receipt: 'advanced' only when the sweep completed
 * (not capped, nothing failed), in which case the boundary moves to `after` and
 * any cursor is cleared. A capped run keeps the old boundary and records a cursor
 * at the issue it worked on last, so the rest of the range is resumed rather than
 * starved. A failed run keeps the boundary and the cursor exactly as they are:
 * the issues it could not stamp stay pending instead of being skipped past.
 */
export async function commitRestampCheckpoint(
  receipt: RestampReceipt,
): Promise<'advanced' | 'retained'> {
  if (!receipt.capped && receipt.failed === 0) {
    // WHY: a boundary that could not be written leaves the range where it was, so keep the cursor too.
    const written = await writeBoundary(receipt.after);
    if (!written) return 'retained';
    await clearPending();
    return 'advanced';
  }
  // WHY: a cursor written past a failed issue means the next run never retries it.
  if (receipt.capped && receipt.attempted > 0 && receipt.failed === 0) {
    await writePending({
      before: receipt.before,
      after: receipt.after,
      last_issue_id: receipt.last_attempted_issue_id ?? 0,
    });
  }
  return 'retained';
}

export interface RestampReceipt {
  before: string;
  after: string;
  changed_files: number;
  candidates: number;
  attempted: number;
  stamped: number;
  noop: number;
  failed: number;
  capped: boolean;
  cap_reason: string | null;
  /** Reason of the first failed stamp (R2 item 4); null when nothing failed. */
  failed_reason: string | null;
  /** Highest issue id this sweep worked on, for the resumable cursor. */
  last_attempted_issue_id: number | null;
  /** Issue id a resumed sweep continued after, null on a fresh range. */
  resumed_after: number | null;
}

const CAP_ISSUES = 100;
const CAP_SECONDS = 600;

// Resolve the landed range for a hook run. Order: explicit --before, then the
// recorded boundary (written by the last completed sweep), then - only when the
// caller states it is running inside a post-merge hook - git's own ORIG_HEAD,
// the pre-merge tip git writes before the hook runs. That is how a virgin
// checkout (no boundary file yet) gets its first real range instead of skipping
// every merge forever. Nothing is inferred from the reflog, and an unknown
// environment (a container boot) never invents a range: with no truthful source
// the run reports and skips. The returned `source` says which one was used.
export function resolveLandedRange(
  explicitBefore: string | null,
  gitRepo: string,
  hookMode: 'post-merge' | 'none' = 'none',
): { before: string; after: string; source: 'explicit' | 'boundary' | 'orig_head' } | null {
  const after = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: gitRepo,
    encoding: 'utf8',
  }).trim();
  const boundary = readBoundary();
  let before: string | null = explicitBefore ?? boundary;
  let source: 'explicit' | 'boundary' | 'orig_head' = explicitBefore ? 'explicit' : 'boundary';
  if (!before && hookMode === 'post-merge') {
    try {
      before = execFileSync('git', ['rev-parse', 'ORIG_HEAD'], {
        cwd: gitRepo,
        encoding: 'utf8',
      }).trim();
      source = 'orig_head';
    } catch {
      before = null;
    }
  }
  if (!before || before === after) return null;
  return { before, after, source };
}

interface RestampSelection {
  // drizzle SQL fragments (a join condition and a where clause).
  join: ReturnType<typeof sql>;
  where: ReturnType<typeof sql>;
}

// The sweep's selection: a LEFT join on the issue's own column id and a
// null-safe terminal filter, so an issue off any column row is still selected.
function selection(): RestampSelection {
  return {
    join: sql`${projectColumn.id} = ${issue.columnId}`,
    // drizzle's and() builds the SQL fragment; typed as its SQL surface.
    where: (and as unknown as (...a: unknown[]) => ReturnType<typeof sql>)(
      isNull(issue.archivedAt),
      // Null-safe terminal filter: an issue whose joined column row is absent
      // (state_type NULL) stays selected; only a real terminal state excludes.
      or(
        // drizzle's isNull() helper: the only null-safe form its builder offers.
        isNull(projectColumn.stateType),
        notInArray(projectColumn.stateType, [...TERMINAL_STATE_TYPES]),
      ),
    ),
  };
}

/** Stamp implementation used by the sweep: the shipped stampIssueAnchors, or a
 * proof's stand-in reporting the same StampOutcome union. */
export type StampFn = (
  issueId: number,
  body: string,
  options?: { timeoutMs?: number },
) => Promise<StampOutcome>;

export interface RestampOptions {
  /** Hard bound on how many issues one sweep may attempt (default CAP_ISSUES). */
  capIssues?: number;
  /** Wall-clock bound in seconds (default CAP_SECONDS). */
  capSeconds?: number;
  /**
   * Stamp implementation, injectable so a proof can show a per-issue failure
   * contained. Production calls never pass it: the shipped stamp is used.
   */
  stamp?: StampFn;
}

// A cap must be finite and positive: 0, a negative or NaN would stop every sweep
// or make the bound meaningless (R2 item 5).
function positiveCap(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\n/g, ' ').slice(0, 160);
}

// One bounded operation: it must finish inside the time the sweep still has,
// otherwise it is a cap, not an unbounded wait.
async function withinBudget<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded the ${ms}ms left`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Re-stamp the unfinished issues whose EXACT anchored paths changed in
// [before, after]. Returns the truthful receipt; never throws.
export async function restampIssuesForRange(
  before: string,
  after: string,
  gitRepo: string = process.cwd(),
  options: RestampOptions = {},
): Promise<RestampReceipt> {
  const receipt: RestampReceipt = {
    before,
    after,
    changed_files: 0,
    candidates: 0,
    attempted: 0,
    stamped: 0,
    noop: 0,
    failed: 0,
    capped: false,
    cap_reason: null,
    failed_reason: null,
    last_attempted_issue_id: null,
    resumed_after: null,
  };
  const capIssues = positiveCap(options.capIssues, CAP_ISSUES);
  const capSeconds = positiveCap(options.capSeconds, CAP_SECONDS);
  const stamp = options.stamp ?? stampIssueAnchors;
  const deadline = Date.now() + capSeconds * 1000;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  const cap = (reason: string): void => {
    receipt.capped = true;
    receipt.cap_reason = reason;
  };

  let changed: string[];
  try {
    changed = execFileSync('git', ['diff', '--name-only', before, after], {
      cwd: gitRepo,
      encoding: 'utf8',
      timeout: remainingMs(),
    })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // An unreadable range is a failure of the range itself: nothing was stamped
    // and the checkpoint keeps the range pending.
    receipt.cap_reason = `git diff failed: ${failureText(err)}`;
    receipt.failed += 1;
    return receipt;
  }
  receipt.changed_files = changed.length;
  if (!changed.length) return receipt;
  const changedSet = new Set(changed);

  // Unfinished issues, null-safe: a LEFT join keeps issues whose column row is
  // absent, and the terminal filter accepts a NULL state_type.
  const sel = selection();
  let rows: { id: number; description: string | null; columnId: number | null }[];
  try {
    rows = await withinBudget(
      remainingMs(),
      'candidate read',
      db
        .select({
          id: issue.id,
          description: issue.description,
          columnId: issue.columnId,
          stateType: projectColumn.stateType,
        })
        .from(issue)
        .leftJoin(projectColumn, sel.join)
        .where(sel.where),
    );
  } catch (err) {
    // The sweep never throws into a hook: an unreadable board is a truthful
    // failure in the receipt, and the checkpoint keeps the range pending.
    const message = failureText(err);
    if (message.includes('exceeded the')) cap(`candidate read: ${message}`);
    else receipt.cap_reason = `candidate read failed: ${message}`;
    if (!receipt.capped) receipt.failed += 1;
    return receipt;
  }
  // WHY sorted first: the rows arrive in query order, so a cap would keep an arbitrary subset.
  let hits = rows
    .filter((row) => fileRefs(row.description ?? '').some((ref) => changedSet.has(ref)))
    .sort((a, b) => Number(a.id) - Number(b.id));
  receipt.candidates = hits.length;
  if (!hits.length) return receipt;

  // A capped or failed earlier sweep of this same range left a cursor: continue
  // after the issue it finished with, so the same first N are not retried while
  // the rest of the range never runs.
  const pending = await readPending();
  if (pending && pending.before === before && pending.after === after) {
    hits = hits.filter((row) => row.id > pending.last_issue_id);
    receipt.resumed_after = pending.last_issue_id;
  }

  for (const row of hits) {
    if (receipt.attempted >= capIssues) {
      cap(
        `issue cap ${capIssues}: ${hits.length - receipt.attempted} candidates of ${receipt.candidates} still pending`,
      );
      break;
    }
    if (Date.now() > deadline) {
      cap(`wall clock ${capSeconds}s: ${hits.length - receipt.attempted} candidates still pending`);
      break;
    }
    receipt.attempted += 1;
    receipt.last_attempted_issue_id = row.id;
    try {
      // Every Git/tool operation inside the stamp gets only the time that is
      // left in this sweep's budget.
      const outcome = await stamp(row.id, row.description ?? '', { timeoutMs: remainingMs() });
      if (outcome.status === 'stamped') receipt.stamped += 1;
      else if (outcome.status === 'failed') {
        receipt.failed += 1;
        receipt.failed_reason ??= outcome.reason;
      } else receipt.noop += 1;
    } catch (error) {
      // A failure of the stamp CALL itself is still contained, and still a
      // failure rather than a noop.
      receipt.failed += 1;
      receipt.failed_reason ??= `stamp call: ${failureText(error)}`;
    }
  }
  return receipt;
}
