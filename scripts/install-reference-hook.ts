//
// Installs the three tracked sources at one reviewed SHA (git-reference-guard.ts, git-reference-rule.ts, the hook script) plus a
// generated reference-transaction.runner holding the absolute executable Bun path. Source is read with `git show <sha>:<path>`,
// never from a checkout, because a working tree may hold a half review or an unpushed edit and the hook then runs for every
// worktree that shares the common hooks directory. Plan is the default; --apply is explicit.
//
// APPLY TIME OWNS THE DESTINATION (Root RETURN msg_e24fb6738ebb, then msg_7f530eb76275): every target is re-read at apply, bytes
// are staged with an exclusive create beside the target, publication is `link(temp, target)` which fails if the target exists, the
// hook is published last, an execute-bit repair is recomputed from the file on disk rather than the plan's snapshot, only paths this
// run created by link are rolled back, and both rollback and cleanup failures are reported instead of hidden. It never touches an
// unrelated hook, never runs `git config`, and never installs into a checkout's own .git/hooks when worktrees share a directory.
//
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Helpers first: the hook cannot run without them. */
export const BUNDLE_HELPERS = [
  { source: 'scripts/git-reference-guard.ts', name: 'git-reference-guard.ts', mode: 0o644 },
  { source: 'scripts/git-reference-rule.ts', name: 'git-reference-rule.ts', mode: 0o644 },
] as const;

/** The hook itself, written last: its appearance is what makes git start running the guard. */
export const BUNDLE_HOOK = {
  source: 'scripts/hooks/reference-transaction',
  name: 'reference-transaction',
  mode: 0o755,
} as const;

export const BUNDLE_SOURCES = [...BUNDLE_HELPERS, BUNDLE_HOOK] as const;
export const RUNNER_NAME = 'reference-transaction.runner';
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EXECUTABLE_BIT = 0o111;

export type RunGit = (args: readonly string[]) => Buffer;

export interface InstallOptions {
  repo: string;
  /** The reviewed commit; forty lowercase hex. */
  sha: string;
  /** Absolute path of the executable that runs the guard, written into the runner verbatim. */
  bunPath: string;
  /** Seams, so a test drives a scratch filesystem and never a repository. */
  runGit?: RunGit;
  readFile?: (path: string) => Buffer;
  writeFile?: (path: string, bytes: Buffer, mode: number) => void;
  exists?: (path: string) => boolean;
  chmod?: (path: string, mode: number) => void;
  removeFile?: (path: string) => void;
  makeDir?: (path: string) => void;
  isExecutable?: (path: string) => boolean;
  modeOf?: (path: string) => number;
  link?: (from: string, to: string) => void;
  unlink?: (path: string) => void;
  /** Produces a temporary name beside a target. Only uniqueness matters. */
  tempName?: (target: string, attempt: number) => string;
}

export interface PlannedTarget {
  name: string;
  path: string;
  origin: 'source' | 'generated';
  bytes: Buffer;
  mode: number;
  /** 'identical' still applies when the mode needs repairing for the hook. */
  action: 'create' | 'identical';
  /** True when the bytes match but an executable hook is not executable: repaired at apply. */
  modeRepair: boolean;
}

export interface InstallPlan {
  repo: string;
  hookDir: string;
  sha: string;
  bunPath: string;
  targets: PlannedTarget[];
  refused: string[];
}

