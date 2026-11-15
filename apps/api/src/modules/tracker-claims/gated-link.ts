import { sql } from 'drizzle-orm';
import type { ClaimTransaction } from '@repo/db/issue-claim';
import { claimFactsOf } from '#modules/issues/close-facts';
import { routingFactsForText } from '#modules/issues/lane-routing';
import { skillFactsFor } from '#modules/issues/skill-facts';
import { getProjectAccess } from '#shared/access';
import { HttpError } from '#shared/lib';
import { hasPermission } from '#shared/permissions';
import {
  gate,
  linkOp,
  linkRole,
  routingCheckOp,
  storedBeadIdentity,
  storedLabels,
  type GatedCard,
  type LinkClaimFacts,
} from './gated-claim';
import { actorRole } from './readiness-facts';

// A link or unlink between two issues of a project with a rig. WHY the rule owner is asked
// (Root 2026-11-15 msg_02b6cfab0fc1, B8): a 'blocks' link decides which card is ready, so a
// worker may change one only between two cards it holds live. The owner is asked three times on
// the writer's transaction, before the row is written:
//   1. a state op for the issue the request names, with the routing facts of the acting user;
//   2. the same for the issue on the other end;
//   3. the link or unlink op with the link facts and, for a worker, the claim rows of both ends.
// A refusal, or an identity the stored rows do not prove, rolls the write back.

type Row = Record<string, string | number | null>;
const rows = async (tx: ClaimTransaction, query: ReturnType<typeof sql>) =>
  (await tx.execute(query)) as unknown as Row[];

const CROSS_PROJECT = 'Both issues must belong to the same project';

// The claim epochs a worker read for the issue the request names and for the issue on the other
// end. An absent one reaches the owner as null.
export interface LinkEpochs {
  expectedEpoch?: number;
  targetExpectedEpoch?: number;
}

export interface GatedLinkInput extends LinkEpochs {
  op: 'link' | 'unlink';
  // The issue the request names, and the issue on the other end of the relation.
  issueId: number;
  otherIssueId: number;
  userId: string | null | undefined;
}

