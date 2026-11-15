// scripts/landing-git-runner.ts — sentinel-prod-8429 auto-lander unit 3: the process that runs git.
// WHY argv-only and env-isolated: a ref can never be shell syntax, and an ambient GIT_DIR must not
// answer about another repository.

import { execFileSync } from 'node:child_process';
import type { GitRunner } from './landing-git';

const MAX_BUFFER = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

// WHY all of these are stripped: each redirects which repository answers, or names a program to start.
const STRIPPED_ENV = (
  'GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES ' +
  'GIT_NAMESPACE GIT_CEILING_DIRECTORIES GIT_EXEC_PATH GIT_TEMPLATE_DIR GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS ' +
  'GIT_PROXY_COMMAND GIT_EDITOR GIT_SEQUENCE_EDITOR GIT_PAGER'
).split(' ');

// WHY pinned: a tool that answers only about the policy repository must not read user or system config,
// and it must not refresh a shared index while it reads.
const PINNED_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
};

export function sanitizedEnv(
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    // WHY the whole GIT_TRACE family: with one of them set, git appends trace lines - including the
    // SHAs under review - to a caller-chosen file, which contradicts a reader that claims to write nothing.
    const stripped =
      STRIPPED_ENV.includes(key) || key.startsWith('GIT_CONFIG_') || key.startsWith('GIT_TRACE');
    if (value !== undefined && !stripped) env[key] = value;
  }
  return { ...env, ...PINNED_ENV };
}

/** One argv array per call, no shell, bounded output, a timeout, and a cleaned environment. */
export function execRunner(repo: string): GitRunner {
  return {
    run(args) {
      try {
        const stdout = execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER,
          timeout: TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: sanitizedEnv(),
        });
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { status?: number | null; stdout?: string; stderr?: string };
        const status = typeof failure.status === 'number' ? failure.status : -1;
        return { status, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) };
      }
    },
  };
}
