import { db, teamWorkspaceId, workspace, type DbExecutor } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { ProjectFeature } from './features';

// Ceilings on what one workspace may use across its teams, and the sections they may
// not use at all. A self-hosted instance has none: every number is 0, which reads as
// unlimited, and the checks that enforce them return before they count anything. The
// values come from a provider so a hosted build can install its own — reading the
// workspace's subscription instead of answering with the defaults — without touching
// the places that enforce them.

export interface Limits {
  maxTeams: number;
  // Distinct people across the workspace's teams. An agent's bot user takes no seat.
  maxSeats: number;
  // Runs of the workspace's internal agents in flight at once. Its owner may set a lower
  // one of their own (getRunLimit).
  maxConcurrentRuns: number;
  // Wall time one run gets before it is aborted.
  maxRunSeconds: number;
  // How close together an agent schedule may fire.
  minScheduleIntervalSeconds: number;
  // Stored attachment bytes across the workspace's projects.
  maxStorageBytes: number;
  // Project sections the workspace cannot use. A blocked one reads as off however its
  // project has it stored, and cannot be turned back on.
  blockedFeatures: ProjectFeature[];
}

// What a self-hosted instance answers with, and the base a test or a hosted provider
// overrides fields on.
export const NO_LIMITS: Limits = {
  maxTeams: 0,
  maxSeats: 0,
  maxConcurrentRuns: 0,
  maxRunSeconds: 0,
  minScheduleIntervalSeconds: 0,
  maxStorageBytes: 0,
  blockedFeatures: [],
};

// WHY the provider may take the caller's executor: a hosted build answers from the workspace's
// subscription, and a caller inside a transaction must see the row it just wrote there rather than
// the pool's older view. The second argument is optional, so the one-argument providers already
// installed - including the test helper - stay assignable and unchanged.
type LimitsProvider = (workspaceId: number, executor?: DbExecutor) => Promise<Limits>;

let provider: LimitsProvider = async () => NO_LIMITS;

export function setLimitsProvider(next: LimitsProvider): void {
  provider = next;
}

export function getLimits(workspaceId: number, executor: DbExecutor = db): Promise<Limits> {
  return provider(workspaceId, executor);
}

export async function getTeamLimits(teamId: number, executor: DbExecutor = db): Promise<Limits> {
  return provider(await teamWorkspaceId(teamId, executor), executor);
}

// The lowest of the limits, leaving out the 0s, which set none; 0 when all of them are.
export function tightestLimit(...limits: number[]): number {
  const set = limits.filter((limit) => limit > 0);
  return set.length > 0 ? Math.min(...set) : 0;
}

// Runs of the workspace's internal agents in flight at once: the limit its owner set, or
// the provider's where that is lower.
export async function getRunLimit(
  workspaceId: number,
  limits: Limits,
  executor: DbExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({ own: workspace.maxConcurrentRuns })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return tightestLimit(row?.own ?? 0, limits.maxConcurrentRuns);
}

// How many workspaces one person may own. A self-hosted instance gives each person one;
// a hosted build raises it. 0 reads as unlimited, as in Limits.
let ownedWorkspaceLimit = 1;

export function setOwnedWorkspaceLimit(next = 1): void {
  ownedWorkspaceLimit = next;
}

export function getOwnedWorkspaceLimit(): number {
  return ownedWorkspaceLimit;
}
