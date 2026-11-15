// sentinel-prod-8429 row 8 R4 tests, first half: the forward-only shared-ref rule, git's plumbing answers and the hook
// adapter. No repository, database, network, installed hook or shared .git is touched. Transaction facts arrive as
// arguments the way git's stdin hands them and git's answers are injected, so every branch of the rule is reachable
// without a checkout. The cases that run the tracked hook script itself live in the sibling file
// scripts/git-reference-hook.test.ts, moved there byte-for-byte at Root's instruction (msg_82adbd1b8a8d) so that each
// test leaf stays 400 lines or fewer. The two R4 rulings (main is never exempt; a lane rebase is exempt only against
// its own record) are proved in scripts/git-reference-rebase.test.ts, and what git really does through an installed
// copy of this hook is proved in scripts/git-reference-scratch.test.ts.
//
// WHAT IS NOT PROVEN HERE, said plainly: that the hook is installed, and that git really aborts a reset through it.
// Installation is a Root operation this lane may not perform, so what is proven is the rule, the exit codes and the
// tracked hook script's behaviour when it is run directly. A live abort proof - and any test that actually rewound a
// shared branch - belongs to Root's guarded operation, and none is attempted here.

import { describe, expect, test } from 'bun:test';

import {
  type CheckedOutRef,
  type GitAnswer,
  type ReferenceAdapterDeps,
  type MoveFacts,
  REFERENCE_CAPABILITY,
  REFERENCE_STATES,
  checkedOutRefFromGit,
  guarded,
  linkedWorktreeFromGit,
  moveDecision,
  ownCheckedOutBranch,
  parseRefLines,
  runReferenceGuard,
  transactionDecision,
} from './git-reference-guard';

const ZERO = '0000000000000000000000000000000000000000';
const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333';
const CODE = 'SHARED_REF_NOT_FAST_FORWARD';
const LANE = { state: 'ref', ref: 'refs/heads/lane-branch' } satisfies CheckedOutRef;
const REWIND = `${OLD} ${OTHER} refs/heads/main\n`;
const NOOP = `${ZERO} ${ZERO} refs/heads/main\n`;

const move = (old: string, next: string, ref = 'refs/heads/main') => ({ old, new: next, ref });
const fact = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  linkedWorktree: false,
  ancestry: true,
  rebase: null,
  ...over,
});
type TxFacts = Parameters<typeof transactionDecision>[1];
const txFacts = (over: Partial<TxFacts> = {}): TxFacts => ({
  linkedWorktree: false,
  ancestryOf: () => true,
  currentRefOf: () => ({ state: 'absent' }),
  checkedOutRefOf: () => ({ state: 'detached' }),
  rebaseOf: () => null,
  ...over,
});

/** git's answers, injected: 0 yes, 1 no, 128 could not answer. `err` is what makes 128 mean different things. */
const answer = (over: Partial<GitAnswer> = {}): GitAnswer => ({
  ok: true,
  out: '',
  err: '',
  status: 0,
  ...over,
});
const mergeBaseFails = (args: readonly string[]): GitAnswer =>
  args[0] === 'merge-base' ? answer({ ok: false, status: 1 }) : goodGit(args);

/** The git stand-in that passes every test below: shared checkout, ancestry proven, ref absent, HEAD on a branch. */
function goodGit(args: readonly string[]): GitAnswer {
  if (args[0] === 'merge-base') return answer();
  if (args[0] === 'show-ref')
    return answer({ ok: false, status: 128, err: `fatal: '${args[2]}' - not a valid ref` });
  if (args[0] === 'symbolic-ref') return answer({ out: 'refs/heads/main' });
  return answer({ out: '.git' });
}

/** Run the adapter with injected stdin and injected git, and report status, output, what it said and what it asked. */
function probe(
  state: string | undefined,
  stdin: string,
  git: (args: readonly string[]) => GitAnswer = goodGit,
) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const deps: ReferenceAdapterDeps = {
    readStdin: () => stdin,
    runGit: (args) => {
      asked.push(args[0]);
      return git(args);
    },
    detectLinkedWorktree: () => false,
    readFile: () => null,
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  };
  return { status: runReferenceGuard(state, deps), out: out.join(''), err: err.join(''), asked };
}

