// sentinel-prod-8429 row 8 R4, the two rulings Root returned (msg_8a62499e1568), proved as pure unit cases: refs/heads/main
// is never exempt from the forward-only rule, and a lane rebase is exempt only against the record git wrote for that
// branch in that worktree. Nothing here touches a repository, a database, a network, an installed hook or a shared .git:
// git's answers and the two rebase files arrive as injected arguments, exactly as scripts/git-reference-guard.ts asks for
// them. The live behaviour - git really rebasing, git really refusing - is proved in the sibling file
// scripts/git-reference-scratch.test.ts, and the R1-R3 cases stay in scripts/git-reference-guard.test.ts unchanged.

import { describe, expect, test } from 'bun:test';

import {
  type CheckedOutRef,
  type GitAnswer,
  type MoveFacts,
  type ReferenceAdapterDeps,
  type RebaseRecord,
  MAIN_REF,
  activeRebaseOfThisBranch,
  mainRewindProtected,
  moveDecision,
  ownCheckedOutBranch,
  rebaseRecordFromGit,
  runReferenceGuard,
  transactionDecision,
} from './git-reference-guard';

const ZERO = '0000000000000000000000000000000000000000';
const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333';
const LANE_REF = 'refs/heads/lane-branch';
const PARKED = 'refs/heads/parked';

const detached = { state: 'detached' } satisfies CheckedOutRef;
const onMain = { state: 'ref', ref: MAIN_REF } satisfies CheckedOutRef;
const onLane = { state: 'ref', ref: LANE_REF } satisfies CheckedOutRef;
const record = (headName: string, origHead: string): RebaseRecord => ({ headName, origHead });

const move = (old: string, next: string, ref = LANE_REF) => ({ old, new: next, ref });
const fact = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  linkedWorktree: true,
  ancestry: false,
  checkedOutRef: onLane,
  rebase: null,
  ...over,
});
const held = (sha: string) => ({ currentRef: { state: 'value', value: sha } as const });

/** The non-forward move of a branch this worktree does not own: the shape every refusal below starts from. */
const foreignRewind = (ref: string) => move(NEW, OTHER, ref);

describe("Root's first ruling: refs/heads/main is never exempt, not even where it is checked out", () => {
  const facts = fact({ checkedOutRef: onMain });

  test('a linked worktree that has main checked out may not rewind it (defect D1)', () => {
    expect(ownCheckedOutBranch(move(NEW, OTHER, MAIN_REF), facts)).toBe(false);
    const refusal = moveDecision(move(NEW, OTHER, MAIN_REF), facts);
    expect(refusal?.code).toBe('MAIN_REF_ALWAYS_PROTECTED');
    expect(refusal?.message).toContain('refs/heads/main');
    expect(refusal?.message).toContain('222222222222 -> 333333333333');
    expect(refusal?.safe_form).toContain('git rebase main');
  });

  test('a forward move of main in that same worktree is still an ordinary allowed move', () => {
    expect(moveDecision(move(OLD, NEW, MAIN_REF), { ...facts, ancestry: true })).toBeNull();
  });

  test('a deletion of main and a no-op are not rewinds, and stay what R2 ruled them', () => {
    expect(moveDecision(move(NEW, ZERO, MAIN_REF), facts)).toBeNull();
    expect(moveDecision(move(OLD, OLD, MAIN_REF), facts)).toBeNull();
  });

  test('the shared checkout keeps its own named refusal for a rewind of main, unchanged from R3', () => {
    const shared = fact({ linkedWorktree: false, checkedOutRef: onMain });
    expect(moveDecision(move(NEW, OTHER, MAIN_REF), shared)?.code).toBe(
      'SHARED_REF_NOT_FAST_FORWARD',
    );
  });

  test('main checked out nowhere is still refused, by the forward-only rule itself', () => {
    const refusal = moveDecision(foreignRewind(MAIN_REF), fact({ checkedOutRef: onLane }));
    expect(refusal?.code).toBe('SHARED_REF_NOT_FAST_FORWARD');
  });

  test('the main protection is a fact about the move, not about which refusal speaks last', () => {
    expect(mainRewindProtected(foreignRewind(MAIN_REF), facts)).toBe(true);
    expect(mainRewindProtected(foreignRewind(MAIN_REF), fact({ checkedOutRef: detached }))).toBe(
      false,
    );
    expect(mainRewindProtected(foreignRewind(LANE_REF), facts)).toBe(false);
  });
});

