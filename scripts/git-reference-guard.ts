// scripts/git-reference-guard.ts — sentinel-prod-8429 inventory row 8 R4: the forward-only shared-ref rule, carried from
// sentinel-prod/.beads/hooks/reference-transaction.
//
// WHY this rule exists at all (the 2026-08-06 incident, recorded in the Sentinel hook): a lane ran `git reset ee6107f3`
// twice against a checkout several lanes were sharing, and five commits other lanes had already built on were orphaned.
// git's reference-transaction hook is the only hook that can still abort a ref move while it is pending, so this is the
// rule's one place in the toolchain: at the `prepared` state its exit status aborts the whole transaction.
//
// WHY it is not a lefthook command (measured 2026-11-15, lefthook 2.2.2, scratch repository, receipt
// /Users/misty/Output/reports/8429_qwen2_plan_cli_R2_RETURN/lefthook_reference_transaction_probe.log): lefthook will
// install a reference-transaction hook, but it hands the command only the {1} state template — no positional
// arguments — and it does NOT forward stdin. git delivers the transaction as lines of `<old> <new> <ref>` on stdin and
// nowhere else, so a lefthook command cannot know which ref is moving. This rule therefore reads stdin directly, and
// the hook that runs it is the tracked script scripts/hooks/reference-transaction. Installing that hook is Root's
// operation, not this file's.
//
// WHAT R4 REPAIRED (Root's RETURN, msg_8a62499e1568; both defects reproduced in a lane-owned scratch repository with
// the R3 bytes installed there, receipt
// /Users/misty/Output/reports/8429_qwen2_row8_reference_guard_R1/R4_ATOM/R4_SCRATCH_BEFORE.log). D1: a linked worktree
// that has `main` checked out rewound `refs/heads/main` with exit 0, because "the branch this checkout has checked out"
// was read as sufficient. D2: `git rebase` detaches HEAD while it replays, so the final move of the branch being
// rebased arrived as a non-forward move of a branch no checkout held, and the guard left the rebase half done with
// HEAD detached. Root's two rulings are what this file now implements: `refs/heads/main` is protected in every
// checkout and never receives an own-branch or rebase exception; and while a linked worktree is detached for an active
// rebase, the record git writes in that worktree's own git directory (`rebase-merge/head-name` and `orig-head`, or the
// `rebase-apply` pair where git writes one) names the single branch allowed to move backwards, bound to the commit that
// ref actually holds. Missing, stale or unrelated metadata grants nothing. No bypass, no framework, no broad scan.

// WHAT it refuses (R3, Root's G1 ruling in msg_839cd43fe0f0 as passed on by Claude Today): every move of a local
// branch ref must be ancestor-to-descendant, EXCEPT that a linked worktree may move backwards the one branch it has
// checked out. A detached HEAD grants no branch exception, because dropping HEAD does not make a shared branch
// private. A ref that git reports as a creation is judged from what the ref actually holds, not from the all-zero git
// prints: `git branch -f <existing> <older>` and a genuine new branch arrive as the same line, so a forced overwrite
// of a shared branch would otherwise pass as a creation. Deleting a branch (new all-zero) and a no-op are allowed.
// The R2 header called creation "always allowed", which was the stale narrative Claude Today named as L3: a creation is
// allowed when git says the ref is absent, and refused when git cannot say.
//
// WHAT it does not do: nothing outside refs/heads/* is touched — tags and remote-tracking refs move for ordinary
// reasons and the Sentinel hook skipped them too. It fails closed when a fact is missing: if git cannot say which
// checkout this is, cannot say which branch a worktree has checked out, or cannot say whether the old commit is an
// ancestor of the new one, the move is refused. A guard that allows on an unknown is not a guard. And it carries no
// bypass variable: the commit-msg guard has BD_SKIP_BEAD_ID_CHECK because Misty's NO-JAM law names one for that rule,
// and no such allowance was granted here. An operator who is authorised to move a ref does so through git's own
// per-invocation hook override, which this file neither implements nor advertises.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  type CheckedOutRef,
  type RebaseRecord,
  type ReferenceRefusal,
  ZERO,
  guarded,
  parseRefLines,
  refuse,
  transactionDecision,
} from './git-reference-rule';

// The rule is this module's public face: the leaf holds it, and the guard re-exports it so the installed helper and
// every test reach it under one name.
export * from './git-reference-rule';

