// scripts/git-guard-rules.test.ts — sentinel-prod-8429 rows 1 and 7: the bead-id commit-msg guard and the
// shared-checkout rebase refusal, proven without a database, without an installed hook and without a network.
//
// WHY a parity corpus instead of only my own cases: these rules came from sentinel-prod/.beads/hooks/commit-msg
// and sentinel-prod/.beads/hooks/pre-rebase. The test re-states the Sentinel hook's own acceptance and compares
// it against the ported decision subject by subject, so drift between the two is a failing test, not a note.
// WHY the real CLI is spawned: a git hook only sees an exit code and stderr. A unit test on the pure rule cannot
// prove the hook will get either.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  beadIdDecision,
  linkedWorktreeFromGit,
  main,
  rebaseDecision,
  refusalText,
  type AdapterDeps,
} from './git-guard-rules.ts';

// The Sentinel hook's acceptance, written out here so the comparison is visible in the test file.
const SENTINEL_BEAD_ID = /\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+(\.[0-9]+)?\b/;

function sentinelWouldAccept(subject: string): boolean {
  if (subject.startsWith('Merge ')) return true;
  return SENTINEL_BEAD_ID.test(subject);
}

const SUBJECTS = [
  'sentinel-prod-8429 (partial): add the guard rule',
  'sentinel-prod-8429: add the guard rule',
  'sentinel-prod-8427.1: close the audit-only child',
  'sentinel-prod-8428 (partial): integrate repaired anchor chain adapter and stamp tail',
  'BD-4nm: legacy bead shape',
  'fix-1: the loose shape Sentinel accepted, kept loose on purpose',
  'Merge branch main into qwen2/8429-git-guard-rules',
  'Merge: no space variant, which Sentinel refused too',
  'fix: add the guard rule',
  '8429: digits alone are not a bead id',
  'add guard rules for hooks',
  '',
  '   ',
];

function codes(decisions: readonly ReturnType<typeof beadIdDecision>[]): string[] {
  return decisions.map((decision) => (decision === null ? 'ALLOW' : decision.code));
}

describe('the bead-id rule accepts what the Sentinel hook accepted', () => {
  it('agrees with the Sentinel hook subject by subject over the whole corpus', () => {
    for (const subject of SUBJECTS) {
      expect(beadIdDecision({ subject }) === null).toBe(sentinelWouldAccept(subject));
    }
  });

  it('splits the corpus into exactly the allow and refusal counts it should', () => {
    const answers = codes(SUBJECTS.map((subject) => beadIdDecision({ subject })));
    expect(answers.filter((answer) => answer === 'ALLOW').length).toBe(7);
    expect(answers.filter((answer) => answer === 'BEAD_ID_MISSING').length).toBe(4);
    expect(answers.filter((answer) => answer === 'SUBJECT_MISSING').length).toBe(2);
  });

  it('names the subject it refused, so the writer knows which commit to fix', () => {
    const refusal = beadIdDecision({ subject: 'fix: add the guard rule' });
    expect(refusal).not.toBeNull();
    expect(refusal!.rule).toBe('commit-msg-bead-id');
    expect(refusal!.code).toBe('BEAD_ID_MISSING');
    expect(refusal!.message).toInclude('fix: add the guard rule');
    expect(refusal!.safe_form).toInclude('sentinel-prod-8429');
  });

  it('refuses an empty subject with its own code, because an empty file is not a commit message', () => {
    expect(beadIdDecision({ subject: '' })!.code).toBe('SUBJECT_MISSING');
    expect(beadIdDecision({ subject: '   ' })!.code).toBe('SUBJECT_MISSING');
  });

  it('exempts a merge subject and nothing else that starts with Merge', () => {
    expect(beadIdDecision({ subject: 'Merge branch main into qwen2/x' })).toBeNull();
    expect(beadIdDecision({ subject: 'Merge: no space variant' })!.code).toBe('BEAD_ID_MISSING');
  });

  it('honours the bypass value only when it is real, per the NO-JAM law', () => {
    expect(beadIdDecision({ subject: 'fix: add the guard rule', beadIdBypass: '1' })).toBeNull();
    expect(beadIdDecision({ subject: 'fix: add the guard rule', beadIdBypass: '' })!.code).toBe(
      'BEAD_ID_MISSING',
    );
    expect(
      beadIdDecision({ subject: 'fix: add the guard rule', beadIdBypass: undefined })!.code,
    ).toBe('BEAD_ID_MISSING');
  });

  it('reads no environment of its own, even when the bypass value is exported', () => {
    const previous = process.env.BD_SKIP_BEAD_ID_CHECK;
    process.env.BD_SKIP_BEAD_ID_CHECK = '1';
    try {
      expect(beadIdDecision({ subject: 'fix: add the guard rule' })!.code).toBe('BEAD_ID_MISSING');
    } finally {
      if (previous === undefined) delete process.env.BD_SKIP_BEAD_ID_CHECK;
      else process.env.BD_SKIP_BEAD_ID_CHECK = previous;
    }
  });
});

