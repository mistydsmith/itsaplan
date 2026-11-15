// scripts/landing-git.test-fixtures.ts — sentinel-prod-8429 unit 3 test fixtures (authorised third path).
// WHY separate: the bare-repository builder is reusable and long enough to push the behaviour suite over
// its size cap, and it is test-only. It holds no assertion and no production logic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateGitEligibility, execRunner, sanitizedEnv, type GitPolicy } from './landing-git';

const roots: string[] = [];

/** Removes every fixture created since the last call; the suite runs it after each test. */
export function cleanupFixtures(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Fixture {
  repo: string;
  commit(path: string, content: string, message: string, parents?: string[]): string;
  setRef(ref: string, sha: string): void;
}

/**
 * A temporary BARE repository built from objects only: hash-object, mktree, commit-tree, update-ref.
 * No worktree, no hooks, no network, and the child environment is the production sanitiser, so the
 * fixture cannot be steered by an ambient GIT_DIR either.
 */
export function fixture(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'landing-git-'));
  roots.push(repo);
  const files = new Map<string, string>();
  const run = (args: string[], input?: string) =>
    Bun.spawnSync(['git', '-C', repo, ...args], {
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: sanitizedEnv({
        ...process.env,
        GIT_AUTHOR_NAME: 'Orca',
        GIT_AUTHOR_EMAIL: 'o@x',
        GIT_COMMITTER_NAME: 'Orca',
        GIT_COMMITTER_EMAIL: 'o@x',
      }),
    });
  const out = (args: string[], input?: string): string => {
    const result = run(args, input);
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const treeFrom = (entries: Map<string, string>): string => {
    const lines: string[] = [];
    const nested = new Map<string, Map<string, string>>();
    for (const [path, blob] of entries) {
      const slash = path.indexOf('/');
      if (slash === -1) lines.push(`100644 blob ${blob}\t${path}`);
      else {
        const dir = path.slice(0, slash);
        nested.set(dir, (nested.get(dir) ?? new Map()).set(path.slice(slash + 1), blob));
      }
    }
    for (const [dir, child] of nested) lines.push(`040000 tree ${treeFrom(child)}\t${dir}`);
    return out(['mktree'], lines.map((line) => `${line}\n`).join('')).trim();
  };
  const commit = (
    path: string,
    content: string,
    message: string,
    parents: string[] = [],
  ): string => {
    files.set(path, out(['hash-object', '-w', '--stdin'], content).trim());
    const args = ['commit-tree', treeFrom(new Map(files)), '-m', message];
    for (const parent of parents) args.push('-p', parent);
    return out(args).trim();
  };
  const setRef = (ref: string, sha: string) => out(['update-ref', ref, sha]);
  run(['init', '-q', '--bare']);
  return { repo, commit, setRef };
}

export const KEY = 'p-8429.3';

/** The policy an operator would configure; tests override one field at a time. */
export const policy = (repo: string, over: Partial<GitPolicy> = {}): GitPolicy => ({
  repo,
  targetRef: 'refs/heads/main',
  excludedPathPatterns: ['Legal/', 'pleading'],
  ...over,
});

export const receiptFor = (candidateSha: string, baseSha: string, allowedPaths: string[]) => ({
  candidateSha,
  baseSha,
  itemKey: KEY,
  allowedPaths,
});

export const decide = (
  repo: string,
  candidate: string,
  base: string,
  paths: string[],
  over: Partial<GitPolicy> = {},
) =>
  evaluateGitEligibility(policy(repo, over), receiptFor(candidate, base, paths), execRunner(repo));

export const code = (decision: { code?: string }) => decision.code;

/** A fixture whose base is on refs/heads/main and whose candidate is one commit on top. */
export function pair(path: string, content: string, message: string) {
  const f = fixture();
  const base = f.commit('README.md', 'x', 'root');
  const candidate = f.commit(path, content, message, [base]);
  f.setRef('refs/heads/main', base);
  return { ...f, base, candidate };
}

/** Every policy the validator must refuse, as data: the test asserts the code and the reason fragment. */
/** Every policy the validator must refuse, as data: the test asserts the code and the reason fragment. */
export const POLICY_INVALID_CASES: Array<[unknown, string]> = [
  [null, 'no policy'],
  [
    { ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] }, repo: '' },
    'no repository',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      targetRef: 'main',
    },
    'exact ref',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: [],
    },
    'protects no paths',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: [''],
    },
    'blank',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: ['*.docx'],
    },
    'glob',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: ['^Legal/'],
    },
    'regular expression',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: ['Legal/$'],
    },
    'regular expression',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: ['Legal\\.md'],
    },
    'regular expression',
  ],
  [
    {
      ...{ repo: '/r', targetRef: 'refs/heads/main', excludedPathPatterns: ['Legal/'] },
      excludedPathPatterns: ['Legal//pleading'],
    },
    'doubled slash',
  ],
];
