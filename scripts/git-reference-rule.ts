// scripts/git-reference-rule.ts — sentinel-prod-8429 row 8 R4 named responsibility leaf: the rule itself, written as
// pure functions. scripts/git-reference-guard.ts (the module the installed hook runs) imports it and re-exports it, so
// every test, and every caller, still imports the guard by one name. Nothing in this file reads git, reads a file, or
// touches a repository: each answer the rule needs arrives as an argument, which is what makes every branch of it
// provable with no checkout and no hook installed. WHY the rule exists at all, what it refuses and what it deliberately
// does not do is written once, in the header of scripts/git-reference-guard.ts; R4 added Root's two rulings there and
// they are implemented below (main is never exempt, and a lane rebase is exempt only against its own record).

export type ReferenceCode =
  | 'REFERENCE_STATE_MISSING'
  | 'REFERENCE_STATE_UNKNOWN'
  | 'CHECKOUT_FACT_MISSING'
  | 'GIT_ANCESTRY_UNKNOWN'
  | 'CURRENT_REF_UNKNOWN'
  | 'CHECKED_OUT_REF_UNKNOWN'
  | 'MAIN_REF_ALWAYS_PROTECTED'
  | 'REBASE_RECORD_DENIED'
  | 'SHARED_REF_NOT_FAST_FORWARD';

export interface ReferenceRefusal {
  rule: string;
  code: ReferenceCode;
  /** Names the ref and both commits, so the writer sees what git was about to do. */
  message: string;
  /** The compliant form the writer can paste, never a lecture. */
  safe_form: string;
}

export interface RefMove {
  old: string;
  new: string;
  ref: string;
}

export const ZERO = '0000000000000000000000000000000000000000';
/** The branch every lane shares. Root: it is protected in every checkout, and no exception is ever granted to it. */
export const MAIN_REF = 'refs/heads/main';
export function refuse(code: ReferenceCode, message: string, safe_form: string): ReferenceRefusal {
  return { rule: 'reference-transaction-forward-only', code, message, safe_form };
}

/** git's stdin protocol: `<old> <new> <ref>`, one move per line. A malformed line is reported, never guessed at. */
export function parseRefLines(stdin: string): { moves: RefMove[]; malformed: string[] } {
  const moves: RefMove[] = [];
  const malformed: string[] = [];
  for (const line of stdin.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) {
      malformed.push(line);
      continue;
    }
    moves.push({ old: parts[0] ?? '', new: parts[1] ?? '', ref: parts[2] ?? '' });
  }
  return { moves, malformed };
}

/** Only a local branch ref is this rule's business, exactly as in the Sentinel hook. */
export function guarded(moves: readonly RefMove[]): RefMove[] {
  return moves.filter((move) => move.ref.startsWith('refs/heads/'));
}

/** The true starting commit, which for a forced overwrite is git's answer and not the zero git printed. */
function describe(move: RefMove, from: string): string {
  const short = (sha: string) => (sha === ZERO ? 'nothing' : sha.slice(0, 12));
  return `${move.ref}: ${short(from)} -> ${short(move.new)}`;
}

/** Asked of git with `show-ref --verify`: absent, a sha git proved it holds, or an answer that never came. */
export type CurrentRef =
  { state: 'absent' } | { state: 'value'; value: string } | { state: 'unknown' };

/** Asked of git with `symbolic-ref HEAD`: the branch this checkout has checked out, detached, or unanswered. */
export type CheckedOutRef =
  { state: 'detached' } | { state: 'ref'; ref: string } | { state: 'unknown' };

/**
 * One move, one answer. `linkedWorktree` undefined means git could not prove which checkout this is, and that refuses;
 * `ancestry` undefined means git could not prove the move was forward, and that refuses too; `checkedOutRef` undefined
 * or unknown in a linked worktree refuses, because the exception Root's ruling grants is named by that fact. Each
 * refusal is the point of the rule, not a fallback.
 *
 * WHY `currentRef` exists (measured 2026-11-15 with git 2.56.0, receipt
 * /Users/misty/Output/reports/8429_qwen2_row8_reference_guard_R1/plumbing_coverage_probe.log): git hands
 * `git branch -f <existing branch> <older commit>` and `git update-ref refs/heads/<branch> <older>` to this hook with
 * old = all zeros, the same line it hands for a genuine creation.
 */
