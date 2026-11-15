// sentinel-prod-8429 row 8 R5, second half of the tests: the tracked hook script scripts/hooks/reference-transaction,
// read as source and run from a scratch copy in the system temp dir. Split out of
// scripts/git-reference-guard.test.ts at Root's instruction (msg_82adbd1b8a8d: 430 lines could not land under the
// 400-line cap); every case and every assertion below is carried byte-for-byte from that file, and only the imports,
// the setup constants and the runHook helper are repeated here. R5 adds one case for Root's GO (msg_fb17e8bf7cd7): the
// pinned rule leaf the guard imports is now checked beside the pinned helper, so a half install is a named refusal. The
// guard, the rule leaf and every product decision are byte-for-byte the accepted R4 bytes.
//
// WHAT IS NOT PROVEN HERE, said plainly: that the hook is installed, and that git really aborts a reset through it.
// Installation is Root's operation, so what is proven here is the exit code the hook returns and the behaviour of the
// tracked script when it is run directly from a scratch copy. A live abort proof - and any test that actually rewound a
// shared branch - belongs to Root's guarded operation, and none is attempted here. No repository, database, network or
// shared .git is touched.

import { existsSync, readFileSync } from 'node:fs';
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

import { REFERENCE_CAPABILITY } from './git-reference-guard';

const ZERO = '0000000000000000000000000000000000000000';
const OLD = '1111111111111111111111111111111111111111';
const OTHER = '3333333333333333333333333333333333333333';
const REWIND = `${OLD} ${OTHER} refs/heads/main\n`;
const NOOP = `${ZERO} ${ZERO} refs/heads/main\n`;
const PINNED =
  '#!/bin/sh\nprintf "PINNED %s %s\\n" "$2" "$3"\nwhile read -r l; do printf "STDIN:%s\\n" "$l"; done\n';

/** Run the tracked hook script from a scratch copy, with a PATH the caller controls. */
function runHook(dir: string, args: string[], input: string, path?: string, cwd?: string) {
  return spawnSync('/bin/sh', [join(dir, 'reference-transaction'), ...args], {
    cwd: cwd ?? dir,
    input,
    encoding: 'utf8',
    env: path === undefined ? process.env : { PATH: path },
  });
}