/** git's own states for this hook, copied from the Sentinel hook's case statement. */
export const REFERENCE_STATES = ['preparing', 'prepared', 'committed', 'aborted'] as const;
/** The token this hook answers with when git asks what it is (the Sentinel hook's capability line). */
export const REFERENCE_CAPABILITY = 'itsaplan-reference-transaction-forward-only-v1';

export interface GitAnswer {
  ok: boolean;
  out: string;
  err: string;
  /** git's own exit code: 0 yes, 1 no, 128 git could not answer at all. */
  status: number;
}

export interface ReferenceAdapterDeps {
  /** git's stdin, read once. Injected so the rule is provable without a repository or a hook. */
  readStdin: () => string;
  runGit: (args: readonly string[]) => GitAnswer;
  detectLinkedWorktree: () => boolean | undefined;
  /** Reading a file git named, not a path this file guessed. A file that is not there answers null. */
  readFile: (path: string) => string | null;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

/** Shared checkout has its own .git directory; a linked worktree points at the common one. Same test row 7 used. */
export function linkedWorktreeFromGit(runGit: ReferenceAdapterDeps['runGit']): boolean | undefined {
  const gitDir = runGit(['rev-parse', '--git-dir']);
  const commonDir = runGit(['rev-parse', '--git-common-dir']);
  if (!gitDir.ok || !commonDir.ok) return undefined;
  if (gitDir.out === '' || commonDir.out === '') return undefined;
  return gitDir.out !== commonDir.out;
}

/**
 * `git symbolic-ref HEAD`, read the way git answers: 0 with the ref name for a branch, 128 with
 * "ref HEAD is not a symbolic ref" for a detached HEAD (measured 2026-11-15, git 2.56.x, receipt
 * /Users/misty/Output/reports/8429_qwen2_row8_reference_guard_R1/G1_GIT_SEMANTICS.log). Anything else is git failing
 * to answer, and an unanswered question grants no exception.
 */
export function checkedOutRefFromGit(runGit: ReferenceAdapterDeps['runGit']): CheckedOutRef {
  const answer = runGit(['symbolic-ref', 'HEAD']);
  if (answer.ok && answer.out !== '') return { state: 'ref', ref: answer.out.trim() };
  if (answer.status === 128 && answer.err.includes('not a symbolic ref'))
    return { state: 'detached' };
  return { state: 'unknown' };
}

/** The two directories git uses to record a rebase in progress; only one of them is ever present. */
const REBASE_DIRS = ['rebase-merge', 'rebase-apply'] as const;

/**
 * Which branch this checkout is rebasing, read the way git answers: `git rev-parse --git-path <name>` names the file
 * for the checkout git was called in - the linked worktree's own directory for a lane, the common .git for the shared
 * checkout - so this file never builds a git path itself. Measured 2026-11-15 with git 2.56.0 (receipt
 * /Users/misty/Output/reports/8429_qwen2_row8_reference_guard_R1/R4_ATOM/R4_REBASE_METADATA.log): the default
 * merge-backend rebase writes rebase-merge/head-name (refs/heads/<branch>) and rebase-merge/orig-head in the worktree
 * directory; `git rebase --apply` writes a rebase-apply directory that carries no head-name and no orig-head at all,
 * so that form records nothing to bind and grants nothing. A head-name git wrote without the refs/ prefix is read as a
 * branch under refs/heads/. Half a record - a name with no start commit, or the reverse - is no record.
 */
export function rebaseRecordFromGit(
  runGit: ReferenceAdapterDeps['runGit'],
  readFile: ReferenceAdapterDeps['readFile'],
): RebaseRecord | null {
  for (const dir of REBASE_DIRS) {
    const named = runGit(['rev-parse', '--git-path', `${dir}/head-name`]);
    const started = runGit(['rev-parse', '--git-path', `${dir}/orig-head`]);
    if (!named.ok || !started.ok || named.out.trim() === '' || started.out.trim() === '') continue;
    const headName = readFile(named.out.trim());
    const origHead = readFile(started.out.trim());
    if (headName === null || origHead === null) continue;
    const name = headName.trim();
    const start = origHead.trim();
    if (name === '' || start === '') continue;
    return { headName: name.startsWith('refs/') ? name : `refs/heads/${name}`, origHead: start };
  }
  return null;
}

export function refusalText(refusal: ReferenceRefusal): string {
  return [
    `BLOCKED (${refusal.rule}): ${refusal.message}`,
    '',
    `  Code: ${refusal.code}`,
    `  Compliant form: ${refusal.safe_form}`,
    '',
  ].join('\n');
}

/**
 * 0 allow, 1 refusal (which aborts the pending transaction), 2 the hook was called wrong. Only `prepared` can still
 * abort, so the other states answer 0 and stay out of the way, as the Sentinel hook did.
 */
export function runReferenceGuard(state: string | undefined, deps: ReferenceAdapterDeps): number {
  if (state === undefined || state === '') {
    deps.writeErr(
      refusalText(
        refuse(
          'REFERENCE_STATE_MISSING',
          'git hands the reference-transaction hook its state as the first argument, and none arrived',
          `call it the way the hook does: bun run scripts/git-reference-guard.ts <state>  (states: ${REFERENCE_STATES.join(', ')})`,
        ),
      ),
    );
    return 2;
  }
  if (state === 'capability') {
    deps.writeOut(`${REFERENCE_CAPABILITY}\n`);
    return 0;
  }
  if (!(REFERENCE_STATES as readonly string[]).includes(state)) {
    deps.writeErr(
      refusalText(
        refuse(
          'REFERENCE_STATE_UNKNOWN',
          `unknown reference-transaction state: ${state}`,
          `states git actually sends: ${REFERENCE_STATES.join(', ')}`,
        ),
      ),
    );
    return 2;
  }
  if (state !== 'prepared') return 0;

  const { moves, malformed } = parseRefLines(deps.readStdin());
  for (const line of malformed)
    deps.writeErr(`reference-transaction: unparseable ref line ignored: ${line}\n`);
  if (guarded(moves).length === 0) return 0;

  const linkedWorktree = deps.detectLinkedWorktree();
  const refusals = transactionDecision(moves, {
    linkedWorktree,
    // git answers 1 when the first commit is not an ancestor of the second, and 128 when it could not answer at all.
    // Only the first is a proven non-fast-forward; the second is an unknown, and an unknown refuses.
    ancestryOf: (move, from) => {
      if (linkedWorktree === undefined) return undefined;
      if (from === ZERO) return true;
      const answer = deps.runGit(['merge-base', '--is-ancestor', from, move.new]);
      if (answer.ok) return true;
      return answer.status === 1 && answer.out === '' ? false : undefined;
    },
    // The zero git prints for `git branch -f <existing> <older>` is not a creation. Ask git what the ref holds.
    // Measured semantics of `show-ref --verify`: 0 with "<sha> <ref>" for a ref that is there, 128 with an empty
    // stdout and "not a valid ref" on stderr for one that is not, and any other answer is git failing to answer.
    currentRefOf: (ref) => {
      const answer = deps.runGit(['show-ref', '--verify', ref]);
      if (answer.ok && answer.out !== '')
        return { state: 'value', value: answer.out.split(/\s+/)[0] ?? '' };
      if (answer.status === 128 && answer.out === '' && answer.err.includes('not a valid ref'))
        return { state: 'absent' };
      return { state: 'unknown' };
    },
    checkedOutRefOf: () => checkedOutRefFromGit(deps.runGit),
    rebaseOf: () => rebaseRecordFromGit(deps.runGit, deps.readFile),
  });
  if (refusals.length === 0) return 0;
  for (const refusal of refusals) deps.writeErr(`${refusalText(refusal)}\n`);
  return 1;
}

// Only the shipped CLI wires real stdin and real git; the rule itself lives in ./git-reference-rule.ts.
if (import.meta.main) {
  const spawnGit = (args: readonly string[]): GitAnswer => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    const status = typeof result.status === 'number' ? result.status : 128;
    return {
      ok: status === 0,
      out: (result.stdout ?? '').trim(),
      err: (result.stderr ?? '').trim(),
      status,
    };
  };
  process.exit(
    runReferenceGuard(process.argv[2], {
      // fd 0 is the whole point of this hook: git's ref lines arrive on stdin and nowhere else.
      readStdin: () => readFileSync(0, 'utf8'),
      runGit: spawnGit,
      detectLinkedWorktree: () => linkedWorktreeFromGit(spawnGit),
      readFile: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
      writeOut: (text) => {
        process.stdout.write(text);
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    }),
  );
}
