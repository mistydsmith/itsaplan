// apps/api/src/modules/issues/__tests__/unit/landing-executor.test.ts — sentinel-prod-8429 atom A focus, revision 2.
// WHY injection and not mock.module: mock.module is PROCESS-GLOBAL, so a module mocked here would answer inside every other
// suite in the same worker. Every seam below is a parameter instead, so nothing in this file can leak, and no global mock is
// claimed.
//
// WHAT IT PROVES, in Root's order: every refusal is observed on runLandingExecutor - the entry that COULD reach Git, proof,
// storage and the CLI - and each asserts that none of them was called; forged publication, column, claim-owner and actor
// values are supplied for real and the trusted host values still win; and the closer is the authenticated session user.

import { describe, expect, it } from 'bun:test';

import type { LandingJob } from '../../../../../../../scripts/itsaplan_land';
import type { SessionUser } from '#shared/auth-context';
import {
  buildLandingJob,
  runLandingExecutor,
  type LandingExecutorRuntime,
  type LandingExecutorSeams,
  type LandingItemInput,
  type TrustedPublication,
} from '../../landing-executor';

const SESSION_USER = { id: 'user-authenticated', role: 'user' } as unknown as SessionUser;

const PUBLICATION: TrustedPublication = {
  repo: '/trusted/repo',
  targetRef: 'refs/heads/main',
  excludedPathPatterns: ['Legal/'],
  repoIdentity: 'itsaplan',
  remote: 'misty',
  expectedPushURL: 'file:///trusted/repo',
  projectId: 7,
  columnId: 11,
  completedColumnId: 12,
  closeRepoKey: 'trusted-close-key',
  manifestPath: '/trusted/manifest.json',
};

const item = (over: Partial<LandingItemInput> = {}): LandingItemInput => ({
  itemKey: 'sentinel-prod-8429',
  receipts: [],
  verdicts: [],
  columns: [],
  ...over,
});

/** Every capability the executor could reach, so a refusal can prove it reached none of them. */
interface Reached {
  git: number;
  proof: number;
  storage: number;
  cli: number;
  closerSeen: string[];
}

function runtime(
  reached: Reached,
  over: Partial<LandingExecutorRuntime> = {},
): LandingExecutorRuntime {
  return {
    slotDriver: {
      connect: async () => {
        reached.git += 1;
        return { query: async () => ({ rows: [] }), end: async () => undefined };
      },
    },
    proofRunner: {
      run: async () => {
        reached.proof += 1;
        return { candidateSha: 'a'.repeat(40), outcomes: [] };
      },
    },
    dbClient: {
      transaction: async () => {
        reached.storage += 1;
        return undefined;
      },
    },
    publication: PUBLICATION,
    activeManifestPath: PUBLICATION.manifestPath,
    actorName: 'trusted-host-actor',
    readFile: () => '',
    writeOut: () => undefined,
    writeErr: () => undefined,
    ...over,
  } as unknown as LandingExecutorRuntime;
}

function seams(reached: Reached, over: LandingExecutorSeams = {}): LandingExecutorSeams {
  const capture = async (job: LandingJob) => {
    reached.cli += 1;
    reached.closerSeen.push(job.actorName);
    return { ok: true as const, stage: 'record' as const, reason: 'landed' };
  };
  return {
    requestUser: async () => SESSION_USER,
    signedIn: async (user) => user,
    permit: async () => undefined,
    land: async (job) => capture(job),
    record: async (job) => capture(job),
    ...over,
  };
}

const request = (): Request => new Request('http://localhost/');

/** A caller that tries to widen the blast radius. Supplied for real, not in a comment. */
const FORGED_ITEM = {
  ...item(),
  repo: '/forged/repo',
  targetRef: 'refs/heads/release',
  remote: 'forged-remote',
  expectedPushURL: 'file:///forged/repo',
  excludedPathPatterns: [],
  completedColumnId: 999,
  closeRepoKey: 'forged-close-key',
  columnId: 998,
  projectId: 997,
  repoIdentity: 'forged-identity',
  actorName: 'forged-lane-actor',
} as unknown as LandingItemInput;