// Returns when the write may go on: both projects have no rig, or the owner allowed it.
export async function gateLinkChange(tx: ClaimTransaction, input: GatedLinkInput): Promise<void> {
  const { issueId, otherIssueId } = input;
  const found = await rows(
    tx,
    sql`SELECT id, project_id FROM issue WHERE id IN (${issueId}, ${otherIssueId})`,
  );
  const projectOf = (id: number) => found.find((row) => Number(row.id) === id)?.project_id;
  if (projectOf(issueId) == null) throw new HttpError(404, 'Issue not found');
  if (projectOf(otherIssueId) == null) throw new HttpError(404, 'Linked issue not found');
  const sourceProject = Number(projectOf(issueId));
  const targetProject = Number(projectOf(otherIssueId));
  // WHY the project rows are read FOR SHARE before the issues are locked: a rig set between an
  // unlocked read and the write would let the write through unjudged. Project before issue is
  // the order the gated update and the gated claim take their locks in.
  const held = await rows(
    tx,
    sql`SELECT id, rig_id FROM project
        WHERE id IN (${sourceProject}, ${targetProject}) ORDER BY id FOR SHARE`,
  );
  if (held.every((row) => row.rig_id === null)) return;
  // WHY only a link refuses two projects (Root msg_740baa8333ca): a relation is made inside one
  // project, but one that outlived a move of an issue must stay removable. Each end is then
  // judged in its own project and rig.
  if (held.length !== 1 && input.op === 'link') throw new HttpError(400, CROSS_PROJECT);
  const rigOf = (projectId: number) => {
    const rigId = held.find((row) => Number(row.id) === projectId)?.rig_id;
    return rigId == null ? null : Number(rigId);
  };
  const userId = input.userId;
  if (userId == null || userId.length === 0) {
    throw new HttpError(
      409,
      'A link in a project with a rig needs an authenticated user',
      'link-without-principal',
    );
  }

  // Both rows are locked in id order, so two writers of the same pair cannot deadlock.
  const locked = await rows(
    tx,
    sql`SELECT i.id, i.project_id, i.title, i.description, i.bead_id, i.claim_owner,
               i.claim_epoch,
               floor(extract(epoch FROM i.claim_expires_at) * 1000)::bigint AS expires_ms,
               c.state_type
        FROM issue i JOIN project_column c ON c.id = i.column_id
        WHERE i.id IN (${issueId}, ${otherIssueId}) ORDER BY i.id FOR UPDATE OF i`,
  );
  const lockedRow = (id: number, projectId: number) => {
    const row = locked.find((candidate) => Number(candidate.id) === id);
    if (!row) throw new HttpError(404, 'Issue not found');
    if (Number(row.project_id) !== projectId) {
      throw new HttpError(409, 'An issue moved projects while it was being linked; try again');
    }
    return row;
  };
  const sourceRow = lockedRow(issueId, sourceProject);
  const targetRow = lockedRow(otherIssueId, targetProject);

  // The role and the work item edit permission of the user in one project. WHY the permission
  // is read here and not taken from the caller: the owner allows a link only on an
  // authorization the server proved, and this function is the one place that states it.
  const standingIn = async (projectId: number) => {
    const [actor] = await rows(
      tx,
      sql`SELECT u.role AS user_role,
                 (SELECT m.role FROM project_member m
                  WHERE m.project_id = ${projectId} AND m.user_id = u.id) AS member_role
          FROM "user" u WHERE u.id = ${userId}`,
    );
    if (!actor) {
      throw new HttpError(409, 'A link needs an authenticated user', 'link-without-principal');
    }
    const access = await getProjectAccess(projectId, userId);
    return {
      role: actorRole(
        actor.user_role === null ? null : String(actor.user_role),
        actor.member_role === null ? null : String(actor.member_role),
      ),
      authorized:
        access !== null &&
        (access.role === 'owner' || hasPermission(access.permissions, 'work_items', 'edit')),
    };
  };
  const standings = [await standingIn(sourceProject)];
  if (targetProject !== sourceProject) standings.push(await standingIn(targetProject));
  const role = linkRole(standings.map((standing) => standing.role));
  const authorized = standings.every((standing) => standing.authorized);

  const skills = await skillFactsFor(tx, userId);
  const cardOf = async (id: number, row: Row, projectId: number) => {
    const rigId = rigOf(projectId);
    if (rigId === null) {
      throw new HttpError(
        409,
        'This issue is in a project with no rig, so its link cannot be judged',
        'issue-without-identity',
      );
    }
    const { rigPrefix, beadId } = await storedBeadIdentity(tx, {
      issueId: id,
      rigId,
      columnBeadId: row.bead_id === null ? null : String(row.bead_id),
      what: 'link',
    });
    const card: GatedCard = {
      beadId,
      rigPrefix,
      title: String(row.title),
      description: String(row.description ?? ''),
      labels: await storedLabels(tx, id),
      columnState: String(row.state_type),
    };
    const routed = await routingFactsForText(tx, {
      projectId,
      beadId,
      labels: card.labels,
      texts: [card.title, card.description],
      userIds: [userId],
      // WHY 8429 (Misty 2026-11-15): the same door on the link side, judged on the person this server authenticated.
      actorUserId: userId,
    });
    const facts = { routing_facts: routed.facts, ...skills };
    await gate(rigId, routingCheckOp(card, facts));
    return { card, facts, rigId };
  };
  const source = await cardOf(issueId, sourceRow, sourceProject);
  const target = await cardOf(otherIssueId, targetRow, targetProject);

  // The clock is read after the row locks, as close-facts.ts and the lease primitive read it.
  const [clock] = await rows(
    tx,
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  );
  const claimOf = (row: Row, expectedEpoch: number | undefined): LinkClaimFacts => ({
    ...claimFactsOf(
      {
        owner: row.claim_owner === null ? null : String(row.claim_owner),
        epoch: Number(row.claim_epoch),
        expiresAtMs: row.expires_ms === null ? null : Number(row.expires_ms),
        nowMs: Number(clock.now_ms),
      },
      { actor: userId, expectedEpoch: 0 },
    ),
    expected_epoch: expectedEpoch ?? null,
  });
  await gate(
    source.rigId,
    linkOp({
      op: input.op,
      source: source.card,
      target: target.card,
      facts: source.facts,
      role,
      authorized,
      claims: {
        source: claimOf(sourceRow, input.expectedEpoch),
        target: claimOf(targetRow, input.targetExpectedEpoch),
      },
    }),
  );
}

// The same for the removal of one stored relation of issueId. It returns false for a link id
// that is not a relation of that issue. WHY the writer must then delete nothing: a relation
// stored after this read was never judged.
export async function gateUnlink(
  tx: ClaimTransaction,
  input: Omit<GatedLinkInput, 'op' | 'otherIssueId'> & { linkId: number },
): Promise<boolean> {
  const { issueId, linkId, ...rest } = input;
  const [link] = await rows(
    tx,
    sql`SELECT source_issue_id, target_issue_id FROM issue_link
        WHERE id = ${linkId} AND (source_issue_id = ${issueId} OR target_issue_id = ${issueId})`,
  );
  if (!link) return false;
  const source = Number(link.source_issue_id);
  const otherIssueId = source === issueId ? Number(link.target_issue_id) : source;
  await gateLinkChange(tx, { ...rest, op: 'unlink', issueId, otherIssueId });
  return true;
}
