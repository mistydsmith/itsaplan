// apps/api/src/modules/issues/landing-executor.ts — sentinel-prod-8429 unit 6 runtime entry (atom A, revision 2).
// WHY it exists: the shipped CLI in scripts/itsaplan_land.ts can plan, publish, record and report its own refusal codes, but
// it refuses to supply the five AdapterOwners itself because two of them can impersonate: the closer and the storage client.
// This file composes them from an AUTHENTICATED request plus HOST configuration, and nothing else.
//
// THIS IS A SOURCE ENTRY, NOT A DELIVERY. It still needs its runtime caller - a process that holds a real Request and the
// host configuration - and nothing here activates a route, a scheduler or a server. A factory alone is not the feature.
//
// WHAT DECIDES THE CLOSER: sessionUser.id, from requestUser(request) and then signedIn(user), the SAME policy the routes run.
// There is exactly one assignment to landingCloserUserId below, and no job field, claim row, request body or configuration
// value can reach it.
//
// WHAT DECIDES ACCESS: the existing assertPermission(projectId, user, 'work_items', 'edit'). WHY that owner and not a
// composed matrix read: it carries the owner-role allowance and the project-access refusal, and re-implementing only the
// matrix would silently drop the first.
//
// WHAT DECIDES THE PUBLICATION: the host's TrustedPublication, every time. WHY the job is BUILT here instead of accepted as
// an argument: repo, targetRef, remote, expectedPushURL, excluded paths, the completed column and closeRepoKey are the
// landing's blast radius. A caller that could pass them could point a landing at another checkout or complete another column,
// so only the item-shaped fields (itemKey, receipts, verdicts, columns) are read from the caller and the rest come from the
// configuration the process was started with. This is also WHY process.env is never written per request: one request must
// not be able to steer the next one.
//
// WHY the manifest is compared: the close service reads the manifest the host was started with. If the publication was
// configured against a different file, the landing would prove one graph and close against another, so the mismatch is
// refused before any Git, proof or storage call.

import { assertPermission } from '#shared/access';
import { requestUser, signedIn, type SessionUser } from '#shared/auth-context';
import { nativeRecordStorage } from './landing-record-storage';
import {
  landJob,
  recordJob,
  type AdapterOwners,
  type LandDeps,
  type LandingJob,
  type LandReport,
} from '../../../../../scripts/itsaplan_land';
import { execRunner } from '../../../../../scripts/landing-git';
import type { ColumnDescriptor } from '../../../../../scripts/landing-record';

/** Host configuration for everything that widens a landing's blast radius. Supplied at start-up, never per request. */
export interface TrustedPublication {
  /** Absolute path to the checkout a landing may touch. */
  repo: string;
  /** Exact ref, never a short name. */
  targetRef: string;
  excludedPathPatterns: string[];
  repoIdentity: string;
  remote: string;
  expectedPushURL: string;
  projectId: number;
  /** Informational: the CLI re-reads the item's column under the lock. */
  columnId: number | null;
  /** The column a FULL landing completes into. Explicit, never inferred. */
  completedColumnId: number;
  closeRepoKey: string;
  /** The manifest this publication was configured against. Must equal the host's active manifest. */
  manifestPath: string;
}

/** Host configuration, supplied at start-up. Never part of a landing job and never read from a request body. */
export interface LandingExecutorRuntime {
  slotDriver: AdapterOwners['landingSlotDriver'];
  proofRunner: AdapterOwners['landingProofRunner'];
  dbClient: AdapterOwners['landingDbClient'];
  publication: TrustedPublication;
  /** The manifest the server itself is running with; the publication must match it. */
  activeManifestPath: string;
  /** The host's own name, recorded on the landing. Not a claim and not a session field. */
  actorName: string;
  readFile: (path: string) => string;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /**
   * TEST SEAM ONLY. Production omits it and the real, imported nativeRecordStorage is composed - a shipped storage replaced
   * by a caller's factory would report a landing it never stored.
   */
  nativeRecordStorageForTest?: AdapterOwners['nativeRecordStorage'];
}

