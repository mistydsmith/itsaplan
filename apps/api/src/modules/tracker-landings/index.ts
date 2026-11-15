// apps/api/src/modules/tracker-landings/index.ts — sentinel-prod-8429 atom F: the landing route and its privileged config.
// WHY one file for config and route: they are one deliverable with one owner, and a separate config module invited exactly the
// drift of two spellings for one variable.
//
// WHY the configuration is host data and not request data: everything that widens a landing's blast radius - checkout, target
// ref, remote, expected push URL, excluded paths, project and column, close repo key, manifest - plus the argv of every named
// proof, is read ONCE from ITSAPLAN_LANDING_CONFIG at module load. A request may carry item evidence and a mode, and nothing else.
//
// WHY unset is not an error but invalid is: a deployment that does not run landings must start normally, so an unset variable
// registers no route. A variable that IS set and unparseable is a broken deployment, and it fails loudly at import where an
// operator sees it, rather than silently disabling a feature somebody believes is running.
//
// WHY the session stays with the existing owner: authContext resolves it for every route the planner mounts, and the project
// authority is the executor's own assertPermission. This file adds no identity rule; it routes.

import { Elysia } from 'elysia';

import { authContext } from '#shared/auth-context';
import { HttpError } from '#shared/lib';
import { commonErrors } from '#shared/responses';
import { createLandingExecutorCaller } from '../issues/landing-executor-caller';
import { createLandingProofRunner } from '../issues/landing-proof-runner';
import type { LandingItemInput, TrustedPublication } from '../issues/landing-executor';
import type { LandReport } from '../../../../../scripts/itsaplan_land';
import {
  LandingParams,
  LandingRequestBody,
  LandingResponse,
  type LandingRequestBodyType,
} from './model';

export const LANDING_CONFIG_VAR = 'ITSAPLAN_LANDING_CONFIG';

/** One repository a landing may close against, as the host configured it. */
export interface LandingRepoConfig {
  publication: TrustedPublication;
  /** The host's own name, recorded on the landing. */
  actorName: string;
  /** Exact named test -> argv. Never a shell string; the proof runner refuses one. */
  proofs: Readonly<Record<string, readonly string[]>>;
  /** Optional per-repo override of the process DATABASE_URL for the dedicated slot session. */
  databaseUrl?: string;
}

export interface LandingHostConfig {
  repos: Readonly<Record<string, LandingRepoConfig>>;
}

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (blank(value)) throw new Error(`${where}: ${field} must be a non-empty string`);
  return (value as string).trim();
}

function requireInteger(source: Record<string, unknown>, field: string, where: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new Error(`${where}: ${field} must be a positive integer`);
  return value;
}

/** WHY absolute: a relative checkout resolves differently per process, and a landing must name one tree. */
function requireAbsolutePath(
  source: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = requireString(source, field, where);
  if (!value.startsWith('/')) throw new Error(`${where}: ${field} must be an absolute path`);
  return value;
}

