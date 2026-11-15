// scripts/landing-publish.test-fixtures.ts — sentinel-prod-8429 unit 4 test fixtures.
// WHY separate: the bare product-and-remote builder plus the fake slot driver and fake proof runner are
// test-only and long enough to push the behaviour suite over its size cap. No assertion lives here, and
// nothing here is imported by production code.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LandingOutcome } from './landing-evidence';
import { execRunner, type GitRunner } from './landing-git';
import {
  cleanupFixtures as cleanupGitFixtures,
  fixture,
  KEY,
  type Fixture,
} from './landing-git.test-fixtures';
import type { SlotDriver, SlotSession } from './landing-slot';
import type { ProofRunInput, ProofRunResult, ProofRunner } from './landing-publish';

const roots: string[] = [];

/** Every fixture directory this file created, plus the Git fixtures it borrowed. */
export function cleanupPublishFixtures(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupGitFixtures();
}

export interface PublishFixture {
  /** The bare product repository the coordinator acts on. */
  repo: string;
  /** The bare repository standing in for the configured publication remote. */
  remotePath: string;
  remote: string;
  base: string;
  candidate: string;
  /** A second commit on the same base, for races and non-fast-forward pushes. */
  sibling: string;
  git: GitRunner;
  readonly fixture: Fixture;
  setTarget(sha: string): void;
  targetRef(): string | null;
  remoteTarget(): string | null;
  addPushURL(url: string): void;
  resetPushURLs(url: string): void;
}

function must(status: number, stdout: string, stderr: string, what: string): string {
  if (status !== 0) throw new Error(`${what}: ${stderr || stdout}`);
  return stdout;
}

/**
 * A bare product repository with one commit on refs/heads/main, a candidate on top, and a bare remote
 * seeded at the base so a normal push is a fast-forward. Everything is local objects and files: no
 * product ref, no network, no worktree.
 */
export function publishFixture(over: { remote?: string; partial?: boolean } = {}): PublishFixture {
  const product = fixture();
  const remotePath = mkdtempSync(join(tmpdir(), 'landing-publish-remote-'));
  roots.push(remotePath);
  const git = execRunner(product.repo);
  must(git.run(['init', '-q', '--bare', remotePath]).status, '', '', 'remote init');
  const remote = over.remote ?? 'misty';
  const base = product.commit('README.md', 'root', `${KEY}: root`);
  const subject = over.partial
    ? `${KEY} (partial): publish the candidate`
    : `${KEY}: publish the candidate`;
  const candidate = product.commit('scripts/a.ts', 'candidate', subject, [base]);
  const sibling = product.commit('scripts/b.ts', 'sibling', `${KEY}: a sibling landing`, [base]);
  product.setRef('refs/heads/main', base);
  const added = git.run(['remote', 'add', remote, remotePath]);
  must(added.status, added.stdout, added.stderr, 'remote add');
  const seeded = git.run(['push', remote, `${base}:refs/heads/main`]);
  must(seeded.status, seeded.stdout, seeded.stderr, 'seed remote');

  const setTarget = (sha: string) => {
    const out = git.run(['update-ref', 'refs/heads/main', sha]);
    must(out.status, out.stdout, out.stderr, 'move target');
  };
  const readRef = (ref: string, repo = product.repo): string | null => {
    const out = execRunner(repo).run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return out.status === 0 ? out.stdout.trim() : null;
  };
  return {
    repo: product.repo,
    remotePath,
    remote,
    base,
    candidate,
    sibling,
    git,
    fixture: product,
    setTarget,
    targetRef: () => readRef('refs/heads/main'),
    remoteTarget: () => readRef('refs/heads/main', remotePath),
    addPushURL: (url: string) => {
      const out = git.run(['remote', 'set-url', '--add', '--push', remote, url]);
      must(out.status, out.stdout, out.stderr, 'add push url');
    },
    resetPushURLs: (url: string) => {
      const out = git.run(['remote', 'set-url', '--push', remote, url]);
      must(out.status, out.stdout, out.stderr, 'reset push url');
    },
  };
}

/** Records every statement so a test can prove the slot protocol ran, and nothing else did. */
export interface FakeSlot {
  driver: SlotDriver;
  queries: Array<{ sql: string; params?: readonly unknown[] }>;
  connects: number;
  ends: number;
}

export interface FakeSlotOptions {
  held?: boolean;
  unlockReleased?: boolean;
  connectThrows?: string;
  endThrows?: string;
  /** Answers the lock statement with a shape no reader may accept. */
  lockReply?: unknown;
}

export function fakeSlot(options: FakeSlotOptions = {}): FakeSlot {
  const state: FakeSlot = {
    driver: { connect: async () => session },
    queries: [],
    connects: 0,
    ends: 0,
  };
  const session: SlotSession = {
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        return {
          rows: 'lockReply' in options ? [options.lockReply] : [{ held: options.held ?? true }],
        };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ released: options.unlockReleased ?? true }] };
      }
      return { rows: [] };
    },
    async end() {
      state.ends += 1;
      if (options.endThrows) throw new Error(options.endThrows);
    },
  };
  state.driver = {
    async connect() {
      state.connects += 1;
      if (options.connectThrows) throw new Error(options.connectThrows);
      return session;
    },
  };
  return state;
}

export interface FakeProofs extends ProofRunner {
  calls: ProofRunInput[];
}

export interface FakeProofOptions {
  candidateSha: string;
  namedTests: readonly string[];
  /** Per-name overrides; a name with no entry reports 3 passed. */
  outcomes?: LandingOutcome[];
  /** Report a run against a different candidate. */
  reportSha?: string;
  throwOnRun?: string;
}

/** A proof runner that runs nothing: the production module must accept the named outcomes as evidence. */
export function fakeProofs(options: FakeProofOptions): FakeProofs {
  const calls: ProofRunInput[] = [];
  const outcomes: LandingOutcome[] =
    options.outcomes ??
    options.namedTests.map((name) => ({ name, passed: 3, failed: 0 }) as LandingOutcome);
  const result: ProofRunResult = {
    candidateSha: options.reportSha ?? options.candidateSha,
    outcomes,
  };
  return {
    calls,
    run(input) {
      calls.push(input);
      if (options.throwOnRun) throw new Error(options.throwOnRun);
      return result;
    },
  };
}

/**
 * A git runner that records argv and can act once, immediately before a chosen subcommand.
 * WHY `afterFirst`: several subcommands repeat during a flight (rev-parse is asked before the recheck and
 * again after the CAS), so a test that must intervene at one specific point names the call that marks it.
 */
export function recordingGit(
  inner: GitRunner,
  options: { before?: { command: string; act: () => void; afterFirst?: string } } = {},
): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const seen = new Set<string>();
  let acted = false;
  return {
    calls,
    run(args) {
      calls.push([...args]);
      const before = options.before;
      const ready = before !== undefined && args[0] === before.command && !acted;
      if (ready && (!before.afterFirst || seen.has(before.afterFirst))) {
        acted = true;
        before.act();
      }
      seen.add(args[0] ?? '');
      return inner.run(args);
    },
  };
}

export { KEY };