const defaultRunGit =
  (repo: string): RunGit =>
  (args) =>
    execFileSync('git', [...args], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The common hooks directory — shared by every worktree, and the only place git runs a hook from. */
export function commonHooksDir(runGit: RunGit, repo: string): string | null {
  const raw = runGit(['rev-parse', '--git-common-dir']).toString('utf8').trim();
  if (raw === '') return null;
  return join(isAbsolute(raw) ? raw : resolve(repo, raw), 'hooks');
}

function resolveIo(options: InstallOptions) {
  return {
    readFile: options.readFile ?? ((path: string) => readFileSync(path)),
    writeFile:
      options.writeFile ??
      ((path: string, bytes: Buffer, mode: number) =>
        writeFileSync(path, bytes, { mode, flag: 'wx' })),
    exists: options.exists ?? ((path: string) => existsSync(path)),
    chmod: options.chmod ?? ((path: string, mode: number) => chmodSync(path, mode)),
    removeFile: options.removeFile ?? ((path: string) => rmSync(path)),
    makeDir: options.makeDir ?? ((path: string) => mkdirSync(path, { recursive: true })),
    isExecutable:
      options.isExecutable ??
      ((path: string) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    modeOf: options.modeOf ?? ((path: string) => statSync(path).mode & 0o777),
    link: options.link ?? ((from: string, to: string) => linkSync(from, to)),
    unlink: options.unlink ?? ((path: string) => unlinkSync(path)),
    tempName:
      options.tempName ??
      ((target: string, attempt: number) => `${target}.tmp-${process.pid}-${attempt}`),
  };
}

/**
 * Builds the plan. Never writes: it reads the SHA and the target directory, and returns the four targets in staging order or the
 * reasons it refuses.
 */
export function planInstallation(options: InstallOptions): InstallPlan {
  const io = resolveIo(options);
  const runGit = options.runGit ?? defaultRunGit(options.repo);
  const repo = resolve(options.repo);
  const { sha, bunPath } = options;
  const refused: string[] = [];
  const hooks = commonHooksDir(runGit, repo);
  const hookDir = hooks ?? join(repo, '.git', 'hooks');
  const plan: InstallPlan = { repo, hookDir, sha, bunPath, targets: [], refused };

  if (!COMMIT_PATTERN.test(sha))
    refused.push(`--sha must be forty lowercase hex digits, got '${sha}'`);
  if (!isAbsolute(bunPath)) refused.push(`--bun must be an absolute path, got '${bunPath}'`);
  else if (!io.isExecutable(bunPath)) refused.push(`--bun is not an executable file: ${bunPath}`);
  if (hooks === null)
    refused.push(
      'the repository reports no common git directory, so there is no shared hooks directory',
    );
  if (refused.length > 0) return plan;

  try {
    runGit(['cat-file', '-e', `${sha}^{commit}`]);
  } catch (error) {
    refused.push(`--sha ${sha} is not a commit in ${repo}: ${describe(error)}`);
    return plan;
  }

  const place = (name: string, bytes: Buffer, mode: number, origin: PlannedTarget['origin']) => {
    const path = join(hookDir, name);
    const present = io.exists(path);
    const identical = present && io.readFile(path).equals(bytes);
    const needsMode =
      identical && (mode & EXECUTABLE_BIT) !== 0 && (io.modeOf(path) & EXECUTABLE_BIT) === 0;
    plan.targets.push({
      name,
      path,
      origin,
      bytes,
      mode,
      action: identical ? 'identical' : 'create',
      modeRepair: needsMode,
    });
  };

  const stage = (name: string, source: string, mode: number, origin: PlannedTarget['origin']) => {
    let bytes: Buffer;
    try {
      bytes = runGit(['show', `${sha}:${source}`]);
    } catch (error) {
      // WHY a refusal and not a skip: an install without the rule leaf aborts every guarded move with a module-not-found message
      // — the R5 defect — so absence is refused here by name, and the refusal short-circuits before the hook is planned.
      refused.push(`the bundle is incomplete at ${sha}: ${source} is missing (${describe(error)})`);
      return;
    }
    if (bytes.length === 0) {
      refused.push(`the bundle is incomplete at ${sha}: ${source} is empty`);
      return;
    }
    place(name, bytes, mode, origin);
  };

  for (const entry of BUNDLE_HELPERS) stage(entry.name, entry.source, entry.mode, 'source');
  if (refused.length > 0) return plan;

  // The runner is generated, not tracked: it holds this machine's absolute Bun path, which no repository should carry.
  place(RUNNER_NAME, Buffer.from(`${bunPath}\n`, 'utf8'), 0o644, 'generated');
  if (refused.length > 0) return plan;

  stage(BUNDLE_HOOK.name, BUNDLE_HOOK.source, BUNDLE_HOOK.mode, 'source');
  if (refused.length > 0) return plan;

  // A destination that exists with other bytes is somebody else's work under our name. Refused, never replaced.
  for (const target of plan.targets) {
    if (!io.exists(target.path)) continue;
    if (target.action === 'create') {
      refused.push(
        `${target.path} already exists with different bytes; refusing to replace a hook this installer did not write`,
      );
    }
  }
  return plan;
}

export interface AppliedPlan {
  created: string[];
  skipped: string[];
  modeRepaired: string[];
}

/**
 * Applies a plan: revalidate, stage beside each target, publish with a no-clobber link (hook last), roll back only what this run
 * created, and report rollback failures instead of hiding them.
 */
export function applyInstallation(
  plan: InstallPlan,
  options: InstallOptions = { repo: plan.repo, sha: plan.sha, bunPath: plan.bunPath },
): AppliedPlan {
  if (plan.refused.length > 0) throw new Error(`refusing to apply: ${plan.refused.join('; ')}`);
  const io = resolveIo({ ...options, repo: plan.repo, sha: plan.sha, bunPath: plan.bunPath });

  const created: string[] = [];
  const skipped: string[] = [];
  const modeRepaired: string[] = [];
  const rollback: Array<{ path: string; previousMode: number | null }> = [];
  const rollbackFailures: string[] = [];
  const staged: string[] = [];
  let applyFailure: unknown = null;

  io.makeDir(plan.hookDir);
  try {
    for (const target of plan.targets) {
      // 1. REVALIDATE at apply time. A destination may have appeared since planning; the plan's verdict is not a licence to
      // overwrite it.
      if (io.exists(target.path)) {
        const current = io.readFile(target.path);
        if (!current.equals(target.bytes)) {
          throw new Error(
            `no-clobber: ${target.path} appeared after planning with different bytes; it was not written and is unchanged`,
          );
        }
        // WHY recomputed here from the file on disk: the plan's modeRepair is a snapshot. A byte-identical hook that appeared
        // after planning, at 0644, would otherwise be skipped and reported as installed while git ignores it.
        const currentMode = io.modeOf(target.path);
        if ((target.mode & EXECUTABLE_BIT) !== 0 && (currentMode & EXECUTABLE_BIT) === 0) {
          const previousMode = currentMode;
          io.chmod(target.path, target.mode | EXECUTABLE_BIT);
          rollback.push({ path: target.path, previousMode });
          modeRepaired.push(target.path);
          continue;
        }
        skipped.push(target.path);
        continue;
      }

      // 2. STAGE beside the target, then publish atomically with a link that fails if the target exists. A truncating write in
      // place would let git run a partial hook; `rename` would silently replace a file that appeared a moment ago.
      let attempt = 0;
      let temp = io.tempName(target.path, attempt);
      while (io.exists(temp)) {
        attempt += 1;
        if (attempt > 8)
          throw new Error(`could not find a free staging name beside ${target.path}`);
        temp = io.tempName(target.path, attempt);
      }
      io.writeFile(temp, target.bytes, target.mode);
      // Tracked BEFORE chmod: a chmod failure must still remove the file this run created.
      staged.push(temp);
      io.chmod(temp, target.mode);
      try {
        io.link(temp, target.path);
      } catch (error) {
        throw new Error(
          `no-clobber: could not publish ${target.path} because it exists (${describe(error)}); the file is unchanged`,
        );
      }
      rollback.push({ path: target.path, previousMode: null });
      created.push(target.path);
    }
  } catch (failure) {
    applyFailure = failure;
  }

  // Cleanup runs in its own step, so its failures can be reported: a `finally` that collects them cannot change the return value
  // or the error, which is how the previous version hid them.
  for (const temp of staged) {
    try {
      if (io.exists(temp)) io.unlink(temp);
    } catch (failure) {
      rollbackFailures.push(`${temp}: ${describe(failure)}`);
    }
  }

  if (applyFailure !== null) {
    for (const entry of [...rollback].reverse()) {
      try {
        if (entry.previousMode === null) {
          if (io.exists(entry.path)) io.removeFile(entry.path);
        } else {
          io.chmod(entry.path, entry.previousMode);
        }
      } catch (failure) {
        rollbackFailures.push(`${entry.path}: ${describe(failure)}`);
      }
    }
    const detail =
      rollbackFailures.length === 0
        ? ''
        : `; rollback also failed for ${rollbackFailures.join(', ')}`;
    throw new Error(`${describe(applyFailure)}${detail}`);
  }

  // A cleanup failure on an otherwise successful apply is still an incomplete install, so it is reported, not swallowed.
  if (rollbackFailures.length > 0) {
    const detail = `the install applied but cleanup failed for ${rollbackFailures.join(', ')}`;
    throw new Error(detail);
  }

  return { created, skipped, modeRepaired };
}

const USAGE = `usage: bun scripts/install-reference-hook.ts --sha <40-hex> --bun <absolute bun path> [--repo <path>] [--apply]

  Without --apply it prints the plan and writes nothing.`;

/** CLI entry. Exit codes: 0 planned or applied, 2 refused, 1 failed. */
export function main(argv: readonly string[], options: Partial<InstallOptions> = {}): number {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const apply = argv.includes('--apply');
  const plan = planInstallation({
    repo: flag('repo') ?? process.cwd(),
    sha: flag('sha') ?? '',
    bunPath: flag('bun') ?? '',
    ...options,
  });

  console.log(`plan  sha ${plan.sha}`);
  console.log(`hook-dir ${plan.hookDir}`);
  for (const target of plan.targets) {
    const verdict = target.modeRepair ? 'repair-mode' : target.action;
    console.log(
      `${verdict.padEnd(11)} ${target.path}  (${target.origin}, ${target.bytes.length} bytes)`,
    );
  }
  if (plan.refused.length > 0) {
    for (const reason of plan.refused) console.error(`refused: ${reason}`);
    console.error('nothing was written.');
    return 2;
  }
  if (!apply) {
    console.log('plan only: re-run with --apply to install.');
    return 0;
  }
  const result = applyInstallation(plan, {
    repo: plan.repo,
    sha: plan.sha,
    bunPath: plan.bunPath,
    ...options,
  });
  console.log(
    `applied: ${result.created.length} created, ${result.modeRepaired.length} mode repaired, ${result.skipped.length} already identical.`,
  );
  return 0;
}

// The CLI entry. Not exercised by a suite: Misty's mutation-only rule; the installer is reviewed by its plan output.
if (typeof Bun !== 'undefined' && import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`failed: ${describe(error)}`);
    process.exit(1);
  }
}