/** The item-shaped part a caller may supply. Everything else about the job comes from TrustedPublication. */
export interface LandingItemInput {
  itemKey: string;
  receipts: unknown[];
  verdicts: unknown[];
  columns: ColumnDescriptor[];
  status?: string;
  archived?: boolean;
}

/** The seams a unit test may replace. Production passes nothing here. */
export interface LandingExecutorSeams {
  requestUser?: (request: Request) => Promise<SessionUser | null>;
  signedIn?: (user: SessionUser) => Promise<SessionUser>;
  permit?: (
    projectId: number,
    user: SessionUser,
    resource: 'work_items',
    action: 'edit',
  ) => Promise<void>;
  land?: (job: LandingJob, deps: LandDeps) => Promise<LandReport>;
  record?: (job: LandingJob, deps: LandDeps) => Promise<LandReport>;
}

export interface LandingExecutorInput {
  request: Request;
  item: LandingItemInput;
  runtime: LandingExecutorRuntime;
  mode?: 'land' | 'record';
  seams?: LandingExecutorSeams;
}

const stop = (
  stage: LandReport['stage'],
  code: LandReport['code'],
  reason: string,
): LandReport => ({
  ok: false,
  stage,
  code,
  reason,
});

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * WHY a narrow adapter instead of handing nativeRecordStorage straight to AdapterOwners: the owner type accepts
 * `client?: unknown` (so a unit fixture can omit it) while the real factory REQUIRES a transaction-capable client. This
 * closes that gap in one place, by passing the client through and letting the factory refuse a missing one.
 */
const bindNativeRecordStorage: AdapterOwners['nativeRecordStorage'] = (options) =>
  nativeRecordStorage(options as Parameters<typeof nativeRecordStorage>[0]);

/**
 * Builds the job from host configuration plus the item-shaped fields, or reports why it will not.
 *
 * WHY `narrow as Partial<LandingItemInput>` and never a spread of the caller's object: an excess-property spread would carry
 * a forged repo, completedColumnId or closeRepoKey straight into the job. Each field is copied by name.
 */
export function buildLandingJob(
  item: LandingItemInput,
  publication: TrustedPublication,
  actorName: string,
): { ok: true; job: LandingJob } | { ok: false; report: LandReport } {
  const missing: string[] = [];
  if (!item?.itemKey?.trim()) missing.push('itemKey');
  if (!Array.isArray(item?.receipts)) missing.push('receipts');
  if (!Array.isArray(item?.verdicts)) missing.push('verdicts');
  if (!Array.isArray(item?.columns)) missing.push('columns');
  if (missing.length > 0) {
    return {
      ok: false,
      report: stop(
        'job',
        'JOB_FIELDS_MISSING',
        `the landing item is missing ${missing.join(', ')}`,
      ),
    };
  }

  const job: LandingJob = {
    // From host configuration only. Nothing below this block is read from the caller.
    repo: publication.repo,
    targetRef: publication.targetRef,
    excludedPathPatterns: [...publication.excludedPathPatterns],
    repoIdentity: publication.repoIdentity,
    remote: publication.remote,
    expectedPushURL: publication.expectedPushURL,
    projectId: publication.projectId,
    columnId: publication.columnId,
    completedColumnId: publication.completedColumnId,
    closeRepoKey: publication.closeRepoKey,
    actorName,
    // From the caller, by name. These describe the item, not the blast radius.
    itemKey: item.itemKey,
    receipts: item.receipts,
    verdicts: item.verdicts,
    columns: item.columns,
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.archived === undefined ? {} : { archived: item.archived }),
  } as LandingJob;
  return { ok: true, job };
}

/**
 * Builds the five AdapterOwners for one authenticated executor request.
 *
 * WHY it returns a report instead of throwing: the CLI's own contract is a report with a stage and a code, and an executor
 * that threw would bypass every refusal the caller already knows how to print.
 */
