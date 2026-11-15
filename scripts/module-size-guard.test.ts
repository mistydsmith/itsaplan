// sentinel-prod-8429 row 2 tests. The rule is proven with injected git answers. The scratch cases run the shipped
// CLI against a disposable repository in the temp directory, with real git and a real index, to prove it reads the
// staged blob and not the working copy. No hook is installed and this repository's index is never read or written.
//
// The last case runs the real lefthook binary with the shipped lefthook.yml in a scratch repository, with
// --no-auto-install, to prove the final guard reads the index after the formatter has staged its rewrite.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

import {
  LIMIT,
  countLines,
  inScope,
  parseStaged,
  runSizeGuard,
  sizeDecision,
  stagedRefusals,
} from './module-size-guard';

const lines = (count: number, tail = '\n') =>
  Array.from({ length: count }, (_, at) => `line ${at + 1}`).join('\n') + (count > 0 ? tail : '');

/** Injected git: the staged listing, then blobs by the spec the guard asks for. A missing spec fails. */
function fakeGit(listing: string | null, blobs: Record<string, string>) {
  const asked: string[] = [];
  const err: string[] = [];
  return {
    asked,
    err,
    deps: {
      runGit: (args: readonly string[]) => {
        if (args[0] === 'diff') return { ok: listing !== null, out: listing ?? '' };
        const spec = args[2] ?? '';
        asked.push(spec);
        return spec in blobs ? { ok: true, out: blobs[spec] ?? '' } : { ok: false, out: '' };
      },
      writeErr: (text: string) => err.push(text),
    },
  };
}

describe('line counting and scope', () => {
  test('a final line without a newline still counts, and an empty file is zero lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines(lines(400))).toBe(400);
    expect(countLines(lines(401, ''))).toBe(401);
  });

  test('TypeScript, JavaScript and Python sources are judged, tests included; other files are not', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'tools/a.py'])
      expect(inScope(path)).toBe(true);
    expect(inScope('apps/api/src/x/__tests__/unit/a.test.ts')).toBe(true);
    for (const path of ['a.json', 'a.md', 'a.sql', 'lefthook.yml', 'Makefile', 'dir.ts/README'])
      expect(inScope(path)).toBe(false);
  });
});

describe('the staged listing', () => {
  test('added, modified, renamed and copied records parse, with the rename keeping its old path', () => {
    expect(
      parseStaged('A\0new.ts\0M\0old.ts\0R087\0was.ts\0now.ts\0C100\0src.ts\0copy.ts\0'),
    ).toEqual([
      { path: 'new.ts', basePath: null },
      { path: 'old.ts', basePath: 'old.ts' },
      { path: 'now.ts', basePath: 'was.ts' },
      { path: 'copy.ts', basePath: null },
    ]);
    expect(parseStaged('T\0link.ts\0')).toEqual([{ path: 'link.ts', basePath: 'link.ts' }]);
    expect(parseStaged('')).toEqual([]);
  });

  test('a record the guard does not know, or a record cut short, is not guessed at', () => {
    expect(parseStaged('X\0a.ts\0')).toBeNull();
    expect(parseStaged('M\0')).toBeNull();
    expect(parseStaged('R100\0only-one.ts\0')).toBeNull();
  });
});

describe('one file', () => {
  test('exactly 400 lines is allowed and 401 is refused, for a new file', () => {
    expect(sizeDecision({ path: 'a.ts', stagedLines: LIMIT, baseLines: null })).toBeNull();
    const refusal = sizeDecision({ path: 'a.ts', stagedLines: LIMIT + 1, baseLines: null });
    expect(refusal?.code).toBe('MODULE_TOO_LONG');
    expect(refusal?.message).toContain('a.ts is 401 lines');
    expect(refusal?.safe_form).toContain('split it');
  });

  test('a file within the limit at HEAD may not cross it', () => {
    const refusal = sizeDecision({ path: 'a.ts', stagedLines: 401, baseLines: 400 });
    expect(refusal?.code).toBe('MODULE_TOO_LONG');
    expect(refusal?.message).toContain('it is 400 at HEAD');
  });

  test('a file already over the limit at HEAD may stay the same or shrink, and may not grow', () => {
    expect(sizeDecision({ path: 'big.ts', stagedLines: 900, baseLines: 900 })).toBeNull();
    expect(sizeDecision({ path: 'big.ts', stagedLines: 650, baseLines: 900 })).toBeNull();
    const grew = sizeDecision({ path: 'big.ts', stagedLines: 901, baseLines: 900 });
    expect(grew?.code).toBe('MODULE_GREW');
    expect(grew?.message).toContain('(900)');
    expect(grew?.message).toContain('901');
  });
});