describe("Root's second ruling: a lane rebase is exempt only against its own record", () => {
  const rebasing = fact({
    checkedOutRef: detached,
    rebase: record(LANE_REF, NEW),
    ...held(NEW),
  });

  test('git has detached HEAD mid-rebase, and the record names this branch at the commit it holds: allowed', () => {
    expect(activeRebaseOfThisBranch(move(NEW, OTHER, LANE_REF), rebasing)).toBe(true);
    expect(moveDecision(move(NEW, OTHER, LANE_REF), rebasing)).toBeNull();
  });

  test('the exception follows the branch the record names, and only that one', () => {
    const refusal = moveDecision(move(NEW, OTHER, PARKED), rebasing);
    expect(refusal?.code).toBe('REBASE_RECORD_DENIED');
    expect(refusal?.message).toContain(LANE_REF);
    expect(refusal?.message).toContain('222222222222');
  });

  test('a record whose start commit no longer matches the ref is stale, and a stale record grants nothing', () => {
    const stale = fact({
      checkedOutRef: detached,
      rebase: record(LANE_REF, OLD),
      ...held(NEW),
    });
    expect(activeRebaseOfThisBranch(move(NEW, OTHER, LANE_REF), stale)).toBe(false);
    expect(moveDecision(move(NEW, OTHER, LANE_REF), stale)?.code).toBe('REBASE_RECORD_DENIED');
  });

  test('git unable to say what the ref holds leaves the record unbound, and an unbound record grants nothing', () => {
    const unknown = fact({ checkedOutRef: detached, rebase: record(LANE_REF, NEW) });
    expect(moveDecision(move(NEW, OTHER, LANE_REF), unknown)?.code).toBe('REBASE_RECORD_DENIED');
    const missing = fact({
      checkedOutRef: detached,
      rebase: record(LANE_REF, NEW),
      currentRef: { state: 'absent' },
    });
    expect(moveDecision(move(NEW, OTHER, LANE_REF), missing)?.code).toBe('REBASE_RECORD_DENIED');
  });

  test('a detached HEAD with no rebase record is no exception at all (Claude Today c)', () => {
    expect(
      activeRebaseOfThisBranch(move(NEW, OTHER, LANE_REF), fact({ checkedOutRef: detached })),
    ).toBe(false);
    expect(moveDecision(move(NEW, OTHER, LANE_REF), fact({ checkedOutRef: detached }))?.code).toBe(
      'SHARED_REF_NOT_FAST_FORWARD',
    );
  });

  test('a rebase whose record names main protects main (Claude Today d)', () => {
    const facts = fact({
      checkedOutRef: detached,
      rebase: record(MAIN_REF, NEW),
      ...held(NEW),
    });
    expect(activeRebaseOfThisBranch(move(NEW, OTHER, MAIN_REF), facts)).toBe(false);
    expect(moveDecision(move(NEW, OTHER, MAIN_REF), facts)?.code).toBe('MAIN_REF_ALWAYS_PROTECTED');
  });

  test('a rewind of an unrelated branch during that rebase still refuses (Claude Today d and e)', () => {
    expect(moveDecision(move(NEW, OTHER, PARKED), rebasing)?.code).toBe('REBASE_RECORD_DENIED');
    // main is not named by this rebase and is not checked out here, so the accepted forward-only refusal is the one
    // that speaks; the named main refusal fires wherever a checkout or a rebase does name main.
    expect(moveDecision(move(NEW, OTHER, MAIN_REF), rebasing)?.code).toBe('REBASE_RECORD_DENIED');
    expect(moveDecision(move(NEW, OTHER, MAIN_REF), fact({ checkedOutRef: detached }))?.code).toBe(
      'SHARED_REF_NOT_FAST_FORWARD',
    );
  });

  test('the shared checkout gets no rebase exception: Row8 protects it forward-only, ruling unchanged', () => {
    const shared = fact({
      linkedWorktree: false,
      checkedOutRef: detached,
      rebase: record(PARKED, NEW),
      ...held(NEW),
    });
    expect(activeRebaseOfThisBranch(move(NEW, OTHER, PARKED), shared)).toBe(false);
    expect(moveDecision(move(NEW, OTHER, PARKED), shared)?.code).toBe(
      'SHARED_REF_NOT_FAST_FORWARD',
    );
  });

  test('the exception never reaches a branch other than the one this worktree is rebasing, whole transaction', () => {
    const refusals = transactionDecision([move(NEW, OTHER, LANE_REF), move(NEW, OTHER, PARKED)], {
      linkedWorktree: true,
      ancestryOf: () => false,
      currentRefOf: (ref) =>
        ref === LANE_REF ? { state: 'value', value: NEW } : { state: 'value', value: NEW },
      checkedOutRefOf: () => detached,
      rebaseOf: () => record(LANE_REF, NEW),
    });
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.code).toBe('REBASE_RECORD_DENIED');
    expect(refusals[0]?.message).toContain(PARKED);
    expect(refusals[0]?.message).not.toContain(`${PARKED} starting`);
  });
});