export async function composeOwners(
  input: LandingExecutorInput,
): Promise<{ ok: true; owners: AdapterOwners } | { ok: false; report: LandReport }> {
  const runtime = input.runtime;
  const seams = input.seams ?? {};
  const resolveUser = seams.requestUser ?? requestUser;
  const applyPolicy = seams.signedIn ?? signedIn;
  const permit =
    seams.permit ??
    (async (projectId, user, resource, action) =>
      assertPermission(projectId, user, resource, action));

  // WHY before identity: a publication proven against the wrong graph must not reach even a session lookup's side effects.
  if (runtime.publication.manifestPath !== runtime.activeManifestPath) {
    return {
      ok: false,
      report: stop(
        'job',
        'JOB_MALFORMED',
        `the publication is configured against ${runtime.publication.manifestPath} but the host runs ${runtime.activeManifestPath}`,
      ),
    };
  }

  let resolved: SessionUser | null;
  try {
    resolved = await resolveUser(input.request);
  } catch (error) {
    // WHY caught: a token that fails verification throws, and an escaping throw skips the report the caller prints.
    return {
      ok: false,
      report: stop(
        'adapter',
        'ADAPTER_CLOSER_MISSING',
        `session resolution failed: ${describe(error)}`,
      ),
    };
  }
  if (resolved === null) {
    return {
      ok: false,
      report: stop(
        'adapter',
        'ADAPTER_CLOSER_MISSING',
        'no authenticated session, so no closer exists',
      ),
    };
  }

  let user: SessionUser;
  try {
    user = await applyPolicy(resolved);
  } catch (error) {
    return {
      ok: false,
      report: stop(
        'adapter',
        'ADAPTER_CLOSER_MISSING',
        `the session user is not usable as a closer: ${describe(error)}`,
      ),
    };
  }

  try {
    await permit(runtime.publication.projectId, user, 'work_items', 'edit');
  } catch (error) {
    return {
      ok: false,
      report: stop(
        'adapter',
        'ADAPTER_CLOSER_MISSING',
        `the session user may not update this project: ${describe(error)}`,
      ),
    };
  }

  const owners: AdapterOwners = {
    // The real imported factory unless a test seam replaced it; never a caller's substitute in production.
    nativeRecordStorage: runtime.nativeRecordStorageForTest ?? bindNativeRecordStorage,
    landingDbClient: runtime.dbClient,
    landingSlotDriver: runtime.slotDriver,
    landingProofRunner: runtime.proofRunner,
    // THE ONLY ASSIGNMENT. Everything above this line could refuse; nothing after it can change the identity.
    landingCloserUserId: user.id,
  };
  return { ok: true, owners };
}

/**
 * The runtime entry: refuse a mismatched publication, authenticate, authorise, compose the owners, build the job from host
 * configuration, then hand both to the shipped CLI.
 *
 * WHY loadAdapter is a bound function and not the job's adapterModule: a job that could name its own module could point the
 * executor at a second, forged owner object. The CLI still validates the five names; this guarantees they came from the
 * authenticated composition.
 */
export async function runLandingExecutor(input: LandingExecutorInput): Promise<LandReport> {
  const composed = await composeOwners(input);
  if (!composed.ok) return composed.report;

  const built = buildLandingJob(input.item, input.runtime.publication, input.runtime.actorName);
  if (!built.ok) return built.report;

  const owners = composed.owners;
  const seams = input.seams ?? {};
  const deps: LandDeps = {
    readFile: input.runtime.readFile,
    loadAdapter: async () => owners as unknown as Record<string, unknown>,
    runnerFor: execRunner,
    writeOut: input.runtime.writeOut,
    writeErr: input.runtime.writeErr,
  };
  const run =
    (input.mode ?? 'land') === 'record' ? (seams.record ?? recordJob) : (seams.land ?? landJob);
  return run(built.job, deps);
}