describe('the stdin protocol and one move', () => {
  test('git lines parse exactly, and a malformed line is reported rather than guessed at', () => {
    const parsed = parseRefLines(`${OLD} ${NEW} refs/heads/main\n${NEW} ${ZERO} refs/o/x\n\n  \n`);
    expect(parsed.moves).toEqual([move(OLD, NEW), move(NEW, ZERO, 'refs/o/x')]);
    expect(parsed.malformed).toEqual([]);
    expect(parseRefLines('one-field-only').malformed).toEqual(['one-field-only']);
  });

  test('only a local branch ref is this rule business, and a transaction with no ref asks nothing', () => {
    expect(
      guarded([move(OLD, NEW, 'refs/tags/v1'), move(OLD, NEW, 'refs/remotes/origin/main')]),
    ).toEqual([]);
    expect(guarded([move(OLD, NEW, 'refs/heads/main')])).toEqual([
      move(OLD, NEW, 'refs/heads/main'),
    ]);
    const empty = probe('prepared', '');
    expect([empty.status, empty.err, empty.asked]).toEqual([0, '', []]);
  });

  test('a fast-forward is allowed; a rewind is refused and names the ref, both commits and the compliant form', () => {
    expect(moveDecision(move(OLD, NEW), fact())).toBeNull();
    const refusal = moveDecision(move(OLD, OTHER), fact({ ancestry: false }));
    expect(refusal?.code).toBe(CODE);
    for (const part of ['refs/heads/main', '111111111111', '333333333333'])
      expect(refusal?.message).toContain(part);
    expect(refusal?.safe_form).toContain('your own worktree');
  });

  test('a deletion, a no-op and a creation git says is absent are allowed', () => {
    const back = { linkedWorktree: false, ancestry: false } as const;
    expect(moveDecision(move(NEW, ZERO), fact(back))).toBeNull();
    expect(moveDecision(move(NEW, NEW), fact(back))).toBeNull();
    expect(
      moveDecision(move(ZERO, NEW), fact({ ...back, currentRef: { state: 'absent' } })),
    ).toBeNull();
  });

  test("git's zero for a forced overwrite is judged from what the ref holds, not from the zero", () => {
    // Measured with git 2.56.x: `git branch -f <existing> <older>` arrives as `0000… <older> refs/heads/<name>`,
    // byte-for-byte the line a creation sends. The guard asks git what the ref holds and judges that.
    const held = { ancestry: false, currentRef: { state: 'value', value: OLD } } as const;
    const forced = moveDecision(move(ZERO, OTHER), fact(held));
    expect(forced?.code).toBe(CODE);
    expect(forced?.message).toContain(OLD.slice(0, 12));
    expect(forced?.message).toContain('git reported this as a creation');
  });

  test('git answering neither way refuses, so the guard never allows on an unknown', () => {
    const unknownRef = moveDecision(move(ZERO, NEW), fact({ currentRef: { state: 'unknown' } }));
    expect(unknownRef?.code).toBe('CURRENT_REF_UNKNOWN');
    expect(moveDecision(move(OLD, NEW), fact({ ancestry: undefined }))?.code).toBe(
      'GIT_ANCESTRY_UNKNOWN',
    );
    expect(moveDecision(move(OLD, NEW), fact({ linkedWorktree: undefined }))?.code).toBe(
      'CHECKOUT_FACT_MISSING',
    );
  });
});

