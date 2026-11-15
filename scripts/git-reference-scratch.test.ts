// sentinel-prod-8429 row 8 R5, the live half of the proof: real git, in a scratch repository built under the system temp
// directory, with the tracked hook, the guard, the rule leaf and a pinned runner installed inside THAT repository only.
// Root's RETURN (msg_8a62499e1568) asked for real scratch regressions rather than unit arguments, and Claude Today's
// probe listed the six behaviours the repair has to hold. This file runs them. It never touches a real tree: no shared
// repository, no shared .git/hooks, no worktree of any checkout on this machine, no database, no network. Scratch
// install is what Root authorised for an owned scratch probe; the install into the real repository is still Root's.
//
// The scratch repository is built once, the cases run in order because they build on each other the way a lane's day
// does, and the whole directory is removed when the file finishes.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'bun:test';

import { MAIN_REF, REFERENCE_CAPABILITY } from './git-reference-guard';

const GIT = Bun.which('git') ?? '/usr/bin/git';
const HOOK_SOURCE = 'scripts/hooks/reference-transaction';
const GUARD_SOURCE = 'scripts/git-reference-guard.ts';
const RULE_SOURCE = 'scripts/git-reference-rule.ts';
const LANE_REF = 'refs/heads/lane';

interface Ran {
  status: number;
  text: string;
}