describe('reading the rebase record out of git, with git answers and file contents injected', () => {
  const answer = (over: Partial<GitAnswer> = {}): GitAnswer => ({
    ok: true,
    out: '',
    err: '',
    status: 0,
    ...over,
  });
  const gitPaths =
    (files: Record<string, string>) =>
    (args: readonly string[]): GitAnswer => {
      if (args[0] === 'rev-parse' && args[1] === '--git-path') {
        const path = files[args[2] ?? ''] === undefined ? '' : `/abs/${args[2]}`;
        return answer({ out: path });
      }
      return answer({ ok: false, status: 128 });
    };
  const read =
    (files: Record<string, string>) =>
    (path: string): string | null =>
      files[path.replace('/abs/', '')] ?? null;
  const mergeBackend = {
    'rebase-merge/head-name': 'refs/heads/lane-branch\n',
    'rebase-merge/orig-head': `${OLD}\n`,
  };

  test('the merge backend writes head-name and orig-head in this checkout, and that is the record', () => {
    expect(rebaseRecordFromGit(gitPaths(mergeBackend), read(mergeBackend))).toEqual({
      headName: LANE_REF,
      origHead: OLD,
    });
  });

  test('a head-name git wrote without the refs/ prefix is still read as that branch', () => {
    const short = {
      'rebase-merge/head-name': 'lane-branch\n',
      'rebase-merge/orig-head': `${OLD}\n`,
    };
    expect(rebaseRecordFromGit(gitPaths(short), read(short))?.headName).toBe(LANE_REF);
  });

  test('half a record is no record: a name with no start commit, or a start with no name', () => {
    const nameless = { 'rebase-merge/head-name': '\n', 'rebase-merge/orig-head': `${OLD}\n` };
    const startless = {
      'rebase-merge/head-name': 'refs/heads/lane-branch\n',
      'rebase-merge/orig-head': '',
    };
    expect(rebaseRecordFromGit(gitPaths(nameless), read(nameless))).toBeNull();
    expect(rebaseRecordFromGit(gitPaths(startless), read(startless))).toBeNull();
  });

  test('git 2.56.0 writes no head-name at all for `git rebase --apply`, so that form records nothing', () => {
    // Measured: the rebase-apply directory carries 0001..next/patch/quiet and friends, no head-name, no orig-head.
    expect(rebaseRecordFromGit(gitPaths({}), read({}))).toBeNull();
  });

  test('a file git named that is not on disk, and a git that cannot answer, are both no record', () => {
    const files = { 'rebase-merge/head-name': 'refs/heads/lane-branch\n' };
    expect(rebaseRecordFromGit(gitPaths(files), () => null)).toBeNull();
    expect(
      rebaseRecordFromGit(
        () => answer({ ok: false, status: 128 }),
        () => 'x',
      ),
    ).toBeNull();
  });
});

