import { sql } from 'drizzle-orm';
import { claimIssue, type ClaimResult, type ClaimTransaction } from '@repo/db/issue-claim';
import { gateIssueWrite, isTrackerGateRefusal } from '@repo/db/tracker-gate';
import { claimFactsOf } from '#modules/issues/close-facts';
import { routingFactsForText } from '#modules/issues/lane-routing';
import { skillFactsFor } from '#modules/issues/skill-facts';
import { HttpError } from '#shared/lib';
import { buildReadinessFacts, type ReadinessFacts, type ReadinessRole } from './readiness-facts';

// The claim of an issue in a project with a rig. WHY it is more than the lease (Root 2026-11-15,
// 8429_READY_NATIVE_FACT_RULINGS_R1): the lease says only that nobody else holds the card. Whether
// the card is work this user may take is the rule owner's decision, on facts read from the rows
// this transaction holds. The owner is asked twice, in this order:
//   1. a state op with the routing facts of the requesting user, which is the routing decision;
//   2. a claim op with the claim facts and the readiness facts, where eligibility is true only
//      because call 1 returned.
// The lease primitive runs after both, on the same transaction. A refusal by either call, or a
// fact no stored row proves, rolls the transaction back and nothing is claimed.

export interface GatedCard {
  beadId: string;
  rigPrefix: string;
  title: string;
  description: string;
  labels: string[];
  columnState: string;
}

// The op the routing decision is judged on. It carries no proposed_state: the owner's identity
// rule accepts a whole state only for the writes it names, and a claim changes no card text.
export function routingCheckOp(card: GatedCard, facts: Record<string, unknown>) {
  return {
    op: 'state',
    id: card.beadId,
    rig_prefix: card.rigPrefix,
    labels: card.labels,
    previous_state: {
      title: card.title,
      description: card.description,
      labels: card.labels,
      bead_id: card.beadId,
      column_state: card.columnState,
    },
    ...facts,
  };
}

export function claimOp(
  card: GatedCard,
  facts: Record<string, unknown>,
  claim: ReturnType<typeof claimFactsOf>,
  readiness: ReadinessFacts,
) {
  return {
    ...routingCheckOp(card, facts),
    op: 'claim',
    claim_facts: claim,
    readiness_facts: readiness,
  };
}

export type LinkClaimFacts = Omit<ReturnType<typeof claimFactsOf>, 'expected_epoch'> & {
  expected_epoch: number | null;
};

export interface LinkOpInput {
  op: 'link' | 'unlink';
  source: GatedCard;
  target: GatedCard;
  // The routing and skill facts of the acting user on the source card.
  facts: Record<string, unknown>;
  role: ReadinessRole;
  authorized: boolean;
  claims: { source: LinkClaimFacts; target: LinkClaimFacts };
}

// The one role of a user across the projects of the two ends. WHY the lowest (Root
// msg_740baa8333ca): a coordinator or operator links without a claim, so that standing must
// hold in every project the relation touches.
export function linkRole(roles: ReadinessRole[]): ReadinessRole {
  const [first] = roles;
  return roles.every((role) => role === first) ? first : 'worker';
}

// The op the owner's link rule judges. WHY the claim rows go only with a worker: the owner
// allows a coordinator or operator to link unclaimed backlog and reads no claim for them.
export function linkOp(input: LinkOpInput) {
  const { source, target, role } = input;
  return {
    ...routingCheckOp(source, input.facts),
    op: input.op,
    link_target_id: target.beadId,
    link_facts: {
      id: source.beadId,
      target_id: target.beadId,
      actor_role: role,
      authorized: input.authorized,
    },
    ...(role === 'worker'
      ? { claim_facts: input.claims.source, target_claim_facts: input.claims.target }
      : {}),
  };
}

type Row = Record<string, string | number | null>;
const rows = async (tx: ClaimTransaction, query: ReturnType<typeof sql>) =>
  (await tx.execute(query)) as unknown as Row[];

function unproven(reason: string): HttpError {
  // The message names the missing fact and no card text.
  return new HttpError(
    409,
    `This issue cannot be claimed: ${reason} is not proven by its stored data`,
    `claim-unproven-${reason}`,
  );
}

export async function gate(rigId: number, op: Record<string, unknown>): Promise<void> {
  try {
    await gateIssueWrite({ rigId, op });
  } catch (error) {
    if (!isTrackerGateRefusal(error)) throw error;
    const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
    throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
  }
}

// The bead id of an issue in its rig, read from the ledger and compared with the issue column.
// WHY both must agree: both name the card, and a write judged on one while the lookup route
// answered from the other would be judged on a different card. what names the judged write in
// the refusal.
export async function storedBeadIdentity(
  tx: ClaimTransaction,
  input: { issueId: number; rigId: number; columnBeadId: string | null; what: string },
): Promise<{ rigPrefix: string; beadId: string }> {
  const identities = await rows(
    tx,
    sql`SELECT r.prefix, b.local_token FROM bead_identity b
        JOIN rig r ON r.id = b.rig_id
        WHERE b.issue_id = ${input.issueId} AND b.rig_id = ${input.rigId}`,
  );
  if (identities.length !== 1) {
    throw new HttpError(
      409,
      `This issue holds no bead identity in its rig, so its ${input.what} cannot be judged`,
      'issue-without-identity',
    );
  }
  const rigPrefix = String(identities[0].prefix);
  const beadId = `${rigPrefix}-${String(identities[0].local_token)}`;
  if (input.columnBeadId !== beadId) {
    throw new HttpError(
      409,
      `This issue carries two different bead ids, so its ${input.what} cannot be judged`,
      'issue-identity-mismatch',
    );
  }
  return { rigPrefix, beadId };
}