/** Run git in one directory, with git's own environment cleared so no real tree's config or hooks leak in. */
function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync(
    GIT,
    ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: scratchDir,
        GIT_CONFIG_NOSYSTEM: '1',
        ...env,
      },
    },
  );
  return { status: result.status ?? 128, text: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

const recordFile = (worktree: string, name: string): string =>
  readFileSync(join(repo.rebaseDir(worktree), name), 'utf8').trim();

const codeIn = (text: string): string | null => text.match(/Code: ([A-Z_]+)/)?.[1] ?? null;
const refused = (ran: Ran): boolean =>
  ran.status !== 0 && ran.text.includes('BLOCKED (reference-transaction-forward-only)');

function headOf(dir: string): string {
  const ran = git(dir, ['symbolic-ref', '-q', 'HEAD']);
  return ran.status === 0 ? ran.text.trim() : 'detached';
}

function rev(dir: string, what: string): string {
  return git(dir, ['rev-parse', what]).text.trim();
}

/** One scratch repository: main advanced past the point every other branch was cut, and three linked worktrees. */
const scratchDir = mkdtempSync(join(tmpdir(), 'row8-r4-scratch-'));
const repo = (() => {
  const dir = scratchDir;
  const shared = join(dir, 'shared');
  const hooks = join(shared, '.git', 'hooks');
  spawnSync(GIT, ['init', '-q', '-b', 'main', shared], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const at = (path: string, text: string) => writeFileSync(path, text);
  at(join(shared, 'f.txt'), '1\n');
  git(shared, ['add', 'f.txt']);
  git(shared, ['commit', '-q', '-m', 'c1']);
  for (const branch of ['lane', 'knotty', 'parked']) git(shared, ['branch', branch]);
  at(join(shared, 'f.txt'), '2\n');
  git(shared, ['add', 'f.txt']);
  git(shared, ['commit', '-q', '-m', 'c2']);
  git(shared, ['branch', 'spare']);
  at(join(shared, 'f.txt'), '3\n');
  git(shared, ['add', 'f.txt']);
  git(shared, ['commit', '-q', '-m', 'c3']);
  // main has to be free to check out somewhere else, so the shared checkout parks on its own branch.
  git(shared, ['checkout', '-q', 'parked']);
  git(shared, ['worktree', 'add', '-q', '../lane', 'lane']);
  git(shared, ['worktree', 'add', '-q', '../mainlane', 'main']);
  git(shared, ['worktree', 'add', '-q', '../knotty', 'knotty']);

  // The pinned install, exactly as the tracked hook expects it: hook, guard, the rule leaf the guard imports, and the
  // runner path beside them. This is the shape Root installs, reproduced in a scratch repository.
  copyFileSync(HOOK_SOURCE, join(hooks, 'reference-transaction'));
  copyFileSync(GUARD_SOURCE, join(hooks, 'git-reference-guard.ts'));
  copyFileSync(RULE_SOURCE, join(hooks, 'git-reference-rule.ts'));
  at(join(hooks, 'reference-transaction.runner'), `${process.execPath}\n`);
  chmodSync(join(hooks, 'reference-transaction'), 0o755);

  return {
    dir,
    shared,
    hooks,
    lane: join(dir, 'lane'),
    mainlane: join(dir, 'mainlane'),
    knotty: join(dir, 'knotty'),
    rebaseDir: (worktree: string) => join(shared, '.git', 'worktrees', worktree, 'rebase-merge'),
  };
})();

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('the scratch install itself', () => {
  test('the four installed files are the tracked bytes, and the rule leaf the guard imports is beside it', () => {
    expect(existsSync(join(repo.hooks, 'reference-transaction'))).toBe(true);
    expect(existsSync(join(repo.hooks, 'git-reference-guard.ts'))).toBe(true);
    expect(existsSync(join(repo.hooks, 'git-reference-rule.ts'))).toBe(true);
    expect(existsSync(join(repo.hooks, 'reference-transaction.runner'))).toBe(true);
    const installed = readFileSync(join(repo.hooks, 'reference-transaction'), 'utf8');
    expect(installed).toBe(readFileSync(HOOK_SOURCE, 'utf8'));
    expect(installed).toContain(REFERENCE_CAPABILITY);
    expect(readFileSync(join(repo.hooks, 'git-reference-guard.ts'), 'utf8')).toBe(
      readFileSync(GUARD_SOURCE, 'utf8'),
    );
    expect(headOf(repo.shared)).toBe('refs/heads/parked');
    expect(headOf(repo.mainlane)).toBe(MAIN_REF);
    expect(headOf(repo.lane)).toBe(LANE_REF);
  });
});

describe('Claude Today a: a linked worktree that has main checked out cannot rewind main', () => {
  test('git reset --hard HEAD~1 in that worktree refuses and leaves main where it was', () => {
    const before = rev(repo.mainlane, 'main');
    const ran = git(repo.mainlane, ['reset', '--hard', 'HEAD~1']);
    expect(refused(ran)).toBe(true);
    expect(codeIn(ran.text)).toBe('MAIN_REF_ALWAYS_PROTECTED');
    expect(rev(repo.mainlane, 'main')).toBe(before);
  });

  test('the same refusal lands on the plumbing form of the same move', () => {
    const before = rev(repo.mainlane, 'main');
    const ran = git(repo.mainlane, [
      'update-ref',
      'refs/heads/main',
      rev(repo.mainlane, 'main~1'),
      before,
    ]);
    expect(refused(ran)).toBe(true);
    expect(codeIn(ran.text)).toBe('MAIN_REF_ALWAYS_PROTECTED');
    expect(rev(repo.mainlane, 'main')).toBe(before);
  });

  test('and main is not frozen: an ordinary forward commit there is allowed', () => {
    const before = rev(repo.mainlane, 'main');
    writeFileSync(join(repo.mainlane, 'm.txt'), 'M\n');
    expect(git(repo.mainlane, ['add', 'm.txt']).status).toBe(0);
    expect(git(repo.mainlane, ['commit', '-q', '-m', 'mainlane1']).status).toBe(0);
    expect(rev(repo.mainlane, 'main')).not.toBe(before);
  });
});

describe("Claude Today b: a lane rebasing its own branch has to finish (Root's defect D2)", () => {
  test('commit on lane, rebase onto main: exit 0, HEAD back on lane, no rebase left behind', () => {
    writeFileSync(join(repo.lane, 'l.txt'), 'L\n');
    expect(git(repo.lane, ['add', 'l.txt']).status).toBe(0);
    expect(git(repo.lane, ['commit', '-q', '-m', 'lane1']).status).toBe(0);
    const before = rev(repo.lane, 'lane');
    expect(before).not.toBe(rev(repo.lane, 'main'));
    const ran = git(repo.lane, ['rebase', 'main']);
    expect([ran.status, headOf(repo.lane)]).toEqual([0, LANE_REF]);
    expect(existsSync(repo.rebaseDir('lane'))).toBe(false);
    expect(git(repo.lane, ['merge-base', '--is-ancestor', 'main', 'lane']).status).toBe(0);
  });
});

describe('Claude Today c: a detached HEAD with no rebase running is no exception', () => {
  test('a rewind of another branch from a detached HEAD refuses, and that branch does not move', () => {
    expect(git(repo.lane, ['checkout', '--detach', '-q']).status).toBe(0);
    const before = rev(repo.lane, 'spare');
    const ran = git(repo.lane, [
      'update-ref',
      'refs/heads/spare',
      rev(repo.lane, 'spare~1'),
      before,
    ]);
    expect(refused(ran)).toBe(true);
    expect(codeIn(ran.text)).toBe('SHARED_REF_NOT_FAST_FORWARD');
    expect(rev(repo.lane, 'spare')).toBe(before);
    expect(git(repo.lane, ['checkout', '-q', 'lane']).status).toBe(0);
  });
});

describe('Claude Today d and e: rebase metadata names one branch, and only that branch', () => {
  test('a rebase that stops on a conflict leaves the record naming the branch it is rebasing', () => {
    writeFileSync(join(repo.knotty, 'f.txt'), 'KNOT\n');
    expect(git(repo.knotty, ['add', 'f.txt']).status).toBe(0);
    expect(git(repo.knotty, ['commit', '-q', '-m', 'knotty1']).status).toBe(0);
    const before = rev(repo.knotty, 'knotty');
    const ran = git(repo.knotty, ['rebase', 'main']);
    expect(ran.status).not.toBe(0);
    expect(existsSync(repo.rebaseDir('knotty'))).toBe(true);
    expect(headOf(repo.knotty)).toBe('detached');
    expect(recordFile('knotty', 'head-name')).toBe('refs/heads/knotty');
    expect(recordFile('knotty', 'orig-head')).toBe(before);
    expect(rev(repo.knotty, 'knotty')).toBe(before);
  });

  test('while that rebase is stopped, a rewind of an unrelated branch still refuses', () => {
    const before = rev(repo.knotty, 'spare');
    const ran = git(repo.knotty, [
      'update-ref',
      'refs/heads/spare',
      rev(repo.knotty, 'spare~1'),
      before,
    ]);
    expect(refused(ran)).toBe(true);
    expect(codeIn(ran.text)).toBe('REBASE_RECORD_DENIED');
    expect(ran.text).toContain('refs/heads/knotty');
    expect(rev(repo.knotty, 'spare')).toBe(before);
  });

  test('while that rebase is stopped, main is still protected', () => {
    const before = rev(repo.knotty, 'main');
    const ran = git(repo.knotty, [
      'update-ref',
      'refs/heads/main',
      rev(repo.knotty, 'main~1'),
      before,
    ]);
    expect(refused(ran)).toBe(true);
    expect(rev(repo.knotty, 'main')).toBe(before);
  });

  test('resolve and continue: the branch the record names is allowed to finish, and HEAD returns to it', () => {
    writeFileSync(join(repo.knotty, 'f.txt'), 'RESOLVED\n');
    expect(git(repo.knotty, ['add', 'f.txt']).status).toBe(0);
    const ran = git(repo.knotty, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    expect([ran.status, headOf(repo.knotty)]).toEqual([0, 'refs/heads/knotty']);
    expect(existsSync(repo.rebaseDir('knotty'))).toBe(false);
    expect(git(repo.knotty, ['merge-base', '--is-ancestor', 'main', 'knotty']).status).toBe(0);
  });
});

describe('Claude Today f: a short PATH is not a jam', () => {
  test('a guarded forward commit on lane through PATH=/usr/bin:/bin exits 0 and moves the branch forward', () => {
    writeFileSync(join(repo.lane, 's.txt'), 'S\n');
    const env = { PATH: '/usr/bin:/bin', HOME: repo.dir, GIT_CONFIG_NOSYSTEM: '1' };
    const before = rev(repo.lane, 'lane');
    expect(git(repo.lane, ['add', 's.txt'], env).status).toBe(0);
    const commit = git(repo.lane, ['commit', '-q', '-m', 'shortpath'], env);
    expect([commit.status, refused(commit)]).toEqual([0, false]);
    expect(rev(repo.lane, 'lane')).not.toBe(before);
  });
});

describe('a partial install refuses, it never lets a rewind through', () => {
  test("Root's R5 GO: the installed hook names the rule leaf it cannot run without", () => {
    rmSync(join(repo.hooks, 'git-reference-rule.ts'));
    const before = rev(repo.lane, 'spare');
    const ran = git(repo.lane, [
      'update-ref',
      'refs/heads/spare',
      rev(repo.lane, 'spare~1'),
      before,
    ]);
    expect(ran.status).not.toBe(0);
    expect(refused(ran)).toBe(true);
    expect(codeIn(ran.text)).toBe('PINNED_RULE_MISSING');
    // Before R5 the very same install ended in the runner's own module-not-found, which named nothing a lane could act
    // on. It aborted then too; a refusal an operator can read is what this check adds.
    expect(ran.text).not.toContain('Cannot find module');
    expect(rev(repo.lane, 'spare')).toBe(before);
  });

  test('an install that incomplete still jams no transaction this row guards no ref in', () => {
    const before = rev(repo.lane, 'spare');
    // A tag and a remote-tracking ref, through the same incomplete install: neither is a guarded branch move, so neither
    // is ever asked the question, and neither may jam. Claude Today's J1 holds even on a broken install.
    const tagged = git(repo.lane, ['tag', 'zz-row8-partial']);
    expect([tagged.status, refused(tagged)]).toEqual([0, false]);
    expect(rev(repo.lane, 'zz-row8-partial')).toBe(rev(repo.lane, 'HEAD'));
    const tracking = git(repo.lane, [
      'update-ref',
      'refs/remotes/origin/zz',
      rev(repo.lane, 'spare'),
    ]);
    expect([tracking.status, refused(tracking)]).toEqual([0, false]);
    const note = git(repo.lane, ['update-ref', 'refs/notes/zz', rev(repo.lane, 'spare')]);
    expect([note.status, refused(note)]).toEqual([0, false]);
    copyFileSync(RULE_SOURCE, join(repo.hooks, 'git-reference-rule.ts'));
    const restored = git(repo.lane, [
      'update-ref',
      'refs/heads/spare',
      rev(repo.lane, 'spare~1'),
      rev(repo.lane, 'spare'),
    ]);
    expect(refused(restored)).toBe(true);
    expect(codeIn(restored.text)).toBe('SHARED_REF_NOT_FAST_FORWARD');
    expect(rev(repo.lane, 'spare')).toBe(before);
  });
});
