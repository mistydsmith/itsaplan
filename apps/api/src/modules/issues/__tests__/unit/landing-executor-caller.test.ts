// apps/api/src/modules/issues/__tests__/unit/landing-executor-caller.test.ts — sentinel-prod-8429 caller focus.
// WHY injection and not mock.module: mock.module is PROCESS-GLOBAL and would answer inside every other suite in the worker.
// Here the environment is a plain object, the driver is a fake, and nothing global is touched.
//
// WHAT IT PROVES: the caller binds the manifest through the OWNER's constant rather than a spelling of its own; it refuses at
// construction, where an operator sees it, when the server's manifest is unset or does not match the publication; and a request
// never reads the environment, so changing env after construction changes nothing.

import { describe, expect, it } from 'bun:test';

import type { LandingJob, LandReport } from '../../../../../../../scripts/itsaplan_land';
import type { SessionUser } from '#shared/auth-context';
import type {
  LandingExecutorSeams,
  LandingItemInput,
  TrustedPublication,
} from '../../landing-executor';
import {
  activeManifestPathFromEnv,
  createLandingExecutorCaller,
} from '../../landing-executor-caller';

const MANIFEST = '/srv/manifests/tracker-rules.json';

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
  manifestPath: MANIFEST,
};

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ TRACKER_RULES_MANIFEST: MANIFEST, ...over }) as NodeJS.ProcessEnv;

const item = (): LandingItemInput => ({
  itemKey: 'sentinel-prod-8429',
  receipts: [],
  verdicts: [],
  columns: [],
});

const slot = () => ({
  connect: async () => ({ query: async () => ({ rows: [] }), end: async () => undefined }),
});

const SESSION_USER = { id: 'user-authenticated' } as unknown as SessionUser;

describe('the caller binds the manifest through the owner constant', () => {
  it('uses the exact variable name the tracker gate owns, so the two cannot drift', () => {
    // If the gate ever renames it, this fails rather than silently reading nothing.
    expect(activeManifestPathFromEnv(env())).toBe(MANIFEST);
  });

  it('refuses at construction when the server manifest is unset, naming the variable', () => {
    expect(() =>
      createLandingExecutorCaller({
        publication: PUBLICATION,
        actorName: 'host',
        proofRunner: { run: async () => ({ candidateSha: 'a'.repeat(40), outcomes: [] }) },
        env: env({ TRACKER_RULES_MANIFEST: '' }),
        slotDriver: slot(),
      }),
    ).toThrow(/TRACKER_RULES_MANIFEST is not set/);
  });

  it('refuses at construction when the publication names a different manifest, quoting both', () => {
    expect(() =>
      createLandingExecutorCaller({
        publication: { ...PUBLICATION, manifestPath: '/srv/other.json' },
        actorName: 'host',
        proofRunner: { run: async () => ({ candidateSha: 'a'.repeat(40), outcomes: [] }) },
        env: env(),
        slotDriver: slot(),
      }),
    ).toThrow(/\/srv\/other\.json but the server runs \/srv\/manifests\/tracker-rules\.json/);
  });

  it('refuses at construction when no database url is available for the dedicated session', () => {
    expect(() =>
      createLandingExecutorCaller({
        publication: PUBLICATION,
        actorName: 'host',
        proofRunner: { run: async () => ({ candidateSha: 'a'.repeat(40), outcomes: [] }) },
        env: env({ DATABASE_URL: '   ' }),
      }),
    ).toThrow(/DATABASE_URL is not set/);
  });
});

describe('a request never reads the environment', () => {
  it('keeps the manifest it was constructed with even after env changes', async () => {
    const sealed = env();
    let reported: LandReport | null = null;
    let runtimeManifest: string | null = null;
    const seam: LandingExecutorSeams = {
      requestUser: async () => SESSION_USER,
      signedIn: async (user) => user,
      permit: async () => undefined,
      land: async (job: LandingJob): Promise<LandReport> => {
        reported = { ok: true, stage: 'record', reason: `actor ${job.actorName}` };
        return reported;
      },
    };

    const caller = createLandingExecutorCaller({
      publication: PUBLICATION,
      actorName: 'trusted-host-actor',
      proofRunner: { run: async () => ({ candidateSha: 'a'.repeat(40), outcomes: [] }) },
      env: sealed,
      slotDriver: slot(),
      seams: seam,
    });

    // The process env changes AFTER construction; the caller must not care.
    sealed.TRACKER_RULES_MANIFEST = '/srv/somewhere-else.json';
    runtimeManifest = caller.activeManifestPath;

    const report = await caller.run(new Request('http://localhost/'), item());
    expect(report.ok).toBe(true);
    expect(runtimeManifest).toBe(MANIFEST);
    expect(reported).not.toBeNull();
  });

  it('returns the executor refusal unchanged instead of swallowing it', async () => {
    const caller = createLandingExecutorCaller({
      publication: PUBLICATION,
      actorName: 'trusted-host-actor',
      proofRunner: { run: async () => ({ candidateSha: 'a'.repeat(40), outcomes: [] }) },
      env: env(),
      slotDriver: slot(),
      seams: { requestUser: async () => null },
    });
    const report = await caller.run(new Request('http://localhost/'), item());
    expect(report.ok).toBe(false);
    expect(report.code).toBe('ADAPTER_CLOSER_MISSING');
  });
});