describe('the staged files of one commit', () => {
  test('a short file costs one blob read and the HEAD version is never asked for', () => {
    const git = fakeGit('M\0a.ts\0', { ':a.ts': lines(12) });
    expect(runSizeGuard(git.deps)).toBe(0);
    expect(git.asked).toEqual([':a.ts']);
    expect(git.err).toEqual([]);
  });

  test('files outside the scope are not read at all, and an empty commit passes', () => {
    const git = fakeGit('A\0notes.md\0M\0package.json\0', {});
    expect(runSizeGuard(git.deps)).toBe(0);
    expect(git.asked).toEqual([]);
    expect(runSizeGuard(fakeGit('', {}).deps)).toBe(0);
  });

  test('every refusal of the commit is reported, each with its rule name and compliant form', () => {
    const git = fakeGit('A\0new.ts\0M\0big.py\0M\0ok.ts\0', {
      ':new.ts': lines(401),
      ':big.py': lines(520),
      'HEAD:big.py': lines(500),
      ':ok.ts': lines(400),
    });
    expect(runSizeGuard(git.deps)).toBe(1);
    expect(stagedRefusals(git.deps).map((r) => [r.code, r.rule])).toEqual([
      ['MODULE_TOO_LONG', 'module-size-400'],
      ['MODULE_GREW', 'module-size-400'],
    ]);
    const text = git.err.join('');
    expect(text).toContain('BLOCKED (module-size-400): new.ts is 401 lines');
    expect(text).toContain('Compliant form:');
  });

  test('a renamed long file is compared with its old path at HEAD', () => {
    const blobs = { ':now.ts': lines(700), 'HEAD:was.ts': lines(700) };
    expect(runSizeGuard(fakeGit('R100\0was.ts\0now.ts\0', blobs).deps)).toBe(0);
    const grown = fakeGit('R090\0was.ts\0now.ts\0', { ...blobs, ':now.ts': lines(701) });
    expect(stagedRefusals(grown.deps).map((r) => r.code)).toEqual(['MODULE_GREW']);
  });

  test('git failing to list the staged files refuses, and so does a listing it cannot parse', () => {
    const silent = fakeGit(null, {});
    expect(runSizeGuard(silent.deps)).toBe(1);
    expect(silent.err.join('')).toContain('STAGED_LIST_UNKNOWN');
    expect(stagedRefusals(fakeGit('garbage', {}).deps)[0]?.code).toBe('STAGED_LIST_UNKNOWN');
  });

  test('a staged blob git cannot print refuses by name, and the other files are still judged', () => {
    const git = fakeGit('M\0gone.ts\0A\0new.ts\0', { ':new.ts': lines(401) });
    expect(stagedRefusals(git.deps).map((r) => r.code)).toEqual([
      'STAGED_BLOB_UNREADABLE',
      'MODULE_TOO_LONG',
    ]);
  });

  test('a long modified file whose HEAD version git cannot print refuses, it is not treated as old', () => {
    const git = fakeGit('M\0big.ts\0', { ':big.ts': lines(900) });
    const [refusal] = stagedRefusals(git.deps);
    expect(refusal?.code).toBe('BASE_BLOB_UNREADABLE');
    expect(refusal?.message).toContain('HEAD');
  });
});