function requireStringArray(
  source: Record<string, unknown>,
  field: string,
  where: string,
): string[] {
  const value = source[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${where}: ${field} must be an array of strings`);
  return value as string[];
}

function readPublication(raw: Record<string, unknown>, where: string): TrustedPublication {
  const publication = asObject(raw.publication);
  if (!publication) throw new Error(`${where}: publication must be an object`);
  const targetRef = requireString(publication, 'targetRef', `${where}.publication`);
  // WHY: the CLI refuses a short ref rather than resolving it, so a short name here would only fail later, mid-landing.
  if (!targetRef.startsWith('refs/'))
    throw new Error(`${where}.publication: targetRef must be a full ref such as refs/heads/main`);
  const columnId = publication.columnId;
  if (columnId !== null && columnId !== undefined && typeof columnId !== 'number')
    throw new Error(`${where}.publication: columnId must be an integer or null`);
  return {
    repo: requireAbsolutePath(publication, 'repo', `${where}.publication`),
    targetRef,
    excludedPathPatterns: requireStringArray(
      publication,
      'excludedPathPatterns',
      `${where}.publication`,
    ),
    repoIdentity: requireString(publication, 'repoIdentity', `${where}.publication`),
    remote: requireString(publication, 'remote', `${where}.publication`),
    expectedPushURL: requireString(publication, 'expectedPushURL', `${where}.publication`),
    projectId: requireInteger(publication, 'projectId', `${where}.publication`),
    columnId: typeof columnId === 'number' ? columnId : null,
    completedColumnId: requireInteger(publication, 'completedColumnId', `${where}.publication`),
    closeRepoKey: requireString(publication, 'closeRepoKey', `${where}.publication`),
    manifestPath: requireAbsolutePath(publication, 'manifestPath', `${where}.publication`),
  };
}

function readProofs(
  raw: Record<string, unknown>,
  where: string,
): Record<string, readonly string[]> {
  const proofs = asObject(raw.proofs);
  if (!proofs || Object.keys(proofs).length === 0)
    throw new Error(`${where}: proofs must map at least one named test to an argv array`);
  const out: Record<string, readonly string[]> = {};
  for (const [name, argv] of Object.entries(proofs)) {
    if (blank(name)) throw new Error(`${where}: a proof name must be a non-empty string`);
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => blank(part)))
      throw new Error(`${where}: proofs.${name} must be a non-empty array of non-empty strings`);
    out[name] = (argv as unknown[]).map((part) => String(part));
  }
  return out;
}

function readRepo(raw: unknown, repoKey: string): LandingRepoConfig {
  const where = `repos.${repoKey}`;
  const entry = asObject(raw);
  if (!entry) throw new Error(`${where}: must be an object`);
  const databaseUrl = entry.databaseUrl;
  if (databaseUrl !== undefined && blank(databaseUrl))
    throw new Error(`${where}: databaseUrl must be a non-empty string when present`);
  return {
    publication: readPublication(entry, where),
    actorName: requireString(entry, 'actorName', where),
    proofs: readProofs(entry, where),
    ...(typeof databaseUrl === 'string' ? { databaseUrl: databaseUrl.trim() } : {}),
  };
}

const REPO_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Loads the privileged configuration.
 *
 * WHY it throws on a set-but-unusable value and returns null only when unset: those are different deployments. Unset means "this
 * host does not land", which must not stop the app. Set-and-broken means somebody configured landings wrongly, and a silent
 * absence would let them believe a route exists while nothing does.
 */
export function loadLandingConfig(env: NodeJS.ProcessEnv = process.env): LandingHostConfig | null {
  const raw = env[LANDING_CONFIG_VAR];
  if (raw === undefined || raw.trim() === '') return null;

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${LANDING_CONFIG_VAR} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const object = asObject(root);
  if (!object) throw new Error(`${LANDING_CONFIG_VAR} must be a JSON object`);
  const repos = asObject(object.repos);
  if (!repos) throw new Error(`${LANDING_CONFIG_VAR} must carry a repos object`);

  const accepted: Record<string, LandingRepoConfig> = {};
  const refused: string[] = [];
  for (const [repoKey, value] of Object.entries(repos)) {
    if (!REPO_KEY_PATTERN.test(repoKey)) {
      refused.push(`${repoKey}: a repo key must be lowercase letters, digits and dashes`);
      continue;
    }
    try {
      accepted[repoKey] = readRepo(value, repoKey);
    } catch (error) {
      refused.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (refused.length > 0)
    throw new Error(`${LANDING_CONFIG_VAR} has invalid entries: ${refused.join('; ')}`);
  if (Object.keys(accepted).length === 0)
    throw new Error(`${LANDING_CONFIG_VAR} configured no repositories`);
  return { repos: accepted };
}

const asArray = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  return value;
};

/**
 * Builds the item from the path and the body, copying each allowed field BY NAME.
 *
 * WHY not a spread of the body: an excess property (repo, targetRef, remote, manifest, closer, proofs) would ride straight into
 * the executor's input. Named copies make "no caller-supplied host fields" a property of the code, not a convention, and the
 * extra properties are DROPPED rather than rejected so a client that sends a whole job cannot widen a landing.
 */
export function itemFromRequest(
  params: { itemKey: string },
  body: LandingRequestBodyType,
): { item: LandingItemInput; mode: 'land' | 'record' } {
  // WHY the mode check survives the schema: this function is also called with a hand-built object, and a caller outside Elysia
  // must not be able to smuggle a third mode past it.
  const mode = body.mode ?? 'land';
  if (mode !== 'land' && mode !== 'record')
    throw new HttpError(400, "mode must be 'land' or 'record'");
  return {
    item: {
      itemKey: params.itemKey,
      receipts: asArray(body.receipts ?? [], 'receipts'),
      verdicts: asArray(body.verdicts ?? [], 'verdicts'),
      columns: asArray(body.columns ?? [], 'columns') as LandingItemInput['columns'],
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.archived === undefined ? {} : { archived: body.archived }),
    },
    mode,
  };
}

type LandingCaller = Pick<ReturnType<typeof createLandingExecutorCaller>, 'run'>;

/** The context this route needs. Named so the handler below is testable without HTTP or a session. */
export interface LandingRouteContext {
  params: { repoKey: string; itemKey: string };
  body: LandingRequestBodyType | null | undefined;
  request: Request;
  user?: { id: string } | null;
  set: { status?: number | string };
}

/**
 * The handler body, extracted so its behaviour is provable without a database-backed session.
 *
 * WHY the Request is passed through rather than rebuilt: the executor's auth and permission owners read the same request, so a
 * copy would be a second authentication path.
 */
export async function landConfigured(
  repos: Readonly<Record<string, LandingRepoConfig>>,
  callerFor: (repoKey: string) => LandingCaller,
  ctx: LandingRouteContext,
): Promise<{ report: LandReport }> {
  if (!ctx.user) throw new HttpError(401, 'Sign in to land a work item');
  const repo = repos[ctx.params.repoKey];
  // WHY 404 and not 403: a key the host did not configure is not a permission this session lacks.
  if (repo === undefined)
    throw new HttpError(404, `No landing is configured for repository '${ctx.params.repoKey}'`);

  const { item, mode } = itemFromRequest(ctx.params, ctx.body ?? {});
  const report: LandReport = await callerFor(ctx.params.repoKey).run(ctx.request, item, mode);
  // WHY 409 for a refusal: a 200 with ok:false would read as a landed item, and a 5xx would read as a server fault when the
  // landing simply refused. The executor's own report is returned unchanged either way.
  ctx.set.status = report.ok ? 200 : 409;
  return { report };
}

export interface TrackerLandingRoutesDeps {
  /** Builds the caller for one repository, so a test needs no database, no git and no child process. */
  callerFor(repoKey: string, repo: LandingRepoConfig): LandingCaller;
}

/** The production caller: real proof runner from the host's argv map, real executor per repository. */
function productionCallerFor(repo: LandingRepoConfig): LandingCaller {
  return createLandingExecutorCaller({
    publication: repo.publication,
    actorName: repo.actorName,
    proofRunner: createLandingProofRunner({ repo: repo.publication.repo, argvByTest: repo.proofs }),
    ...(repo.databaseUrl === undefined ? {} : { databaseUrl: repo.databaseUrl }),
  });
}

/**
 * Builds the plugin. WHY a factory: the loaded configuration is a value, so a test can build the plugin for a well-formed or an
 * absent configuration without touching process.env.
 */
export function createTrackerLandingRoutes(
  config: LandingHostConfig | null,
  deps: Partial<TrackerLandingRoutesDeps> = {},
) {
  if (config === null) {
    // No configuration, no routes. The plugin still exists so the planner's chain is unchanged.
    return new Elysia({ name: 'tracker-landings' });
  }

  const repos = config.repos;
  // WHY every caller is built HERE, at plugin construction: a first request must not decide which manifest, checkout or database
  // a landing runs against. Constructing opens nothing - the slot driver connects only when asked for a session, and the
  // database client connects on first query - so this is start-up work, not I/O.
  const callers = new Map<string, LandingCaller>();
  for (const [repoKey, repo] of Object.entries(repos)) {
    callers.set(
      repoKey,
      deps.callerFor ? deps.callerFor(repoKey, repo) : productionCallerFor(repo),
    );
  }
  const callerFor = (repoKey: string): LandingCaller => {
    const found = callers.get(repoKey);
    if (found === undefined)
      throw new HttpError(404, `No landing is configured for repository '${repoKey}'`);
    return found;
  };

  return (
    new Elysia({ name: 'tracker-landings', detail: { tags: ['Issues'] } })
      // WHY authContext and no guards macro: the session is the existing owner's job, and the project authority is the executor's
      // own assertPermission. A guards macro here would answer 401 for a landing the executor is meant to refuse on its terms.
      .use(authContext)
      .post(
        '/tracker/landings/:repoKey/:itemKey',
        (ctx) => landConfigured(repos, callerFor, ctx as unknown as LandingRouteContext),
        {
          params: LandingParams,
          body: LandingRequestBody,
          response: { ...commonErrors, 200: LandingResponse, 409: LandingResponse },
          detail: {
            summary: 'Land one work item against a configured repository',
            description:
              'Runs the named proofs from host configuration, publishes the candidate and records the landing. The request ' +
              'carries only item evidence and mode; repository, ref, remote, manifest and closer come from the host.',
          },
        },
      )
  );
}

/** The plugin the planner mounts. An unset configuration registers no route; an invalid one fails at import, visibly. */
export const trackerLandingRoutes = createTrackerLandingRoutes(loadLandingConfig());
