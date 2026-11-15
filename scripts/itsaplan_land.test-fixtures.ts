// scripts/itsaplan_land.test-fixtures.ts — sentinel-prod-8429 native auto-lander CLI: the job, the adapter rig
// and the evidence the CLI test files share, over the landed units' own accepted fixtures.

import { fakeProofs, fakeSlot, KEY, type PublishFixture } from './landing-publish.test-fixtures';
import type { GitRunner } from './landing-git';
import { fakeStorage, type FakeStorageOptions } from './landing-record.test-fixtures';
import type * as land from './itsaplan_land';

export type Fields = Record<string, unknown>;
export type Args = readonly string[];
export const TESTS = ['suite one'];
export const CLOSER = 'user-native-executor';
export const HELD = { items: { [KEY]: { columnId: 11 } } };
export const COLUMNS = [
  { id: 11, projectId: 7, stateType: 'started' },
  { id: 12, projectId: 7, stateType: 'completed' },
];
export const REVIEWED = { id: 'r1', itemKey: KEY, author: 'dsh', allowedPaths: ['scripts/a.ts'] };
export const OUTCOMES = [{ name: 'suite one', passed: 3, failed: 0 }];
export const receipt = (f: PublishFixture, over: Fields = {}) => {
  const flight = { candidateSha: f.candidate, baseSha: f.base, namedTests: TESTS };
  return { ...REVIEWED, ...flight, outcomes: OUTCOMES, ...over };
};
export const pass = (f: PublishFixture, over: Fields = {}) => {
  const verdict = { id: 'v1', reviewer: 'codex-prime', sha: f.candidate, decision: 'PASS' };
  return { ...verdict, sequence: 1, ...over };
};
export const TARGET = {
  targetRef: 'refs/heads/main',
  repoIdentity: 'itsaplan',
  closeRepoKey: 'tracker',
};
export const ITEM = {
  itemKey: KEY,
  projectId: 7,
  columnId: 11,
  status: 'in_progress',
  actorName: 'qwen2',
};
export const BOARD = {
  completedColumnId: 12,
  columns: COLUMNS,
  adapterModule: 'injected://adapter',
};
export function jobFor(f: PublishFixture, over: Partial<land.LandingJob> = {}): land.LandingJob {
  const repo = { repo: f.repo, remote: f.remote, expectedPushURL: f.remotePath };
  const evidence = { receipts: [receipt(f)], verdicts: [pass(f)] };
  const excludedPathPatterns = ['Legal/', 'pleading'];
  return { ...TARGET, ...ITEM, ...BOARD, ...repo, ...evidence, excludedPathPatterns, ...over };
}

// One fake storage, the frozen adapter contract over it as the adapter that exists writes it, and the CLI deps
// that reach both. calls records what the CLI asked the storage factory for.
export type Deps = Partial<land.LandDeps>;
export function rig(
  f: PublishFixture,
  stored: FakeStorageOptions = HELD,
  over: Fields = {},
  extra: Deps = {},
) {
  const storage = fakeStorage(stored);
  const calls: { factoryOptions: Fields[] } = { factoryOptions: [] };
  const out: string[] = [];
  const err: string[] = [];
  const exports: Fields = {
    nativeRecordStorage: (options: Fields) => {
      calls.factoryOptions.push(options);
      return storage;
    },
    landingDbClient: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
    landingSlotDriver: fakeSlot().driver,
    landingProofRunner: fakeProofs({ candidateSha: f.candidate, namedTests: TESTS }),
    landingCloserUserId: CLOSER,
    ...over,
  };
  const deps: land.LandDeps = {
    readFile: () => JSON.stringify(jobFor(f)),
    loadAdapter: async () => exports,
    runnerFor: () => f.git,
    writeOut: (text) => void out.push(text),
    writeErr: (text) => void err.push(text),
    ...extra,
  };
  return { storage, calls, out, err, deps };
}
/** A runner that answers one chosen read with a fixed line and passes every other call to the scratch repo. */
export const answering = (inner: GitRunner, chosen: (args: Args) => boolean, stdout: string) => ({
  run: (args: Args) => (chosen(args) ? { status: 0, stdout, stderr: '' } : inner.run(args)),
});
