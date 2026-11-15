// scripts/landing-publish.test.ts — sentinel-prod-8429 unit 4 behaviour suite.
// WHY: every case here is a way a publisher can claim more than it did, so each refusal proves the target ref
// and the remote were NOT touched, and the argv is inspected so no force and no second remote can appear.
// NO product ref, NO network, NO database, NO provider: a temporary bare repository pair and a fake slot.

import { afterEach, describe, expect, it } from 'bun:test';

import { publishLanding, type ProofRunner, type PublicationConfig } from './landing-publish';
import {
  cleanupPublishFixtures,
  fakeProofs,
  fakeSlot,
  KEY,
  publishFixture,
  recordingGit,
  type PublishFixture,
} from './landing-publish.test-fixtures';
import type { LandingOutcome } from './landing-evidence';
import { execRunner } from './landing-git';
import { policy } from './landing-git.test-fixtures';

afterEach(() => cleanupPublishFixtures());
const PATHS = ['scripts/a.ts'];
const TESTS = ['suite one'];

function publication(f: PublishFixture, over: Partial<PublicationConfig> = {}): PublicationConfig {
  return {
    policy: policy(f.repo),
    repoIdentity: 'itsaplan',
    remote: f.remote,
    expectedPushURL: f.remotePath,
    ...over,
  };
}

function receipt(f: PublishFixture, over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    itemKey: KEY,
    candidateSha: f.candidate,
    baseSha: f.base,
    author: 'dsh',
    allowedPaths: PATHS,
    namedTests: TESTS,
    outcomes: [{ name: 'suite one', passed: 3, failed: 0 }],
    ...over,
  };
}
const pass = (f: PublishFixture, over: Record<string, unknown> = {}) => ({
  id: 'v1',
  reviewer: 'qwen-1959',
  sha: f.candidate,
  decision: 'PASS',
  sequence: 1,
  ...over,
});
type Case = {
  f: PublishFixture;
  publication?: Partial<PublicationConfig>;
  receipts?: unknown[];
  verdicts?: unknown[];
  slot?: ReturnType<typeof fakeSlot>;
  proofs?: ProofRunner;
  runner?: Parameters<typeof publishLanding>[1];
};