describe('the rebase rule refuses only where other lanes are building', () => {
  it('refuses in the shared checkout and names both ends of the rewrite', () => {
    const refusal = rebaseDecision({ linkedWorktree: false, onto: 'main', branch: 'master' });
    expect(refusal).not.toBeNull();
    expect(refusal!.rule).toBe('shared-checkout-rebase');
    expect(refusal!.code).toBe('SHARED_CHECKOUT_REBASE');
    expect(refusal!.message).toInclude('master');
    expect(refusal!.message).toInclude('main');
    expect(refusal!.safe_form).toInclude('git worktree add');
  });

  it('allows in a lane worktree, which is where the Sentinel hook told lanes to go', () => {
    expect(
      rebaseDecision({ linkedWorktree: true, onto: 'main', branch: 'qwen2/8429-git-guard-rules' }),
    ).toBeNull();
  });

  it('refuses when the checkout fact is missing, because a guard that allows on an unknown is not a guard', () => {
    expect(rebaseDecision({ linkedWorktree: undefined })!.code).toBe('CHECKOUT_FACT_MISSING');
  });

  it('says what it could not read when git gave it no branch or upstream name', () => {
    const refusal = rebaseDecision({ linkedWorktree: false });
    expect(refusal!.message).toInclude('the checked-out branch');
    expect(refusal!.message).toInclude('the named upstream');
  });
});

describe('the checkout fact comes from git layout, not from a path guess', () => {
  it('says false for the shared checkout, where git dir and common dir are the same directory', () => {
    const runGit = (): { ok: boolean; out: string } => ({ ok: true, out: '/repo/.git' });
    expect(linkedWorktreeFromGit(runGit)).toBe(false);
  });

  it('says true for a linked worktree, where the two answers differ', () => {
    const runGit = (args: readonly string[]): { ok: boolean; out: string } => ({
      ok: true,
      out: args.includes('--git-common-dir') ? '/repo/.git' : '/lane/.git',
    });
    expect(linkedWorktreeFromGit(runGit)).toBe(true);
  });

  it('says undefined when git cannot answer, or answers with nothing', () => {
    expect(
      linkedWorktreeFromGit((): { ok: boolean; out: string } => ({ ok: false, out: '' })),
    ).toBe(undefined);
    expect(linkedWorktreeFromGit((): { ok: boolean; out: string } => ({ ok: true, out: '' }))).toBe(
      undefined,
    );
  });
});