describe('the tracked hook script, as source only', () => {
  const script = readFileSync('scripts/hooks/reference-transaction', 'utf8');
  const codeLines = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'row8-r3-'));
    copyFileSync('scripts/hooks/reference-transaction', join(dir, 'reference-transaction'));
    return dir;
  };
  const pin = (dir: string, body: string) => {
    const pinned = join(dir, 'pinned-runner');
    writeFileSync(pinned, body);
    chmodSync(pinned, 0o755);
    writeFileSync(join(dir, 'reference-transaction.runner'), `${pinned}\n`);
    return pinned;
  };

  test('it exists, answers capability, hands git state to the pinned helper and installs nothing', () => {
    expect(existsSync('scripts/hooks/reference-transaction')).toBe(true);
    expect(script).toContain(REFERENCE_CAPABILITY);
    expect(script).toContain('exec "$runner" run "$helper" "$state"');
    for (const forbidden of [
      'core.hooksPath',
      '.git/hooks',
      'lefthook install',
      'git config',
      'command -v',
    ])
      expect(codeLines(script)).not.toContain(forbidden);
    expect(readFileSync('lefthook.yml', 'utf8')).not.toContain('reference-transaction');
  });

  test("Claude Today's J1: with a PATH carrying no bun and no dirname, anything that cannot abort exits 0", () => {
    const dir = scratch();
    for (const state of ['preparing', 'committed', 'aborted']) {
      const ran = runHook(dir, [state], REWIND, '/nonexistent');
      expect([ran.status, ran.stderr]).toEqual([0, '']);
    }
    for (const ref of ['refs/tags/v9', 'refs/remotes/origin/main']) {
      const ran = runHook(dir, ['prepared'], `${OLD} ${OTHER} ${ref}\n`, '/nonexistent');
      expect([ran.status, ran.stderr]).toEqual([0, '']);
    }
    const capability = runHook(dir, ['capability'], '', '/nonexistent');
    expect(capability.status).toBe(0);
    expect(capability.stdout).toContain(REFERENCE_CAPABILITY);
  });

  test('that same short PATH is a named refusal for a guarded branch move, not a hang', () => {
    const ran = runHook(scratch(), ['prepared'], REWIND, '/nonexistent');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('Code: PINNED_HELPER_MISSING');
  });

  test('installed, it runs the helper beside the hook with the pinned runner, with no PATH lookup at all', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'git-reference-guard.ts'), 'placeholder');
    writeFileSync(join(dir, 'git-reference-rule.ts'), 'placeholder');
    pin(dir, PINNED);
    const ran = runHook(dir, ['prepared'], NOOP, '/nonexistent');
    expect(ran.status).toBe(0);
    for (const part of ['PINNED', `STDIN:${NOOP.trim()}`, `${dir}/git-reference-guard.ts`])
      expect(ran.stdout).toContain(part);
  });

  test('no pinned runner, a runner that is not executable and a missing helper are each a named refusal', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'git-reference-guard.ts'), 'placeholder');
    writeFileSync(join(dir, 'git-reference-rule.ts'), 'placeholder');
    const missing = runHook(dir, ['prepared'], REWIND, '/usr/bin:/bin');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('PINNED_RUNNER_MISSING');
    expect(missing.stderr).toContain('does not look a runner up on PATH');
    const dead = join(dir, 'not-executable');
    writeFileSync(dead, 'not a runner\n');
    writeFileSync(join(dir, 'reference-transaction.runner'), `${dead}\n`);
    const notExecutable = runHook(dir, ['prepared'], REWIND, '/usr/bin:/bin');
    expect(notExecutable.status).toBe(1);
    expect(notExecutable.stderr).toContain('PINNED_RUNNER_NOT_EXECUTABLE');
    const bare = pin(scratch(), '#!/bin/sh\nexit 0\n');
    const noHelper = runHook(join(bare, '..'), ['prepared'], REWIND, '/usr/bin:/bin');
    expect([noHelper.status, noHelper.stdout]).toEqual([1, '']);
    expect(noHelper.stderr).toContain('PINNED_HELPER_MISSING');
  });

  test("Root's R5 GO: the rule leaf the guard imports is a named refusal when it is not installed", () => {
    const dir = scratch();
    // The real import line, so the file this check looks for is the file the guard actually needs.
    writeFileSync(
      join(dir, 'git-reference-guard.ts'),
      "import { moveDecision } from './git-reference-rule';\n",
    );
    pin(dir, PINNED);
    const incomplete = runHook(dir, ['prepared'], REWIND, '/nonexistent');
    expect(incomplete.status).toBe(1);
    expect(incomplete.stdout).toBe('');
    expect(incomplete.stderr).toContain('Code: PINNED_RULE_MISSING');
    expect(incomplete.stderr).toContain(`${dir}/git-reference-rule.ts`);
    // Before this check the same install ended in the runner's own error, which named nothing a lane could act on.
    expect(incomplete.stderr).not.toContain('Cannot find module');
    // An install this incomplete must still jam nothing this row guards no ref in: only `prepared` with a branch ref in
    // the transaction ever reaches this question.
    for (const state of ['preparing', 'committed', 'aborted']) {
      const ran = runHook(dir, [state], REWIND, '/nonexistent');
      expect([ran.status, ran.stderr]).toEqual([0, '']);
    }
    for (const line of ['refs/tags/v9', 'refs/remotes/origin/main', 'refs/notes/x']) {
      const ran = runHook(dir, ['prepared'], `${OLD} ${OTHER} ${line}\n`, '/nonexistent');
      expect([ran.status, ran.stderr]).toEqual([0, '']);
    }
    // Put the leaf back and the very same transaction reaches the pinned helper: the refusal was about the missing file
    // and nothing else.
    writeFileSync(join(dir, 'git-reference-rule.ts'), 'placeholder');
    const complete = runHook(dir, ['prepared'], REWIND, '/nonexistent');
    expect([complete.status, complete.stderr]).toEqual([0, '']);
    expect(complete.stdout).toContain('PINNED');
  });

  test('the source probe needs explicit paths and says out loud that it is a probe', () => {
    const dir = scratch();
    const helper = join(process.cwd(), 'scripts/git-reference-guard.ts');
    const probed = runHook(
      dir,
      ['prepared', helper, process.execPath],
      NOOP,
      undefined,
      process.cwd(),
    );
    expect(probed.status).toBe(0);
    expect(probed.stderr).toContain('SOURCE PROBE');
  });
});