describe("Root's G1 ruling: a linked worktree may rewind only its own checked-out branch", () => {
  const back = fact({ linkedWorktree: true, ancestry: false, checkedOutRef: LANE });

  test('the branch the worktree has checked out may move backwards, and that is its own fact', () => {
    expect(ownCheckedOutBranch(move(OLD, OTHER, 'refs/heads/lane-branch'), back)).toBe(true);
    expect(moveDecision(move(OLD, OTHER, 'refs/heads/lane-branch'), back)).toBeNull();
  });

  test('every other local branch in that worktree must move forward, main first among them', () => {
    const refusal = moveDecision(move(OLD, OTHER, 'refs/heads/main'), back);
    expect(refusal?.code).toBe(CODE);
    expect(refusal?.message).toContain('not the branch this checkout has checked out');
    const held = { ...back, currentRef: { state: 'value', value: OLD } } as const;
    expect(moveDecision(move(ZERO, OTHER, 'refs/heads/main'), fact(held))?.code).toBe(CODE);
  });

  test('a forward move of another branch in a linked worktree is still allowed', () => {
    const facts = fact({ linkedWorktree: true, ancestry: true, checkedOutRef: LANE });
    expect(moveDecision(move(OLD, NEW, 'refs/heads/main'), facts)).toBeNull();
  });

  test('a detached HEAD grants no branch exception, and an unnamed checked-out branch refuses', () => {
    const detached = fact({
      linkedWorktree: true,
      ancestry: false,
      checkedOutRef: { state: 'detached' },
    });
    expect(ownCheckedOutBranch(move(OLD, OTHER, 'refs/heads/lane-branch'), detached)).toBe(false);
    const refusal = moveDecision(move(OLD, OTHER, 'refs/heads/lane-branch'), detached);
    expect(refusal?.code).toBe(CODE);
    for (const missing of [undefined, { state: 'unknown' } satisfies CheckedOutRef]) {
      const facts = fact({ linkedWorktree: true, ancestry: false, checkedOutRef: missing });
      expect(moveDecision(move(OLD, OTHER), facts)?.code).toBe('CHECKED_OUT_REF_UNKNOWN');
    }
  });

  test('a transaction decides per move: rewinding its own branch while main moves forward is clean', () => {
    const facts = txFacts({
      linkedWorktree: true,
      checkedOutRefOf: () => LANE,
      ancestryOf: (m) => m.new === NEW,
    });
    const own = [move(OLD, OTHER, 'refs/heads/lane-branch'), move(OLD, NEW, 'refs/heads/main')];
    const alsoMain = [
      move(OLD, OTHER, 'refs/heads/lane-branch'),
      move(NEW, OTHER, 'refs/heads/main'),
    ];
    expect(transactionDecision(own, facts)).toEqual([]);
    expect(transactionDecision(alsoMain, facts)).toHaveLength(1);
  });

  test('one bad move refuses the whole transaction, every refusal is reported and tags decide nothing', () => {
    const facts = txFacts({ ancestryOf: (m) => m.new !== OTHER });
    const mixed = [move(OLD, NEW), move(NEW, OTHER), move(OLD, OTHER, 'refs/heads/other')];
    const refusals = transactionDecision(mixed, facts);
    expect(refusals).toHaveLength(2);
    expect(refusals.map((r) => r.code)).toEqual([CODE, CODE]);
    expect(
      transactionDecision([move(OLD, OTHER, 'refs/tags/v2')], txFacts({ ancestryOf: () => false })),
    ).toEqual([]);
  });
});