export interface MoveFacts {
  linkedWorktree: boolean | undefined;
  ancestry: boolean | undefined;
  /** Asked in a checkout whose move is not its own branch, for a line that claims to create. */
  currentRef?: CurrentRef;
  /** Which branch this checkout has checked out, or 'detached'. Required to grant the worktree exception. */
  checkedOutRef?: CheckedOutRef;
  /** Required: the rebase this checkout is in, or null when git records none. Silence grants no exception. */
  rebase: RebaseRecord | null;
}

/** What git records about the rebase it is doing in this checkout: the branch it is rebasing and where it started. */
export type RebaseRecord = { headName: string; origHead: string };

/** The branch a linked worktree may rewind: the one it has checked out, and no other, and never main. */
export function ownCheckedOutBranch(move: RefMove, facts: MoveFacts): boolean {
  return (
    facts.linkedWorktree === true &&
    move.ref !== MAIN_REF &&
    facts.checkedOutRef !== undefined &&
    facts.checkedOutRef.state === 'ref' &&
    facts.checkedOutRef.ref === move.ref
  );
}

/**
 * The rebase exception (Root's second ruling). git detaches HEAD while it replays, so the branch a rebase belongs to is
 * not in HEAD: it is in the record this worktree's own git directory holds. The exception is that branch and no other,
 * it is never main, and it holds only while the record still matches reality - the ref must still hold the commit the
 * rebase started from. A detached HEAD with no record, a record naming a different branch, and a record whose start
 * commit no longer matches the ref each grant nothing.
 */
export function activeRebaseOfThisBranch(move: RefMove, facts: MoveFacts): boolean {
  const record = facts.rebase;
  const current = facts.currentRef;
  return (
    facts.linkedWorktree === true &&
    move.ref !== MAIN_REF &&
    facts.checkedOutRef !== undefined &&
    facts.checkedOutRef.state === 'detached' &&
    record !== null &&
    record.headName === move.ref &&
    current !== undefined &&
    current.state === 'value' &&
    current.value === record.origHead
  );
}

/** Root's first ruling: main is not anybody's own branch, not the checkout that has it, not a rebase that names it. */
export function mainRewindProtected(move: RefMove, facts: MoveFacts): boolean {
  const named = facts.checkedOutRef?.state === 'ref' ? facts.checkedOutRef.ref : '';
  return (
    move.ref === MAIN_REF &&
    facts.linkedWorktree === true &&
    (named === MAIN_REF || facts.rebase?.headName === MAIN_REF)
  );
}

