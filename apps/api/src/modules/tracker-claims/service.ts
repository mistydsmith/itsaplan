import { db, issue } from '@repo/db';
import {
  claimIssue,
  heartbeatClaim,
  releaseClaim,
  type ClaimRefusal,
  type ClaimResult,
  type ClaimState,
  type ClaimTransaction,
} from '@repo/db/issue-claim';
import { eq, sql } from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import { claimGatedIssue } from './gated-claim';

// The HTTP side of the issue claim. WHY userId is the only owner these functions take (Root
// 2026-11-15): claim_owner is readable by anyone who can read the card, so a caller that could
// name the owner could name the stored one. The owner is the authenticated user id, the same
// identity the gated close compares the claim with. The lease length and the clock belong to
// @repo/db/issue-claim; nothing here sets either.

export interface ClaimDto {
  owner: string | null;
  epoch: number;
  expiresAt: string | null;
  expired: boolean;
  mine: boolean;
  unchanged?: boolean;
}

export function claimDto(state: ClaimState, expired: boolean, userId: string): ClaimDto {
  return {
    owner: state.owner,
    epoch: state.epoch,
    expiresAt: state.expiresAt === null ? null : iso(state.expiresAt),
    expired,
    mine: state.owner === userId,
  };
}

// A refusal as the error the route answers with. The 409 code is the one the gated close gives
// for a refused release.
export function claimRefusalError(refusal: ClaimRefusal): HttpError {
  if (refusal.code === 'invalid-argument') return new HttpError(400, refusal.message);
  if (refusal.code === 'missing-row') return new HttpError(404, 'Issue not found');
  return new HttpError(409, refusal.message, `claim-${refusal.code}`);
}

// A deadline equal to the clock has passed, as in the primitives and the close facts.
export function claimExpired(state: ClaimState, nowMs: number): boolean {
  return state.expiresAt !== null && state.expiresAt.getTime() <= nowMs;
}

type Primitive = (
  tx: ClaimTransaction,
  input: { issueId: unknown; actor: unknown; expectedEpoch: unknown },
) => Promise<ClaimResult>;

async function write(primitive: Primitive, issueId: number, userId: string, expectedEpoch: number) {
  const result = await db.transaction((tx) =>
    primitive(tx, { issueId, actor: userId, expectedEpoch }),
  );
  if (!result.ok) throw claimRefusalError(result);
  // A claim or heartbeat that succeeded is live; a release leaves no deadline.
  return { ...claimDto(result.claim, false, userId), unchanged: result.unchanged };
}

// WHY the project row is read FOR SHARE before the issue is locked: a project with a rig is
// judged by the rule owner, and a rig set between an unlocked read and the claim would let the
// claim through on the lease alone. The share lock holds the rig until commit, and project
// before issue is the order the gated update takes its locks in.
async function claimInProject(tx: ClaimTransaction, input: Parameters<Primitive>[1]) {
  const issueId = Number(input.issueId);
  const userId = String(input.actor);
  const [card] = await tx
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.id, issueId));
  if (!card) throw new HttpError(404, 'Issue not found');
  const [held] = (await tx.execute(
    sql`SELECT rig_id FROM project WHERE id = ${card.projectId} FOR SHARE`,
  )) as unknown as { rig_id: number | string | null }[];
  if (!held) throw new HttpError(404, 'Issue not found');
  if (held.rig_id === null) return claimIssue(tx, input);
  const [locked] = (await tx.execute(
    sql`SELECT project_id FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as { project_id: number | string }[];
  if (!locked) throw new HttpError(404, 'Issue not found');
  if (Number(locked.project_id) !== card.projectId) {
    throw new HttpError(409, 'This issue moved projects while it was being claimed; try again');
  }
  return claimGatedIssue(tx, {
    issueId,
    rigId: Number(held.rig_id),
    userId,
    expectedEpoch: Number(input.expectedEpoch),
  });
}

export const takeClaim = (issueId: number, userId: string, expectedEpoch: number) =>
  write(claimInProject, issueId, userId, expectedEpoch);
export const extendClaim = (issueId: number, userId: string, expectedEpoch: number) =>
  write(heartbeatClaim, issueId, userId, expectedEpoch);
export const dropClaim = (issueId: number, userId: string, expectedEpoch: number) =>
  write(releaseClaim, issueId, userId, expectedEpoch);

// The issue that carries a bead id. WHY an exact match on issue.bead_id and nothing else: the
// column is unique where it is set, so one id names at most one issue. A title, a sequence
// number or a prefix would let one caller-supplied string name a different issue.
export async function readBeadIssue(
  beadId: string,
): Promise<{ id: number; beadId: string; projectId: number } | null> {
  const [row] = await db
    .select({ id: issue.id, beadId: issue.beadId, projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.beadId, beadId));
  return row?.beadId == null ? null : { ...row, beadId: row.beadId };
}

export async function readClaim(issueId: number, userId: string): Promise<ClaimDto> {
  const [row] = await db
    .select({ owner: issue.claimOwner, epoch: issue.claimEpoch, expiresAt: issue.claimExpiresAt })
    .from(issue)
    .where(eq(issue.id, issueId));
  if (!row) throw new HttpError(404, 'Issue not found');
  // The database clock, read after the row, as the primitives read it.
  const [clock] = (await db.execute(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  )) as unknown as { now_ms: number | string }[];
  return claimDto(row, claimExpired(row, Number(clock.now_ms)), userId);
}