export async function storedLabels(tx: ClaimTransaction, issueId: number): Promise<string[]> {
  const found = await rows(
    tx,
    sql`SELECT l.name FROM issue_label il JOIN label l ON l.id = il.label_id
        WHERE il.issue_id = ${issueId} ORDER BY l.name`,
  );
  return found.map((row) => String(row.name));
}

export interface GatedClaimInput {
  issueId: number;
  rigId: number;
  userId: string;
  // The caller's epoch, or 'locked' for a card the server chose itself: the epoch is then the
  // one this transaction read from the row.
  expectedEpoch: number | 'locked';
}

export async function claimGatedIssue(
  tx: ClaimTransaction,
  input: GatedClaimInput,
): Promise<ClaimResult> {
  const judged = await judgeGatedClaim(tx, input, true);
  return claimIssue(tx, {
    issueId: input.issueId,
    actor: input.userId,
    expectedEpoch: judged.expectedEpoch,
  });
}

// Both owner calls for one card, with no write. It returns when the owner allows the claim and
// throws the refusal otherwise. WHY lock is a parameter: a claim must hold the row it judges
// until it writes, and a ready list writes nothing, so it reads the row without the lock.
export async function judgeGatedClaim(
  tx: ClaimTransaction,
  input: GatedClaimInput,
  lock: boolean,
): Promise<{ beadId: string; title: string; expectedEpoch: number }> {
  const { issueId, rigId, userId } = input;
  const [card] = await rows(
    tx,
    sql`SELECT i.project_id, i.title, i.description, i.bead_id,
               i.claim_owner, i.claim_epoch,
               floor(extract(epoch FROM i.claim_expires_at) * 1000)::bigint AS expires_ms,
               c.name AS column_name, c.state_type, t.name AS type_name
        FROM issue i
        JOIN project_column c ON c.id = i.column_id
        LEFT JOIN issue_type t ON t.id = i.type_id
        WHERE i.id = ${issueId} ${lock ? sql`FOR UPDATE OF i` : sql``}`,
  );
  if (!card) throw new HttpError(404, 'Issue not found');
  const projectId = Number(card.project_id);
  const { rigPrefix, beadId } = await storedBeadIdentity(tx, {
    issueId,
    rigId,
    columnBeadId: card.bead_id === null ? null : String(card.bead_id),
    what: 'claim',
  });
  const labels = await storedLabels(tx, issueId);
  // A prerequisite is the source of a stored 'blocks' link that targets the card. The parent is
  // hierarchy and is not read. WHY the column is a LEFT JOIN: every stored link must reach the
  // mapping, and an inner join would drop a prerequisite with no column and so allow the claim.
  const prerequisites = await rows(
    tx,
    sql`SELECT s.bead_id, c.name AS column_name, c.state_type
        FROM issue_link k
        JOIN issue s ON s.id = k.source_issue_id
        LEFT JOIN project_column c ON c.id = s.column_id
        WHERE k.target_issue_id = ${issueId} AND k.kind = 'blocks' ORDER BY s.id`,
  );
  const [actor] = await rows(
    tx,
    sql`SELECT u.role AS user_role,
               (SELECT m.role FROM project_member m
                WHERE m.project_id = ${projectId} AND m.user_id = u.id) AS member_role
        FROM "user" u WHERE u.id = ${userId}`,
  );
  if (!actor) throw new HttpError(409, 'A claim needs an authenticated user', 'claim-no-user');

  const gatedCard: GatedCard = {
    beadId,
    rigPrefix,
    title: String(card.title),
    description: String(card.description ?? ''),
    labels,
    columnState: String(card.state_type),
  };
  const routed = await routingFactsForText(tx, {
    projectId,
    beadId,
    labels,
    texts: [gatedCard.title, gatedCard.description],
    userIds: [userId],
  });
  const facts = { routing_facts: routed.facts, ...(await skillFactsFor(tx, userId)) };
  await gate(rigId, routingCheckOp(gatedCard, facts));
  // The routing call returned, so the owner allowed this user on this card. That answer is the
  // only source of eligibility; no other line sets it.
  const built = buildReadinessFacts({
    beadId,
    column: { name: String(card.column_name), stateType: String(card.state_type) },
    typeName: card.type_name === null ? null : String(card.type_name),
    labels,
    prerequisites: prerequisites.map((row) => ({
      beadId: row.bead_id === null ? null : String(row.bead_id),
      column:
        row.column_name === null || row.state_type === null
          ? null
          : { name: String(row.column_name), stateType: String(row.state_type) },
    })),
    userRole: actor.user_role === null ? null : String(actor.user_role),
    memberRole: actor.member_role === null ? null : String(actor.member_role),
    routingAllowed: true,
  });
  if (!built.ok) throw unproven(built.reason);

  // The clock is read after the row lock, as close-facts.ts and the lease primitive read it.
  const [clock] = await rows(
    tx,
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  );
  const epoch = Number(card.claim_epoch);
  const expectedEpoch = input.expectedEpoch === 'locked' ? epoch : input.expectedEpoch;
  const claim = claimFactsOf(
    {
      owner: card.claim_owner === null ? null : String(card.claim_owner),
      epoch,
      expiresAtMs: card.expires_ms === null ? null : Number(card.expires_ms),
      nowMs: Number(clock.now_ms),
    },
    { actor: userId, expectedEpoch },
  );
  await gate(rigId, claimOp(gatedCard, facts, claim, built.facts));
  return { beadId, title: gatedCard.title, expectedEpoch };
}
