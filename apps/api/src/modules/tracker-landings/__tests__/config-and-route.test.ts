// apps/api/src/modules/tracker-landings/__tests__/config-and-route.test.ts — sentinel-prod-8429 atom F focus.
// WHY no database, no git and no child process: the caller factory is injected, so this file proves what the route does with a
// request - which repository key it resolves, what it refuses, and what reaches the caller - without a landing running.
//
// WHAT IT PROVES: unset registers no route while invalid JSON fails visibly at load; a repository key the host did not configure
// is 404; a refusal control (a caller-supplied host field) cannot widen a landing; and the caller receives the ACTUAL Request.

import { describe, expect, it } from 'bun:test';

import {
  createTrackerLandingRoutes,
  itemFromRequest,
  landConfigured,
  loadLandingConfig,
  type LandingRepoConfig,
  type LandingRouteContext,
} from '../index';
import type { LandingItemInput } from '../../issues/landing-executor';
import type { LandingRequestBodyType } from '../model';
import type { LandReport } from '../../../../../../scripts/itsaplan_land';

const REPO: LandingRepoConfig = {
  publication: {
    repo: '/srv/itsaplan',
    targetRef: 'refs/heads/main',
    excludedPathPatterns: ['Legal/'],
    repoIdentity: 'itsaplan',
    remote: 'misty',
    expectedPushURL: 'file:///srv/itsaplan',
    projectId: 7,
    columnId: 11,
    completedColumnId: 12,
    closeRepoKey: 'itsaplan-main',
    manifestPath: '/srv/manifests/tracker-rules.json',
  },
  actorName: 'itsaplan-host',
  proofs: { 'unit-a': ['bun', 'test', 'a.test.ts'] },
};

const env = (raw?: string): NodeJS.ProcessEnv =>
  (raw === undefined ? {} : { ITSAPLAN_LANDING_CONFIG: raw }) as NodeJS.ProcessEnv;

const raw = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ repos: { itsaplan: { ...REPO, ...over } } });

describe('unset registers nothing; a broken value fails at load, visibly', () => {
  it('returns null when the variable is not set, so no route exists', () => {
    expect(loadLandingConfig(env())).toBeNull();
    expect(createTrackerLandingRoutes(null).routes).toHaveLength(0);
  });

  it('throws on invalid JSON instead of disabling the feature silently', () => {
    expect(() => loadLandingConfig(env('{not json'))).toThrow(/is not valid JSON/);
  });

  it('throws on a repository that names a short ref, a relative checkout or no proofs', () => {
    expect(() =>
      loadLandingConfig(
        env(
          JSON.stringify({
            repos: {
              itsaplan: { ...REPO, publication: { ...REPO.publication, targetRef: 'main' } },
            },
          }),
        ),
      ),
    ).toThrow(/targetRef must be a full ref/);
    expect(() =>
      loadLandingConfig(env(JSON.stringify({ repos: { itsaplan: { ...REPO, proofs: {} } } }))),
    ).toThrow(/proofs must map at least one named test/);
    expect(() =>
      loadLandingConfig(
        env(
          JSON.stringify({
            repos: { itsaplan: { ...REPO, publication: { ...REPO.publication, repo: 'srv/x' } } },
          }),
        ),
      ),
    ).toThrow(/repo must be an absolute path/);
  });
});