export function moveDecision(move: RefMove, facts: MoveFacts): ReferenceRefusal | null {
  if (move.new === ZERO) return null;
  if (move.old === move.new) return null;

  if (facts.linkedWorktree === undefined) {
    return refuse(
      'CHECKOUT_FACT_MISSING',
      'git did not answer which checkout this is, so the guard cannot tell the shared checkout from a lane worktree',
      're-run inside the repository (git rev-parse --git-dir --git-common-dir must both answer)',
    );
  }
  // A linked worktree may rewind the branch it has checked out. Nothing else in it is exempt, main included.
  if (facts.linkedWorktree === true) {
    if (ownCheckedOutBranch(move, facts)) return null;
    if (facts.checkedOutRef === undefined || facts.checkedOutRef.state === 'unknown') {
      return refuse(
        'CHECKED_OUT_REF_UNKNOWN',
        `git did not answer which branch this linked worktree has checked out, so the guard cannot tell its own branch ` +
          `from a branch the other lanes share, and ${move.ref} is not allowed to move backwards on that uncertainty`,
        'make the question answerable (git symbolic-ref HEAD must answer), or move the branch this worktree has checked out',
      );
    }
  }

  let from = move.old;
  if (from === ZERO) {
    const current = facts.currentRef;
    if (current === undefined || current.state === 'absent') return null;
    if (current.state === 'unknown') {
      return refuse(
        'CURRENT_REF_UNKNOWN',
        `git reported ${move.ref} as a creation, but could not say whether that branch already exists, so the guard ` +
          'cannot tell a new branch from a forced overwrite of a shared one',
        'make the question answerable (git show-ref --verify <ref> must answer), or create the branch in your own worktree',
      );
    }
    from = current.value;
    if (from === move.new) return null;
  }

  if (facts.ancestry === undefined) {
    return refuse(
      'GIT_ANCESTRY_UNKNOWN',
      `git could not tell whether ${describe(move, from)} is a fast-forward, so a non-forward move of a shared branch cannot be ruled out`,
      'commit forward, or make the ancestry checkable (both commits present in this repository)',
    );
  }
  if (facts.ancestry === true) return null;

  // git is mid-rebase in this worktree and is moving the very branch its rebase record names, from the commit that
  // record says it started at and that the ref still holds. That is a lane rebasing its own branch: allowed.
  if (activeRebaseOfThisBranch(move, facts)) return null;

  const record = facts.rebase;
  if (mainRewindProtected(move, facts)) {
    return refuse(
      'MAIN_REF_ALWAYS_PROTECTED',
      `refused: ${describe(move, from)} rewinds refs/heads/main in a linked worktree ${
        record?.headName === MAIN_REF ? 'whose rebase names main' : 'that has main checked out'
      }. No checkout and no rebase makes the branch every lane shares somebody's own branch.`,
      'rebase or merge your own branch onto main (git rebase main), and leave refs/heads/main to Root to move',
    );
  }
  // A record that does not cover this move is worth naming only where an exception was ever on the table: the shared
  // checkout has no exception to deny, and its forward-only refusal is the accepted explanation.
  if (record !== null && facts.linkedWorktree === true) {
    return refuse(
      'REBASE_RECORD_DENIED',
      `refused: ${describe(move, from)} is not a fast-forward, and the rebase in progress in this worktree names ` +
        `${record.headName} starting at ${record.origHead.slice(0, 12)}, not this branch at the commit it holds now. ` +
        'Rebase metadata that does not match this ref licenses no rewind.',
      'finish or abort the rebase that is running (git rebase --continue, or git rebase --abort), then move this ' +
        'branch forward, or rebase the branch your own worktree has checked out',
    );
  }

  return refuse(
    'SHARED_REF_NOT_FAST_FORWARD',
    `refused: ${describe(move, from)} is not a fast-forward, and it is not the branch this checkout has checked out. ` +
      'This repository is shared by several lanes, and a move that drops commits orphans the work other lanes built on.' +
      (move.old === ZERO
        ? ' git reported this as a creation, so the guard asked git what the ref actually held.'
        : ''),
    'move forward instead (git merge/revert the commits you want gone), or rewind the branch your own worktree has ' +
      'checked out: git worktree add ../<your-name> <branch> && git -C ../<your-name> reset <commit>',
  );
}

/** The whole transaction: every guarded move is decided, and one refusal refuses the transaction. */
export function transactionDecision(
  moves: readonly RefMove[],
  facts: {
    linkedWorktree: boolean | undefined;
    ancestryOf: (move: RefMove, from: string) => boolean | undefined;
    /** Required, not optional (Claude Today's L2): an absent question here would open the rule to a forced overwrite. */
    currentRefOf: (ref: string) => CurrentRef;
    /** Required for the same reason: the worktree exception is granted only against a fact git stated. */
    checkedOutRefOf: () => CheckedOutRef;
    /** Required: what rebase git is running in this checkout, or null when it records none. */
    rebaseOf: () => RebaseRecord | null;
  },
): ReferenceRefusal[] {
  const refusals: ReferenceRefusal[] = [];
  const checkedOutRef = facts.checkedOutRefOf();
  // git only detaches HEAD to run a rebase, so this question is worth asking in exactly that case.
  const rebase = checkedOutRef.state === 'detached' ? facts.rebaseOf() : null;
  for (const move of guarded(moves)) {
    const decisionFacts: MoveFacts = {
      linkedWorktree: facts.linkedWorktree,
      ancestry: undefined,
      checkedOutRef,
      rebase,
    };
    if (ownCheckedOutBranch(move, decisionFacts)) continue;
    // A line that claims to create is asked what the ref actually holds, unless this is the worktree's own branch. A
    // rebase exception is bound the same way: the record only counts while the ref still holds where it started.
    const current = move.old === ZERO || rebase !== null ? facts.currentRefOf(move.ref) : undefined;
    const from = current !== undefined && current.state === 'value' ? current.value : move.old;
    const refusal = moveDecision(move, {
      ...decisionFacts,
      ancestry: facts.ancestryOf(move, from),
      currentRef: current,
    });
    if (refusal !== null) refusals.push(refusal);
  }
  return refusals;
}
