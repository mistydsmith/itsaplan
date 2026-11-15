// scripts/install-reference-hook.test.ts — sentinel-prod-8429 row 8: the installer's ONE mutation-test leaf.
// WHY so small: Misty's rule is mutation testing only. This file exists to catch a deliberately broken installer, not to cover it.
// The guard's own rule has its suite already and is not repeated here.
//
// WHAT IT HOLDS: an incomplete bundle is refused and nothing is written; an existing owned file with different bytes is refused;
// and the staging order puts the hook last, after the helpers and the generated runner.

import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyInstallation,
  BUNDLE_HOOK,
  BUNDLE_HELPERS,
  planInstallation,
  RUNNER_NAME,
  type InstallOptions,
} from './install-reference-hook';

const SHA = 'a'.repeat(40);
const BUN = '/opt/homebrew/bin/bun';
const HOOK_DIR = '/repo/.git/hooks';

interface Scratch {
  options: InstallOptions;
  files: Map<string, Buffer>;
  modes: Map<string, number>;
  writes: Array<{ path: string; bytes: Buffer; mode: number }>;
}

/** A repository that exists only in memory: git answers by SHA, the filesystem is a map. */
function scratch(
  over: {
    missing?: string;
    existing?: Record<string, string>;
    modes?: Record<string, number>;
  } = {},
): Scratch {
  const files = new Map<string, Buffer>();
  for (const [path, text] of Object.entries(over.existing ?? {}))
    files.set(path, Buffer.from(text));
  const modes = new Map<string, number>(Object.entries(over.modes ?? {}));

  const runGit = (args: readonly string[]): Buffer => {
    if (args[0] === 'rev-parse') return Buffer.from('.git\n');
    if (args[0] === 'cat-file') return Buffer.from('ok\n');
    if (args[0] === 'show') {
      const source = String(args[1]).split(':').slice(1).join(':');
      if (source === over.missing)
        throw new Error(`fatal: path '${source}' does not exist in '${SHA}'`);
      return Buffer.from(`// ${source}\n`);
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const writes: Array<{ path: string; bytes: Buffer; mode: number }> = [];
  const options: InstallOptions = {
    repo: '/repo',
    sha: SHA,
    bunPath: BUN,
    runGit,
    readFile: (path) => {
      const found = files.get(path);
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    exists: (path) => files.has(path),
    writeFile: (path, bytes, mode) => {
      writes.push({ path, bytes, mode });
      files.set(path, bytes);
      modes.set(path, mode);
    },
    chmod: (path, mode) => {
      modes.set(path, mode);
    },
    modeOf: (path) => modes.get(path) ?? 0o644,
    // A scratch LINK that refuses an existing destination: that is the no-clobber property under test.
    link: (from, to) => {
      if (files.has(to)) throw new Error('EEXIST: file already exists');
      const bytes = files.get(from);
      if (bytes === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, bytes);
      modes.set(to, modes.get(from) ?? 0o644);
    },
    unlink: (path) => {
      files.delete(path);
      modes.delete(path);
    },
    removeFile: (path) => {
      files.delete(path);
      modes.delete(path);
    },
    makeDir: () => undefined,
    isExecutable: () => true,
    tempName: (target, attempt) => `${target}.tmp-${attempt}`,
  };
  return { options, files, modes, writes };
}

describe('an incomplete bundle is refused, and nothing is written', () => {
  it('names the missing helper and stages no hook, so a broken install never activates the guard', () => {
    const { options, writes } = scratch({ missing: 'scripts/git-reference-rule.ts' });
    const plan = planInstallation(options);

    expect(plan.refused.join('\n')).toContain('scripts/git-reference-rule.ts is missing');
    // The hook must not be planned at all: an activated hook with no rule leaf aborts every guarded move.
    expect(plan.targets.map((target) => target.name)).not.toContain(BUNDLE_HOOK.name);
    expect(() => applyInstallation(plan, options)).toThrow(/refusing to apply/);
    expect(writes).toHaveLength(0);
  });

  it('refuses an existing owned file whose bytes differ, so another tool\u2019s hook is never overwritten', () => {
    const { options, writes } = scratch({
      existing: { [`${HOOK_DIR}/${BUNDLE_HELPERS[0].name}`]: 'something else entirely\n' },
    });
    const plan = planInstallation(options);

    expect(plan.refused.join('\n')).toContain('different bytes');
    expect(() => applyInstallation(plan, options)).toThrow(/refusing to apply/);
    expect(writes).toHaveLength(0);
  });
});

describe('the staging order protects the window before activation', () => {
  it('plans helpers first, then the generated runner, and the hook last', () => {
    const { options } = scratch();
    const plan = planInstallation(options);
    expect(plan.refused).toEqual([]);
    expect(plan.targets.map((target) => target.name)).toEqual([
      BUNDLE_HELPERS[0].name,
      BUNDLE_HELPERS[1].name,
      RUNNER_NAME,
      BUNDLE_HOOK.name,
    ]);
    // The runner holds this machine's absolute bun path and nothing else, so the hook never resolves one on PATH.
    const runner = plan.targets.find((target) => target.name === RUNNER_NAME);
    expect(runner?.origin).toBe('generated');
    expect(runner?.bytes.toString('utf8')).toBe(`${BUN}\n`);
    // The hook is the only executable file in the bundle.
    expect(plan.targets.map((target) => target.mode)).toEqual([0o644, 0o644, 0o644, 0o755]);
  });

  it('writes in plan order when applied, so the hook file appears only after its helpers', () => {
    const { options, writes } = scratch();
    const plan = planInstallation(options);
    applyInstallation(plan, options);
    // Staging writes a temporary beside each target and publishes it by link, so the order is: stage file, then published name.
    expect(writes.map((write) => write.path.split('/').pop())).toEqual([
      `${BUNDLE_HELPERS[0].name}.tmp-0`,
      `${BUNDLE_HELPERS[1].name}.tmp-0`,
      `${RUNNER_NAME}.tmp-0`,
      `${BUNDLE_HOOK.name}.tmp-0`,
    ]);
  });
});

describe('apply time owns the destination, not plan time', () => {
  it('refuses a destination that appeared after planning, and leaves its foreign bytes untouched', () => {
    const { options, files, writes } = scratch();
    const plan = planInstallation(options);
    expect(plan.refused).toEqual([]);
    const contested = `${HOOK_DIR}/${BUNDLE_HOOK.name}`;
    expect(plan.targets.find((t) => t.path === contested)?.action).toBe('create');

    // A foreign hook lands after the plan was printed, before anyone typed --apply.
    files.set(contested, Buffer.from('#!/bin/sh\necho foreign\n'));

    expect(() => applyInstallation(plan, options)).toThrow(/no-clobber: .*appeared after planning/);
    expect(files.get(contested)?.toString('utf8')).toBe('#!/bin/sh\necho foreign\n');
    // Nothing this run staged is left behind, and helpers written before the refusal were rolled back.
    expect([...files.keys()].some((path) => path.endsWith('.tmp-0'))).toBe(false);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('the real filesystem path, not the memory map', () => {
  /** A scratch directory that looks like a repository: no commit, no clone, no installed hook. */
  const scratchRepo = (): { repo: string; hooks: string; runGit: InstallOptions['runGit'] } => {
    const repo = mkdtempSync(join(tmpdir(), 'refhook-'));
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const runGit = (args: readonly string[]): Buffer => {
      if (args[0] === 'rev-parse') return Buffer.from('.git\n');
      if (args[0] === 'cat-file') return Buffer.from('ok\n');
      if (args[0] === 'show')
        return Buffer.from(`// ${String(args[1]).split(':').slice(1).join(':')}\n`);
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    return { repo, hooks, runGit };
  };

  it('stages exclusively, publishes by link, and refuses a foreign hook that appeared after planning', () => {
    const { repo, hooks, runGit } = scratchRepo();
    // process.execPath is this bun binary: absolute and executable, which the installer requires.
    const options: InstallOptions = { repo, sha: SHA, bunPath: process.execPath, runGit };

    const plan = planInstallation(options);
    expect(plan.refused).toEqual([]);
    expect(applyInstallation(plan, options).created).toHaveLength(4);

    // Real bytes, real modes: the hook is executable, the runner holds the bun path, and no staging file survived.
    expect(statSync(join(hooks, BUNDLE_HOOK.name)).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(hooks, RUNNER_NAME), 'utf8')).toBe(`${process.execPath}\n`);
    expect(readdirSync(hooks).filter((name) => name.includes('.tmp-'))).toEqual([]);

    // Second scratch repo: a foreign hook lands between plan and apply.
    const second = scratchRepo();
    const secondOptions: InstallOptions = {
      repo: second.repo,
      sha: SHA,
      bunPath: process.execPath,
      runGit: second.runGit,
    };
    const secondPlan = planInstallation(secondOptions);
    const contested = join(second.hooks, BUNDLE_HOOK.name);
    writeFileSync(contested, '#!/bin/sh\necho foreign\n', { mode: 0o755 });
    chmodSync(contested, 0o755);

    expect(() => applyInstallation(secondPlan, secondOptions)).toThrow(/no-clobber/);
    expect(readFileSync(contested, 'utf8')).toBe('#!/bin/sh\necho foreign\n');
    expect(readdirSync(second.hooks).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