describe("git's own plumbing answers, measured 2026-11-15 with git 2.56.x", () => {
  const newBranch = `${ZERO} ${NEW} refs/heads/a-new-branch\n`;

  test('show-ref --verify: 0 with a sha for a present ref, 128 and "not a valid ref" for an absent one', () => {
    const fresh = probe('prepared', newBranch);
    expect([fresh.status, fresh.out, fresh.err]).toEqual([0, '', '']);
    expect(fresh.asked).toContain('show-ref');
  });

  test('show-ref --verify: an answer that is neither of those is unknown, and unknown refuses', () => {
    const unableGit = (args: readonly string[]): GitAnswer =>
      args[0] === 'show-ref'
        ? answer({ ok: false, status: 128, err: 'fatal: unable to read' })
        : goodGit(args);
    const unable = probe('prepared', newBranch, unableGit);
    expect(unable.status).toBe(1);
    expect(unable.err).toContain('CURRENT_REF_UNKNOWN');
  });

  test('symbolic-ref HEAD: a branch, a detached HEAD and no answer are three different facts', () => {
    const onBranch = checkedOutRefFromGit(() => answer({ out: 'refs/heads/lane-branch' }));
    const detached = checkedOutRefFromGit(() =>
      answer({ ok: false, status: 128, err: 'fatal: ref HEAD is not a symbolic ref' }),
    );
    const silent = checkedOutRefFromGit(() =>
      answer({ ok: false, status: 128, err: 'fatal: unable to read' }),
    );
    expect([onBranch, detached, silent]).toEqual([
      { state: 'ref', ref: 'refs/heads/lane-branch' },
      { state: 'detached' },
      { state: 'unknown' },
    ]);
  });

  test('the checkout fact is git own answer, and no answer is a refusal', () => {
    const dirGit = (gitDir: string) => (args: readonly string[]) =>
      answer({ out: args[1] === '--git-dir' ? gitDir : '.git' });
    const lane = linkedWorktreeFromGit(dirGit('.git/worktrees/lane'));
    const shared = linkedWorktreeFromGit(dirGit('.git'));
    const unknown = linkedWorktreeFromGit(() => answer({ ok: false, status: 128 }));
    expect([lane, shared, unknown]).toEqual([true, false, undefined]);
  });
});

describe('the hook adapter', () => {
  test('prepared with a rewind in the shared checkout exits 1, which is what aborts the transaction', () => {
    const r = probe('prepared', REWIND, mergeBaseFails);
    expect(r.status).toBe(1);
    expect(r.err).toContain(CODE);
    expect(r.err).toContain('BLOCKED (reference-transaction-forward-only)');
  });

  test('prepared with a forced overwrite exits 1 even though git reported it as a creation', () => {
    const forcedGit = (args: readonly string[]): GitAnswer => {
      if (args[0] === 'merge-base') return answer({ ok: false, status: 1 });
      if (args[0] === 'show-ref') return answer({ out: `${OLD} refs/heads/main` });
      return goodGit(args);
    };
    expect(probe('prepared', `${ZERO} ${OTHER} refs/heads/main\n`, forcedGit).err).toContain(
      'git reported this as a creation',
    );
  });

  test('a forward commit, a no-op and an unparseable line all exit 0, and the bad line is named', () => {
    const forward = probe('prepared', `${OLD} ${NEW} refs/heads/main\n`);
    expect([forward.status, forward.err]).toEqual([0, '']);
    expect(probe('prepared', NOOP).status).toBe(0);
    const garbage = probe('prepared', 'garbage-line\n');
    expect(garbage.status).toBe(0);
    expect(garbage.err).toContain('unparseable ref line');
  });

  test('only prepared can refuse; the other states answer 0 without reading git at all', () => {
    for (const state of REFERENCE_STATES.filter((s) => s !== 'prepared')) {
      const r = probe(state, REWIND);
      expect([r.status, r.err, r.asked]).toEqual([0, '', []]);
    }
  });

  test('capability answers with the token, and a wrong or missing state is a wrong call, not an allow', () => {
    const capability = probe('capability', '');
    expect([capability.status, capability.out.trim()]).toEqual([0, REFERENCE_CAPABILITY]);
    expect([probe('banana', '').status, probe('', '').status, probe(undefined, '').status]).toEqual(
      [2, 2, 2],
    );
  });

  test('git failing to answer the ancestry check refuses, it does not wave the move through', () => {
    const silentGit = (args: readonly string[]): GitAnswer =>
      args[0] === 'merge-base'
        ? answer({ ok: false, status: 128, err: 'fatal: not a valid object name' })
        : goodGit(args);
    const r = probe('prepared', REWIND, silentGit);
    expect([r.status, r.err.includes('GIT_ANCESTRY_UNKNOWN')]).toEqual([1, true]);
  });
});
