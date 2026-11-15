// apps/api/src/modules/issues/landing-executor-caller.ts — sentinel-prod-8429 unit 6: the caller that binds the host.
// WHY it exists: landing-executor.ts composes owners from an authenticated request, but a composition with no caller is a
// library, not a runner. This module is where the process's own configuration becomes the runtime: it reads the manifest the
// SERVER is running with, opens the dedicated slot driver, takes the transaction client, and returns one function that a
// request handler or a CLI mount can call.
//
// WHY the manifest comes from TRACKER_GATE_ENV.manifest and not a setting of my own: that constant is the owner of the name
// (packages/db/src/tracker-gate.ts), the gate reads the same variable, so a second spelling here could point the publication
// at a manifest the gate is not running. The value is read ONCE, at construction; a request never reads or writes env, so one
// landing cannot steer the next.
//
// WHAT IS STILL MISSING, stated so nobody reads this as delivery: nothing calls this yet. There is no route registration and no
// CLI mount in this change, and a caller that is never wired is still not a feature - the remaining work is one call site in
// whichever surface owns the landing trigger.

import { readFileSync } from 'node:fs';

import { db } from '@repo/db';
import { createDedicatedSlotDriver } from '@repo/db/landing-slot-driver';
import { TRACKER_GATE_ENV } from '@repo/db/tracker-gate';
import type { AdapterOwners, LandReport } from '../../../../../scripts/itsaplan_land';
import {
  runLandingExecutor,
  type LandingExecutorRuntime,
  type LandingExecutorSeams,
  type LandingItemInput,
  type TrustedPublication,
} from './landing-executor';

export interface LandingExecutorCallerConfig {
  /** Host configuration for everything that widens a landing's blast radius. */
  publication: TrustedPublication;
  /** The host's own name, recorded on the landing. */
  actorName: string;
  /** Runs the named proofs. Required: a runner that reported outcomes without running them would be a fabricated pass. */
  proofRunner: AdapterOwners['landingProofRunner'];
  /** Read once at construction. Defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the process's own DATABASE_URL, which the slot driver needs for its dedicated session. */
  databaseUrl?: string;
  /** Defaults to the package's own client, whose transaction method is what the storage needs. */
  dbClient?: AdapterOwners['landingDbClient'];
  /** Injection seams: the dedicated driver, the file reader and the two output writers. */
  slotDriver?: AdapterOwners['landingSlotDriver'];
  readFile?: (path: string) => string;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Test seams, never used in production. */
  seams?: LandingExecutorSeams;
}

export interface LandingExecutorCaller {
  /** The one entry a surface calls. It never touches process.env. */
  run(request: Request, item: LandingItemInput, mode?: 'land' | 'record'): Promise<LandReport>;
  /** The manifest this caller was constructed against, so a host can report what it is bound to. */
  readonly activeManifestPath: string;
}

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/**
 * Reads the manifest the server runs with, using the owner's own constant.
 *
 * WHY a throw here and not a report: this is start-up configuration. A process that cannot say which manifest it runs should
 * fail where an operator sees it, not answer every landing with the same refusal.
 */
export function activeManifestPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const name = TRACKER_GATE_ENV.manifest;
  const value = (env[name] ?? '').trim();
  if (!value) {
    throw new Error(
      `${name} is not set: the landing publication must be bound to the manifest the server runs`,
    );
  }
  return value;
}

/**
 * Builds the caller once, from the host's configuration.
 *
 * WHY the publication is checked here as well as per call: here the mismatch is a start-up error an operator can fix; per
 * call it is a refusal that protects one landing. Both are wanted, and neither replaces the other.
 */
export function createLandingExecutorCaller(
  config: LandingExecutorCallerConfig,
): LandingExecutorCaller {
  const env = config.env ?? process.env;
  const activeManifestPath = activeManifestPathFromEnv(env);

  if (config.publication.manifestPath !== activeManifestPath) {
    throw new Error(
      `the publication is configured against ${config.publication.manifestPath} but the server runs ${activeManifestPath}`,
    );
  }

  const databaseUrl = config.databaseUrl ?? (env.DATABASE_URL ?? '').trim();
  const slotDriver =
    config.slotDriver ??
    ((): AdapterOwners['landingSlotDriver'] => {
      if (blank(databaseUrl)) {
        throw new Error(
          'DATABASE_URL is not set: the landing slot driver needs its own dedicated session',
        );
      }
      return createDedicatedSlotDriver({ url: databaseUrl });
    })();

  const runtime: LandingExecutorRuntime = {
    slotDriver,
    proofRunner: config.proofRunner,
    dbClient: config.dbClient ?? db,
    publication: config.publication,
    activeManifestPath,
    actorName: config.actorName,
    // WHY a real reader by default: the CLI loads the job and manifest from disk, and a reader that returned the path
    // instead of the bytes would turn every landing into a parse failure further in.
    readFile: config.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
    writeOut: config.writeOut ?? (() => undefined),
    writeErr: config.writeErr ?? (() => undefined),
  };

  return {
    activeManifestPath,
    // WHY no env read inside: everything above is fixed at construction, so two requests cannot differ by environment.
    run: (request, item, mode) =>
      runLandingExecutor({ request, item, runtime, mode, seams: config.seams }),
  };
}