describe('a refused executor reaches no Git, proof, storage or CLI', () => {
  const cases: Array<
    [string, Partial<LandingExecutorSeams>, Partial<LandingExecutorRuntime>, string]
  > = [
    ['no session', { requestUser: async () => null }, {}, 'ADAPTER_CLOSER_MISSING'],
    [
      'a session resolver that throws (an unverifiable token)',
      {
        requestUser: async () => {
          throw new Error('token verification failed');
        },
      },
      {},
      'ADAPTER_CLOSER_MISSING',
    ],
    [
      'a deactivated account',
      {
        signedIn: async () => {
          throw new Error('This account is deactivated');
        },
      },
      {},
      'ADAPTER_CLOSER_MISSING',
    ],
    [
      'no work_items edit on the project',
      {
        permit: async () => {
          throw new Error('You do not have permission to edit work items');
        },
      },
      {},
      'ADAPTER_CLOSER_MISSING',
    ],
    [
      'a publication configured against another manifest',
      {},
      { activeManifestPath: '/server/other-manifest.json' },
      'JOB_MALFORMED',
    ],
  ];

  for (const [label, seamOver, runtimeOver, code] of cases) {
    it(`refuses ${label}, before the CLI and before any capability`, async () => {
      const reached: Reached = { git: 0, proof: 0, storage: 0, cli: 0, closerSeen: [] };
      const report = await runLandingExecutor({
        request: request(),
        item: item(),
        runtime: runtime(reached, runtimeOver),
        seams: seams(reached, seamOver),
      });
      expect(report.ok).toBe(false);
      expect(`${report.code}`).toBe(code);
      expect(reached).toEqual({ git: 0, proof: 0, storage: 0, cli: 0, closerSeen: [] });
    });
  }

  it('refuses an item missing its item-shaped fields, before the CLI', async () => {
    const reached: Reached = { git: 0, proof: 0, storage: 0, cli: 0, closerSeen: [] };
    const report = await runLandingExecutor({
      request: request(),
      item: { itemKey: 'sentinel-prod-8429' } as unknown as LandingItemInput,
      runtime: runtime(reached),
      seams: seams(reached),
    });
    expect(report.code).toBe('JOB_FIELDS_MISSING');
    expect(reached.cli).toBe(0);
  });
});

describe('the trusted host values win over a forged caller, and the closer is the session user', () => {
  it('hands the CLI a job built from host configuration, ignoring forged publication and column overrides', async () => {
    const reached: Reached = { git: 0, proof: 0, storage: 0, cli: 0, closerSeen: [] };
    let seen: LandingJob | null = null;
    const report = await runLandingExecutor({
      request: request(),
      item: FORGED_ITEM,
      runtime: runtime(reached),
      seams: seams(reached, {
        land: async (job) => {
          seen = job;
          return { ok: true, stage: 'record', reason: 'landed' };
        },
      }),
    });
    expect(report.ok).toBe(true);
    const job = seen as unknown as LandingJob;
    expect(job.repo).toBe('/trusted/repo');
    expect(job.targetRef).toBe('refs/heads/main');
    expect(job.remote).toBe('misty');
    expect(job.expectedPushURL).toBe('file:///trusted/repo');
    expect(job.excludedPathPatterns).toEqual(['Legal/']);
    expect(job.completedColumnId).toBe(12);
    expect(job.closeRepoKey).toBe('trusted-close-key');
    expect(job.projectId).toBe(7);
    expect(job.repoIdentity).toBe('itsaplan');
    // The actor is the host's name, not the forged one on the item.
    expect(job.actorName).toBe('trusted-host-actor');
  });

  it('binds exactly the five owner names, with the closer from the session and never a forged claim or configured id', async () => {
    const reached: Reached = { git: 0, proof: 0, storage: 0, cli: 0, closerSeen: [] };
    let owners: Record<string, unknown> | null = null;
    await runLandingExecutor({
      request: request(),
      item: FORGED_ITEM,
      // A configured id exists nowhere in the runtime contract; a claim owner is not part of the item either. Both are
      // supplied here as extra values on the runtime, and neither can be read.
      runtime: {
        ...runtime(reached),
        landingCloserUserId: 'configured-id-that-must-not-win',
        claimActor: 'claim-owner-that-must-not-win',
      } as unknown as LandingExecutorRuntime,
      seams: seams(reached, {
        land: async (_job, deps) => {
          owners = await deps.loadAdapter('scripts/forged_owners.ts');
          return { ok: true, stage: 'record', reason: 'landed' };
        },
      }),
    });
    const bound = owners as unknown as Record<string, unknown>;
    expect(Object.keys(bound).sort()).toEqual([
      'landingCloserUserId',
      'landingDbClient',
      'landingProofRunner',
      'landingSlotDriver',
      'nativeRecordStorage',
    ]);
    expect(bound.landingCloserUserId).toBe('user-authenticated');
    // The bound loader answers for the path it is asked about, because the item's module name is never used to load anything.
    expect(bound.nativeRecordStorage).toBeDefined();
  });

  it('builds the job by field name, so excess caller properties never reach it', () => {
    const built = buildLandingJob(FORGED_ITEM, PUBLICATION, 'trusted-host-actor');
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(Object.keys(built.job).sort()).not.toContain('adapterModule');
      expect(built.job.repo).toBe('/trusted/repo');
      expect(built.job.completedColumnId).toBe(12);
    }
  });
});