async function run(c: Case) {
  const slot = c.slot ?? fakeSlot();
  const proofs = c.proofs ?? fakeProofs({ candidateSha: c.f.candidate, namedTests: TESTS });
  const result = await publishLanding(
    {
      publication: publication(c.f, c.publication),
      item: { itemKey: KEY, status: 'in_progress' },
      receipts: c.receipts ?? [receipt(c.f)],
      verdicts: c.verdicts ?? [pass(c.f)],
      slotDriver: slot.driver,
      proofRunner: proofs,
    },
    c.runner ?? c.f.git,
  );
  return { result, slot, proofs };
}
describe('a published landing', () => {
  it('moves the ref with a CAS and reads the exact SHA back from the remote', async () => {
    const f = publishFixture();
    const { result, slot } = await run({ f });
    expect([result.code, result.published, result.landed]).toEqual([undefined, true, true]);
    expect(result.remoteSha).toBe(f.candidate);
    expect(f.targetRef()).toBe(f.candidate);
    expect(f.remoteTarget()).toBe(f.candidate);
    // The slot ran the whole protocol and closed exactly once.
    expect(slot.connects).toBe(1);
    expect(slot.ends).toBe(1);
    expect(slot.queries.map((q) => q.sql)).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
      expect.stringContaining('pg_advisory_unlock'),
    ]);
  });
  it('pushes one remote, one ref, with no force and no second remote', async () => {
    const f = publishFixture();
    const git = recordingGit(f.git);
    const { result } = await run({ f, runner: git });
    expect(result.published).toBe(true);
    const pushes = git.calls.filter((args) => args[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(['push', '--porcelain', f.remote, `${f.candidate}:refs/heads/main`]);
    for (const args of git.calls)
      expect(args.filter((a) => a === '--force' || a === '-f')).toHaveLength(0);
    // --all on a push would publish every local ref; it is only legitimate when listing remote URLs.
    for (const args of git.calls.filter((row) => row[0] === 'push'))
      expect(args.filter((a) => a === '--all' || a === '--tags')).toHaveLength(0);
    // The readback happens after the push, never before.
    const order = git.calls.map((args) => args[0]);
    expect(order.lastIndexOf('ls-remote')).toBeGreaterThan(order.indexOf('push'));
  });
  it('carries the (partial) marker and closes nothing', async () => {
    const f = publishFixture({ partial: true });
    const { result, slot } = await run({ f });
    expect([result.code, result.published, result.partial]).toEqual([undefined, true, true]);
    expect(result.reason).toContain('not complete');
    // Two statements: the lock and the unlock. No item write exists in this slice.
    expect(slot.queries).toHaveLength(2);
  });
});
describe('every refusal leaves the target ref and the remote untouched', () => {
  const untouched = (f: PublishFixture) => {
    expect(f.targetRef()).toBe(f.base);
    expect(f.remoteTarget()).toBe(f.base);
  };

  it('refuses a self-PASS without taking the slot', async () => {
    const f = publishFixture();
    const slot = fakeSlot();
    const { result } = await run({ f, slot, verdicts: [pass(f, { reviewer: 'dsh' })] });
    expect([result.code, result.published, slot.connects]).toEqual([
      'NOT_INDEPENDENT_REVIEWER',
      false,
      0,
    ]);
    untouched(f);
  });
  it('refuses a verdict on a different SHA', async () => {
    const f = publishFixture();
    const { result } = await run({ f, verdicts: [pass(f, { sha: f.sibling })] });
    expect(result.code).toBe('VERDICT_MISSING');
    untouched(f);
  });
  it('refuses when a newer verdict is a RETURN', async () => {
    const f = publishFixture();
    const { result } = await run({
      f,
      verdicts: [pass(f), pass(f, { id: 'v2', decision: 'RETURN', sequence: 2 })],
    });
    expect(result.code).toBe('VERDICT_NOT_PASS');
    untouched(f);
  });
  it('refuses malformed evidence', async () => {
    const f = publishFixture();
    const { result } = await run({ f, verdicts: [pass(f, { decision: 'MAYBE' })] });
    expect(result.code).toBe('VERDICT_INVALID');
    untouched(f);
  });
  it('refuses a moved target before any ref write', async () => {
    const f = publishFixture();
    f.setTarget(f.sibling);
    const { result } = await run({ f });
    expect(result.code).toBe('STALE_TARGET');
    expect(f.targetRef()).toBe(f.sibling);
    expect(f.remoteTarget()).toBe(f.base);
  });
  it('refuses while another landing holds the slot', async () => {
    const f = publishFixture();
    const slot = fakeSlot({ held: false });
    const { result } = await run({ f, slot });
    expect(result.code).toBe('SLOT_BUSY');
    expect(result.landed).toBe(false);
    untouched(f);
    expect(slot.ends).toBe(1);
  });
  it('refuses when a named proof failed, before taking the slot', async () => {
    const f = publishFixture();
    const slot = fakeSlot();
    const proofs = fakeProofs({
      candidateSha: f.candidate,
      namedTests: TESTS,
      outcomes: [{ name: 'suite one', passed: 2, failed: 1 }],
    });
    const { result } = await run({ f, slot, proofs });
    expect([result.code, slot.connects]).toEqual(['PROOF_FAILED', 0]);
    expect(result.reason).toContain('suite one');
    untouched(f);
  });
  it('refuses proofs run against the wrong candidate', async () => {
    const f = publishFixture();
    const proofs = fakeProofs({
      candidateSha: f.candidate,
      namedTests: TESTS,
      reportSha: f.sibling,
    });
    const { result } = await run({ f, proofs });
    expect(result.code).toBe('PROOF_WRONG_CANDIDATE');
    untouched(f);
  });

  it('refuses named outcomes that do not match the receipt', async () => {
    const f = publishFixture();
    const proofs = fakeProofs({
      candidateSha: f.candidate,
      namedTests: TESTS,
      outcomes: [{ name: 'some other suite', passed: 3, failed: 0 }],
    });
    const { result } = await run({ f, proofs });
    expect(result.code).toBe('PROOF_NAMES_MISMATCH');
    expect(result.reason).toContain('some other suite');
    untouched(f);
  });

  it('refuses a push URL that is not the configured Misty-owned one', async () => {
    const f = publishFixture();
    f.addPushURL('https://example.invalid/not-misty.git');
    const { result } = await run({ f });
    expect(result.code).toBe('PUSH_URL_MISMATCH');
    expect(result.reason).toContain('example.invalid');

    untouched(f);
  });

  it('refuses an unknown remote rather than defaulting to one', async () => {
    const f = publishFixture();
    const { result } = await run({ f, publication: { remote: 'upstream' } });
    expect(result.code).toBe('PUBLICATION_REMOTE_UNKNOWN');
    untouched(f);
  });

  it('refuses an incomplete publication config before any Git or slot call', async () => {
    const f = publishFixture();
    const slot = fakeSlot();
    const { result } = await run({ f, slot, publication: { remote: '  ' } });
    expect(result.code).toBe('PUBLICATION_INVALID');
    untouched(f);
    expect(slot.connects).toBe(0);
  });
});
describe('a race after the recheck', () => {
  it('refuses the CAS when the target moved in between, and lands nothing', async () => {
    const f = publishFixture();
    // WHY this seam: the coordinator rechecks immediately before the CAS, so the only honest way to prove
    // the CAS itself refuses is to move the ref after that recheck and before update-ref runs.
    const git = recordingGit(f.git, {
      before: { command: 'update-ref', act: () => f.setTarget(f.sibling) },
    });
    const { result } = await run({ f, runner: git });
    expect([result.code, result.landed]).toEqual(['REF_CHANGED_AT_CAS', false]);
    expect(f.targetRef()).toBe(f.sibling);
    expect(f.remoteTarget()).toBe(f.base);
  });
});
describe('a target that moves again after the CAS', () => {
  it('stops before pushing when the ref no longer carries the candidate', async () => {
    const f = publishFixture();
    // The CAS succeeded, then another writer moved the target before the post-move read.
    const git = recordingGit(f.git, {
      before: {
        command: 'rev-parse',
        afterFirst: 'update-ref',
        act: () => f.setTarget(f.sibling),
      },
    });
    const { result } = await run({ f, runner: git });
    expect([result.code, result.landed, result.published]).toEqual(['REF_NOT_MOVED', false, false]);
    expect(git.calls.filter((args) => args[0] === 'push')).toHaveLength(0);
    expect(f.remoteTarget()).toBe(f.base);
  });
});
describe('a remote that disagrees with the push', () => {
  it('refuses to report published when the readback names another SHA', async () => {
    const f = publishFixture();
    // WHY this seam: the push reports success and the remote is moved by something else immediately after
    // it, so only the readback can tell the operator what the remote actually holds.
    const git = recordingGit(f.git, {
      before: {
        command: 'ls-remote',
        act: () => {
          execRunner(f.remotePath).run(['update-ref', 'refs/heads/main', f.base]);
        },
      },
    });
    const { result } = await run({ f, runner: git });
    expect([result.code, result.published, result.landed, result.remoteSha]).toEqual([
      'REMOTE_READBACK_MISMATCH',
      false,
      true,
      f.base,
    ]);
  });
});
describe('a push failure keeps the local landing and says so', () => {
  it('reports landed but not published, and never forces', async () => {
    const f = publishFixture();
    // The remote moves ahead on a sibling, so the real push is a non-fast-forward and must be refused.
    const pushed = f.git.run(['push', f.remote, `${f.sibling}:refs/heads/main`]);
    expect(pushed.status).toBe(0);
    const recorder = recordingGit(f.git);
    const { result } = await run({ f, runner: recorder });
    expect([result.code, result.landed, result.published]).toEqual(['PUSH_FAILED', true, false]);
    expect(f.targetRef()).toBe(f.candidate);
    expect(f.remoteTarget()).toBe(f.sibling);
    expect(recorder.calls.filter((args) => args.includes('--force'))).toHaveLength(0);
  });
});
describe('a slot that does not clean up', () => {
  it('reports the cleanup beside the landing instead of a clean pass', async () => {
    const f = publishFixture();
    const slot = fakeSlot({ unlockReleased: false });
    const { result } = await run({ f, slot });
    expect([result.code, result.published, result.landed]).toEqual(['CLEANUP_FAILED', true, true]);
    expect(result.cleanup).toContain('unlock');
    expect(result.reason).toContain('did not clean up');
    expect(f.remoteTarget()).toBe(f.candidate);
  });
});
describe('malformed proof outcomes never publish', () => {
  const ONE = 'suite one';
  const cases: Array<[string, unknown[]]> = [
    ['NaN passed', [{ name: ONE, passed: Number.NaN, failed: 0 }]],
    ['undefined passed', [{ name: ONE, passed: undefined, failed: 0 }]],
    ['negative passed', [{ name: ONE, passed: -1, failed: 0 }]],
    ['fractional passed', [{ name: ONE, passed: 1.5, failed: 0 }]],
    ['negative failed', [{ name: ONE, passed: 3, failed: -1 }]],
    ['zero totals', [{ name: ONE, passed: 0, failed: 0 }]],
    [
      'duplicate names',
      [
        { name: ONE, passed: 1, failed: 0 },
        { name: ONE, passed: 1, failed: 0 },
      ],
    ],
  ];
  for (const [label, outcomes] of cases) {
    it(`refuses ${label} and touches neither ref`, async () => {
      const f = publishFixture();
      const slot = fakeSlot();
      const proofs = fakeProofs({
        candidateSha: f.candidate,
        namedTests: [ONE],
        outcomes: outcomes as LandingOutcome[],
      });
      const { result } = await run({ f, slot, proofs });
      expect([result.published, result.landed]).toEqual([false, false]);
      expect(result.code).toBeDefined();
      expect([f.targetRef(), f.remoteTarget(), slot.connects]).toEqual([f.base, f.base, 0]);
    });
  }
});
describe('evidence replaced while the proofs run', () => {
  it('refuses the changed flight and moves neither ref', async () => {
    const f = publishFixture();
    const receipts: unknown[] = [receipt(f)];
    const verdicts: unknown[] = [pass(f)];
    const swapped = receipt(f, {
      candidateSha: f.sibling,
      allowedPaths: ['scripts/a.ts', 'scripts/b.ts'],
      namedTests: ['suite two'],
      outcomes: [{ name: 'suite two', passed: 2, failed: 0 }],
    });
    // WHY the mutation happens inside run(): that is exactly the window the coordinator awaits across.
    const proofs = {
      run() {
        receipts[0] = swapped;
        verdicts[0] = pass(f, { sha: f.sibling });
        return {
          candidateSha: f.candidate,
          outcomes: [{ name: 'suite one', passed: 3, failed: 0 }],
        };
      },
    };
    const git = recordingGit(f.git);
    const { result } = await run({ f, receipts, verdicts, proofs, runner: git });
    expect(result.code).toBe('EVIDENCE_CHANGED_AFTER_PROOF');
    expect([result.published, f.targetRef(), f.remoteTarget()]).toEqual([false, f.base, f.base]);
    expect(git.calls.filter((args) => args[0] === 'push')).toHaveLength(0);
  });

  it('cannot publish a suite the runner was asked for that never passed', async () => {
    const f = publishFixture();
    const proofs = {
      run(input: { namedTests: readonly string[] }) {
        // WHY the cast: the runner is caller code and can still try; the receipt must not be what it rewrites.
        (input.namedTests as string[]).splice(0, 1, 'suite two');
        return {
          candidateSha: f.candidate,
          outcomes: [{ name: 'suite two', passed: 3, failed: 0 }],
        };
      },
    };
    const { result } = await run({ f, proofs });
    expect(result.code).toBe('PROOF_NAMES_MISMATCH');
    expect([result.published, f.targetRef(), f.remoteTarget()]).toEqual([false, f.base, f.base]);
  });
});