describe('the shipped CLI against a scratch repository', () => {
  const guard = resolve('scripts/module-size-guard.ts');
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  // WHY the GIT_ values are removed: a test started from inside a git hook inherits GIT_DIR and GIT_INDEX_FILE,
  // and with them these commands would act on the real repository instead of the scratch one.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'row2-size-'));
    made.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'row2@local');
    git('config', 'user.name', 'Row Two');
    const write = (path: string, count: number) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), lines(count));
    };
    const run = () => spawnSync('bun', ['run', guard], { cwd: dir, env, encoding: 'utf8' });
    return { dir, git, write, run };
  }

  test('401 lines staged refuses even when the working copy is 399', () => {
    const repo = scratch();
    repo.write('src/a.ts', 401);
    repo.git('add', 'src/a.ts');
    repo.write('src/a.ts', 399);
    const ran = repo.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('MODULE_TOO_LONG');
    expect(ran.stderr).toContain('src/a.ts is 401 lines');
  });

  test('399 lines staged is allowed even when the working copy is 401', () => {
    const repo = scratch();
    repo.write('src/a.ts', 399);
    repo.git('add', 'src/a.ts');
    repo.write('src/a.ts', 401);
    const ran = repo.run();
    expect([ran.status, ran.stderr]).toEqual([0, '']);
  });

  test('exactly 400 passes and 401 refuses, and an unstaged long file is not judged', () => {
    const repo = scratch();
    repo.write('a.py', 400);
    repo.write('unstaged.ts', 900);
    repo.git('add', 'a.py');
    expect(repo.run().status).toBe(0);
    repo.write('b.tsx', 401);
    repo.git('add', 'b.tsx');
    const ran = repo.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('b.tsx is 401 lines');
    expect(ran.stderr).not.toContain('unstaged.ts');
    expect(ran.stderr).not.toContain('a.py');
  });

  test('an old long file may shrink, stay or be deleted, and may not grow', () => {
    const repo = scratch();
    repo.write('big.ts', 600);
    repo.write('dead.ts', 600);
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'old long files');
    repo.write('big.ts', 600);
    repo.git('add', 'big.ts');
    expect(repo.run().status).toBe(0);
    repo.write('big.ts', 550);
    repo.git('rm', '-q', 'dead.ts');
    repo.git('add', 'big.ts');
    expect(repo.run().status).toBe(0);
    repo.write('big.ts', 601);
    repo.git('add', 'big.ts');
    const ran = repo.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('MODULE_GREW');
    expect(ran.stderr).toContain('(600)');
  });

  // lefthook runs the guard a second time after prettier, as module-size-final. This is that second run.
  test('a file that passes at 400 and is re-staged at 401 by a formatter is refused on the final run', () => {
    const repo = scratch();
    repo.write('src/a.ts', 400);
    repo.git('add', 'src/a.ts');
    expect(repo.run().status).toBe(0);
    // What prettier with stage_fixed does: rewrite the file and stage the result.
    repo.write('src/a.ts', 401);
    repo.git('add', 'src/a.ts');
    const ran = repo.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('src/a.ts is 401 lines');
  });

  test('a symlink replaced by a regular 401 line file is judged, not skipped as a type change', () => {
    const repo = scratch();
    repo.write('target.txt', 3);
    symlinkSync('target.txt', join(repo.dir, 'a.ts'));
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'a symlink with a source name');
    rmSync(join(repo.dir, 'a.ts'));
    repo.write('a.ts', 401);
    repo.git('add', 'a.ts');
    expect(repo.git('diff', '--cached', '--name-status')).toContain('T\ta.ts');
    const ran = repo.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('a.ts is 401 lines');
  });

  // WHY the real config: lefthook 2.2.2 applies stage_fixed only after every command has run, so the order is
  // held by the prettier command staging its own files. Only the two tool names are swapped, for a formatter that
  // adds one line and a linter that does nothing. The rest of each run line is the shipped text.
  test('lefthook refuses when the formatter reflows a staged 400 line file to 401', () => {
    const shipped = readFileSync(resolve('lefthook.yml'), 'utf8');
    const prettier = 'bunx prettier --ignore-unknown --write';
    const eslint = 'bunx eslint --flag v10_config_lookup_from_file --fix --no-warn-ignored';
    expect(shipped).toContain(`run: ${prettier} {staged_files} && git add -- {staged_files}`);
    expect(shipped).toContain(`run: ${eslint} {staged_files}`);
    const repo = scratch();
    writeFileSync(
      join(repo.dir, 'lefthook.yml'),
      shipped.replace(prettier, './fmt.sh').replace(eslint, 'true'),
    );
    writeFileSync(
      join(repo.dir, 'fmt.sh'),
      '#!/bin/sh\nfor f in "$@"; do echo "// reflowed" >> "$f"; done\n',
    );
    chmodSync(join(repo.dir, 'fmt.sh'), 0o755);
    mkdirSync(join(repo.dir, 'scripts'));
    copyFileSync(guard, join(repo.dir, 'scripts/module-size-guard.ts'));
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'base');
    repo.write('src/a.ts', 400);
    repo.git('add', 'src/a.ts');
    writeFileSync(join(repo.dir, 'src/a.ts'), lines(400) + '// unstaged\n');
    repo.write('src/b.ts', 5);
    const ran = spawnSync(
      resolve('node_modules/.bin/lefthook'),
      ['run', 'pre-commit', '--no-auto-install'],
      {
        cwd: repo.dir,
        env,
        encoding: 'utf8',
      },
    );
    expect(ran.status).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('MODULE_TOO_LONG');
    const staged = repo.git('cat-file', 'blob', ':src/a.ts');
    expect(countLines(staged)).toBe(401);
    expect(staged).toContain('// reflowed');
    expect(staged).not.toContain('// unstaged');
    expect(readFileSync(join(repo.dir, 'src/a.ts'), 'utf8')).toContain('// unstaged');
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('src/a.ts');
  });

  test('outside a repository the guard refuses with a named code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'row2-norepo-'));
    made.push(dir);
    const ran = spawnSync('bun', ['run', guard], {
      cwd: dir,
      env: { ...env, GIT_CEILING_DIRECTORIES: tmpdir() },
      encoding: 'utf8',
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('STAGED_LIST_UNKNOWN');
  });
});