describe('a caller-supplied host field cannot widen a landing', () => {
  it('drops every property outside item evidence and mode, by name', () => {
    const forged = {
      receipts: [{ id: 'r1' }],
      verdicts: [],
      columns: [],
      // Every one of these would be a landing the host did not configure.
      repo: '/tmp/elsewhere',
      targetRef: 'refs/heads/release',
      remote: 'forged',
      expectedPushURL: 'file:///tmp/elsewhere',
      excludedPathPatterns: [],
      completedColumnId: 999,
      closeRepoKey: 'forged-key',
      manifestPath: '/tmp/forged.json',
      closerUserId: 'somebody-else',
      proofs: { 'unit-a': ['sh', '-c', 'anything'] },
    };
    const { item, mode } = itemFromRequest(
      { itemKey: 'sentinel-prod-1' },
      forged as unknown as LandingRequestBodyType,
    );
    expect(Object.keys(item).sort()).toEqual(['columns', 'itemKey', 'receipts', 'verdicts']);
    expect(mode).toBe('land');
    // The one allowed non-default value is the mode, and an unknown mode is refused rather than coerced.
    expect(itemFromRequest({ itemKey: 'k' }, { mode: 'record' }).mode).toBe('record');
    expect(() =>
      itemFromRequest({ itemKey: 'k' }, { mode: 'force' } as unknown as LandingRequestBodyType),
    ).toThrow(/mode must be 'land' or 'record'/);
  });

  it('refuses a non-array evidence field rather than accepting whatever was sent', () => {
    expect(() =>
      itemFromRequest({ itemKey: 'k' }, { receipts: 'nope' } as unknown as LandingRequestBodyType),
    ).toThrow(/receipts must be an array/);
  });
});

describe('the handler resolves the repository and hands the caller the actual request', () => {
  const config = loadLandingConfig(env(raw()));
  if (config === null) throw new Error('fixture configuration was refused');

  const seen: Array<{ repoKey: string; request: Request; item: LandingItemInput; mode?: string }> =
    [];
  const callerFor = (repoKey: string) => ({
    run: async (request: Request, item: LandingItemInput, mode?: 'land' | 'record') => {
      seen.push({ repoKey, request, item, ...(mode === undefined ? {} : { mode }) });
      const report: LandReport = { ok: true, stage: 'record', reason: 'landed' };
      return report;
    },
  });

  const context = (
    repoKey: string,
    over: Partial<LandingRouteContext> = {},
  ): LandingRouteContext => ({
    params: { repoKey, itemKey: 'sentinel-prod-1' },
    // No 'repo' here: the schema does not allow one, which is the point. The forged-field case is the handler-level test above.
    body: { receipts: [], verdicts: [], columns: [], mode: 'record' },
    request: new Request(`http://localhost/tracker/landings/${repoKey}/sentinel-prod-1`, {
      method: 'POST',
    }),
    user: { id: 'user-1' },
    set: {},
    ...over,
  });

  it('passes the same Request object through, with only evidence and mode, and answers 409 on a refusal', async () => {
    const ctx = context('itsaplan');
    const { report } = await landConfigured(config.repos, callerFor, ctx);
    expect(report.ok).toBe(true);
    expect(ctx.set.status).toBe(200);
    expect(seen[0]?.request).toBe(ctx.request);
    expect(seen[0]?.repoKey).toBe('itsaplan');
    expect(seen[0]?.mode).toBe('record');
    expect(Object.keys(seen[0]?.item ?? {})).not.toContain('repo');

    const refusing = () => ({
      run: async () => ({ ok: false, stage: 'record', reason: 'refused' }) as LandReport,
    });
    const refusedCtx = context('itsaplan');
    await landConfigured(config.repos, refusing, refusedCtx);
    expect(refusedCtx.set.status).toBe(409);
  });

  it('answers 404 for a repository key the host did not configure', async () => {
    await expect(
      landConfigured(config.repos, callerFor, context('not-configured')),
    ).rejects.toThrow(/No landing is configured for repository 'not-configured'/);
    expect(seen).toHaveLength(1);
  });

  it('answers 401 when the request carries no session, before any repository is touched', async () => {
    await expect(
      landConfigured(config.repos, callerFor, context('itsaplan', { user: null })),
    ).rejects.toThrow(/Sign in to land a work item/);
    expect(seen).toHaveLength(1);
  });

  it('registers exactly one POST at that path, so nothing else about landings is callable', () => {
    const routes = createTrackerLandingRoutes(config, { callerFor });
    const posts = routes.routes.filter((route) => route.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe('/tracker/landings/:repoKey/:itemKey');
  });
});