describe('the adapter, end to end, on a rebase and on a main rewind', () => {
  const answer = (over: Partial<GitAnswer> = {}): GitAnswer => ({
    ok: true,
    out: '',
    err: '',
    status: 0,
    ...over,
  });
  const LANE_LINE = `${NEW} ${OTHER} ${LANE_REF}\n`;
  const MAIN_LINE = `${NEW} ${OTHER} ${MAIN_REF}\n`;

  const run = (
    stdin: string,
    git: (args: readonly string[]) => GitAnswer,
    readFile: (path: string) => string | null,
    linked: boolean,
    detect = () => linked,
  ) => {
    const err: string[] = [];
    const asked: string[] = [];
    const deps: ReferenceAdapterDeps = {
      readStdin: () => stdin,
      runGit: (args) => {
        asked.push(args.slice(0, 3).join(' '));
        return git(args);
      },
      detectLinkedWorktree: detect,
      readFile,
      writeOut: () => {},
      writeErr: (text) => err.push(text),
    };
    return { status: runReferenceGuard('prepared', deps), err: err.join(''), asked };
  };

  const laneRebaseGit = (args: readonly string[]): GitAnswer => {
    if (args[0] === 'symbolic-ref')
      return answer({ ok: false, status: 128, err: 'fatal: ref HEAD is not a symbolic ref' });
    if (args[0] === 'show-ref') return answer({ out: `${NEW} ${LANE_REF}` });
    if (args[0] === 'merge-base') return answer({ ok: false, status: 1 });
    if (args[1] === '--git-path') return answer({ out: `/abs/${args[2]}` });
    return answer();
  };
  const rebaseFiles = (path: string): string | null =>
    path.endsWith('rebase-merge/head-name')
      ? `${LANE_REF}\n`
      : path.endsWith('rebase-merge/orig-head')
        ? `${NEW}\n`
        : null;

  test("a lane rebasing its own branch exits 0, which is what lets git's rebase finish (defect D2)", () => {
    const ran = run(LANE_LINE, laneRebaseGit, rebaseFiles, true);
    expect([ran.status, ran.err]).toEqual([0, '']);
  });

  test('the same transaction refuses the branch that rebase does not name', () => {
    const ran = run(`${NEW} ${OTHER} ${PARKED}\n`, laneRebaseGit, rebaseFiles, true);
    expect(ran.status).toBe(1);
    expect(ran.err).toContain('REBASE_RECORD_DENIED');
  });

  test('a rewind of main in a worktree that has main checked out exits 1 and says why (defect D1)', () => {
    const git = (args: readonly string[]): GitAnswer =>
      args[0] === 'symbolic-ref' ? answer({ out: MAIN_REF }) : laneRebaseGit(args);
    const ran = run(MAIN_LINE, git, () => null, true);
    expect(ran.status).toBe(1);
    expect(ran.err).toContain('MAIN_REF_ALWAYS_PROTECTED');
  });

  test('the rebase question is asked when HEAD is detached, and not when HEAD names a branch', () => {
    const detachedRun = run(LANE_LINE, laneRebaseGit, rebaseFiles, true);
    expect(detachedRun.asked).toContain('rev-parse --git-path rebase-merge/head-name');
    const branchGit = (args: readonly string[]): GitAnswer =>
      args[0] === 'symbolic-ref' ? answer({ out: LANE_REF }) : laneRebaseGit(args);
    const branchRun = run(LANE_LINE, branchGit, () => null, true);
    expect(branchRun.status).toBe(0);
    expect(branchRun.asked).not.toContain('rev-parse --git-path rebase-merge/head-name');
  });
});