describe('the adapter gives a git hook what a git hook can use', () => {
  const scratch = mkdtempSync(join(tmpdir(), '8429-guard-'));

  const depsFor = (overrides: Partial<AdapterDeps> = {}): { deps: AdapterDeps; err: string[] } => {
    const err: string[] = [];
    const deps: AdapterDeps = {
      readFile: (path) => readFileSync(path, 'utf8'),
      runGit: (): { ok: boolean; out: string } => ({ ok: true, out: '/repo/.git' }),
      env: {},
      writeErr: (text): void => {
        err.push(text);
      },
      detectLinkedWorktree: () => false,
      ...overrides,
    };
    return { deps, err };
  };

  const writeMessage = (name: string, body: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return path;
  };

  it('refuses a bead-less message file with exit 1 and prints the rule and the compliant form', () => {
    const file = writeMessage('beadless.txt', 'fix: add the guard rule\n\nbody text\n');
    const { deps, err } = depsFor();
    expect(main(['commit-msg', file], deps)).toBe(1);
    expect(err.join('')).toInclude('commit-msg-bead-id');
    expect(err.join('')).toInclude('Compliant form');
  });

  it('allows a bead-id message file with exit 0 and writes nothing to stderr', () => {
    const file = writeMessage(
      'bead.txt',
      'sentinel-prod-8429 (partial): add the guard rule\n\nwhy it exists\n',
    );
    const { deps, err } = depsFor();
    expect(main(['commit-msg', file], deps)).toBe(0);
    expect(err).toEqual([]);
  });

  it('allows the same commit when the operator exports the bypass value the adapter reads', () => {
    const file = writeMessage('bypass.txt', 'fix: add the guard rule\n');
    const { deps } = depsFor({ env: { BD_SKIP_BEAD_ID_CHECK: '1' } });
    expect(main(['commit-msg', file], deps)).toBe(0);
  });

  it('refuses with its own code when the hook forgets to pass the message file', () => {
    const { deps, err } = depsFor();
    expect(main(['commit-msg'], deps)).toBe(1);
    expect(err.join('')).toInclude('COMMIT_MSG_FILE_UNREADABLE');
  });

  it('refuses when the message file is not readable', () => {
    const { deps, err } = depsFor();
    expect(main(['commit-msg', join(scratch, 'does-not-exist.txt')], deps)).toBe(1);
    expect(err.join('')).toInclude('COMMIT_MSG_FILE_UNREADABLE');
  });

  it('refuses a rebase in the shared checkout and allows one in a lane worktree', () => {
    const shared = depsFor({ detectLinkedWorktree: () => false });
    expect(main(['pre-rebase', 'main'], shared.deps)).toBe(1);
    expect(shared.err.join('')).toInclude('SHARED_CHECKOUT_REBASE');

    const lane = depsFor({ detectLinkedWorktree: () => true });
    expect(main(['pre-rebase', 'main'], lane.deps)).toBe(0);
    expect(lane.err).toEqual([]);
  });

  it('reads the branch name through the injected git call so the refusal can name it', () => {
    const { deps, err } = depsFor({
      detectLinkedWorktree: () => false,
      runGit: (args) =>
        args.includes('--abbrev-ref')
          ? { ok: true, out: 'master' }
          : { ok: true, out: '/repo/.git' },
    });
    expect(main(['pre-rebase', 'main'], deps)).toBe(1);
    expect(err.join('')).toInclude('master');
  });

  it('reports a usage error with exit 2 when the stage name is wrong', () => {
    const { deps, err } = depsFor();
    expect(main(['post-rebase'], deps)).toBe(2);
    expect(err.join('')).toInclude('usage');
  });

  it('formats a refusal as one block a hook can print, with the code an operator can quote', () => {
    const text = refusalText(beadIdDecision({ subject: 'fix: add the guard rule' })!);
    expect(text.split('\n')[0]).toInclude('commit-msg-bead-id');
    expect(text).toInclude('  Code: BEAD_ID_MISSING');
    expect(text).toInclude('  Compliant form: ');
  });

  it('keeps its scratch files out of the repository, and removes them', () => {
    expect(scratch.startsWith(tmpdir())).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe('the shipped CLI behaves the same in a real process', () => {
  const script = join(import.meta.dir, 'git-guard-rules.ts');
  const scratch = mkdtempSync(join(tmpdir(), '8429-guard-cli-'));
  const beadless = join(scratch, 'beadless.txt');
  const bead = join(scratch, 'bead.txt');
  writeFileSync(beadless, 'fix: add the guard rule\n');
  writeFileSync(bead, 'sentinel-prod-8429: add the guard rule\n');
  const run = (args: readonly string[], cwd: string) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd });

  it('exits 1 for a bead-less commit message and prints the rule on stderr only', () => {
    const result = run(['commit-msg', beadless], import.meta.dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toInclude('commit-msg-bead-id');
    expect(result.stdout).toBe('');
  });

  it('exits 0 for a bead-id commit message', () => {
    const result = run(['commit-msg', bead], import.meta.dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 2 when the stage is unknown, so a mistyped hook line fails loudly', () => {
    const result = run(['pre-rebase-x'], import.meta.dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toInclude('usage');
  });

  it('allows a rebase in this linked worktree, which is the half only a real checkout can prove', () => {
    const result = run(['pre-rebase', 'main'], import.meta.dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('removes its scratch directory', () => {
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe('the lefthook file and the guard stay bound to each other', () => {
  const lefthook = readFileSync(join(import.meta.dir, '..', 'lefthook.yml'), 'utf8');

  it('carries a commit-msg group that runs this guard with the message file lefthook actually passes', () => {
    expect(lefthook).toInclude('commit-msg:');
    expect(lefthook).toInclude('scripts/git-guard-rules.ts commit-msg');
    // Measured against lefthook 2.2.2: the message file arrives as the first positional argument, and
    // {commit_msg_file} is passed through unexpanded. A scratch-repository receipt is in the report folder.
    expect(lefthook).toInclude('commit-msg "{0}"');
    expect(lefthook).not.toInclude('{commit_msg_file}');
  });

  it('carries a pre-rebase group that runs this guard and names the upstream git passes', () => {
    expect(lefthook).toInclude('pre-rebase:');
    expect(lefthook).toInclude('scripts/git-guard-rules.ts pre-rebase "{0}"');
  });

  it('keeps the pre-commit formatting commands and the post-merge anchor restamp it already had', () => {
    expect(lefthook).toInclude('bunx eslint');
    expect(lefthook).toInclude('bunx prettier');
    expect(lefthook).toInclude('bun run scripts/anchor_map_restamp.ts --post-merge');
  });
});
