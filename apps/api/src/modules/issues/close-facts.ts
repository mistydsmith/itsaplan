import type { DbExecutor } from '@repo/db';
import { releaseClaim, type ClaimTransaction } from '@repo/db/issue-claim';
import { observeArtifactFacts, observeCodeFacts } from '@repo/db/tracker-close-facts';
import { loadTrackerRulesConfig, type TrackerCloseRepo } from '@repo/db/tracker-gate';
import { type TrackerActorKind } from '@repo/db/tracker-routing-facts';
import { sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';

// What a server caller says about a close. None of it is trusted as proof: the server reads the
// commit or the artifact itself, and reads the claim row itself. It does not say who the closer
// is: that is the authenticated actor of the update. It is passed as
// updateIssue's opts.closeRequest by server code and is never parsed from a request body field
// that carries a verified flag, a path to a repository or a ref.
export interface CloseRequest {
  kind: 'code' | 'report' | 'cancel';
  // Why the card closes now.
  reason: string;
  // code: a key of the manifest's close.rigs.<rig>.repos. The repository and its branch come
  // from the manifest entry.
  repo?: string;
  // code: the full 40-hex commit.
  sha?: string;
  // report and cancel: the artifact path, resolved inside a configured artifact root.
  artifact?: string;
  // cancel: where the work goes.
  disposition?: string;
  // The claim epoch the closer read. The owner compares it with the locked row.
  expectedEpoch: number;
}

// The repository a close of this rig may be observed in under that key, or undefined. A caller
// that holds a requested branch of its own compares it with targetRef and refuses a difference
// before the move: the manifest value is the only branch a close is judged on.
export async function closeRepoFor(
  rigPrefix: string,
  repoKey: string,
): Promise<TrackerCloseRepo | undefined> {
  const config = await loadTrackerRulesConfig();
  if (config.state !== 'configured') return undefined;
  const repos = config.close?.rigs[rigPrefix]?.repos ?? {};
  return Object.hasOwn(repos, repoKey) ? repos[repoKey] : undefined;
}

// The close fields of a gated close op, built from what the server observed.
//
// WHY the request never reaches the rule owner (sentinel-prod-8429 G2): the owner allows a close
// on facts marked verified, so those facts are read here from the Git object database or the
// artifact bytes, on the repository, branch and roots the pinned manifest names for the rig. The
// request only says which commit or file to read. With no request the facts stay null and the
// owner refuses with its own wording. An observation that could not be made is 503, never an
// allow.
export async function closeOpFields(input: {
  rigPrefix: string;
  beadId: string;
  request: CloseRequest | undefined;
}): Promise<Record<string, unknown>> {
  const { rigPrefix, beadId, request } = input;
  if (request === undefined) return { close_facts: null };
  const config = await loadTrackerRulesConfig();
  // The gate refuses an unusable rule config with its own code.
  if (config.state !== 'configured') return { close_facts: null };
  const target = config.close?.rigs[rigPrefix];
  if (target === undefined) {
    throw new HttpError(
      409,
      `The rule manifest names no close target for rig ${rigPrefix}`,
      'close-unconfigured',
    );
  }
  if (request.kind !== 'code') {
    const observed = await observeArtifactFacts({
      approvedRoots: target.artifactRoots,
      requestedPath: request.artifact ?? '',
      beadId,
      reason: request.reason,
      kind: request.kind,
      disposition: request.disposition,
    });
    return { close_facts: factsOf(observed) };
  }
  const repoKey = request.repo ?? '';
  const repo = Object.hasOwn(target.repos, repoKey) ? target.repos[repoKey] : undefined;
  if (repo === undefined) {
    throw new HttpError(
      409,
      `The rule manifest names no close repository '${repoKey}' for rig ${rigPrefix}`,
      'close-unconfigured',
    );
  }
  const observed = await observeCodeFacts({
    repoRoot: repo.repoRoot,
    targetRef: repo.targetRef,
    beadId,
    candidateSha: request.sha ?? '',
    reason: request.reason,
  });
  return {
    close_facts: factsOf(observed),
    configured_repo: repo.repoRoot,
    configured_branch: repo.targetRef,
  };
}

// The starting facts of a gated close op, built where the close facts are built (moved from
// service.ts by sentinel-prod-8429.2 so the module stays within its measured line count).
// WHY the name, not a state_type (sentinel-prod-8429.2): the claim rule's cancel arm compares
// the observed column NAME against the native Review literal; the update op's previous and
// proposed states keep state_type unchanged.
export function closeOpStart(
  beadId: string,
  rigPrefix: string,
  stateRows: { id: number | string; state_type: string; name: string | null }[],
  lockedColumnId: number,
): Record<string, unknown> {
  const closeOp: Record<string, unknown> = {
    op: 'close',
    id: beadId,
    rig_prefix: rigPrefix,
  };
  // 8429.2: the observed locked column's stored name - the Review literal the claim
  // rule's cancel arm compares; null (no column row) fails closed in the owner.
  closeOp.column_state = stateRows.find((r) => Number(r.id) === lockedColumnId)?.name ?? null;
  return closeOp;
}

// Who closes and at which epoch. WHY actor is not part of CloseRequest (Root msg_9f996783879c):
// claim_owner is readable by anyone who can read the card, so a closer that could name its own
// actor could name the stored owner. The actor is the user id the update was authenticated as,
// and a claim is held under that same user id.
export interface Closer {
  actor: string;
  expectedEpoch: number;
}

// The closer of a gated update, or a refusal when the update has no authenticated user.
export function closerOf(actorUserId: string | null, request: CloseRequest): Closer {
  if (actorUserId === null || actorUserId.length === 0) {
    throw new HttpError(
      409,
      'A close needs the authenticated user that holds the claim',
      'close-without-principal',
    );
  }
  return { actor: actorUserId, expectedEpoch: request.expectedEpoch };
}

// The claim facts of a gated close: the stored claim row and the server clock, next to the
// authenticated closer. The rule owner compares them; nothing here decides whether the claim is
// live.
export function claimFactsOf(
  row: { owner: string | null; epoch: number; expiresAtMs: number | null; nowMs: number },
  closer: Closer,
) {
  return {
    owner: row.owner,
    epoch: row.epoch,
    expires_at_ms: row.expiresAtMs,
    now_ms: row.nowMs,
    actor: closer.actor,
    expected_epoch: closer.expectedEpoch,
  };
}

// WHY the clock is its own statement after the row lock (same rule as @repo/db issue-claim.ts): a
// transaction that waited for the lock must read the time it resumed, or a claim that lapsed
// during the wait is judged live. Both values are floored to whole milliseconds, so a claim with
// less than one millisecond left is judged lapsed, never the reverse.
export async function readClaimFacts(tx: DbExecutor, issueId: number, closer: Closer) {
  const rows = (await tx.execute(
    sql`SELECT claim_owner, claim_epoch,
               floor(extract(epoch FROM claim_expires_at) * 1000)::bigint AS expires_ms
        FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as {
    claim_owner: string | null;
    claim_epoch: number | string;
    expires_ms: number | string | null;
  }[];
  if (rows.length === 0) throw new HttpError(404, 'Issue not found');
  const [clock] = (await tx.execute(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  )) as unknown as { now_ms: number | string }[];
  return claimFactsOf(
    {
      owner: rows[0].claim_owner,
      epoch: Number(rows[0].claim_epoch),
      expiresAtMs: rows[0].expires_ms === null ? null : Number(rows[0].expires_ms),
      nowMs: Number(clock.now_ms),
    },
    closer,
  );
}

// The columns the closing move itself writes.
const CLOSE_WRITE_KEYS = new Set(['columnId', 'position', 'updatedAt']);

// True when a closing write sets nothing but the move. WHY it matters (Root msg_b6d390a40af4): a
// close op carries no card states, so the owner's identity, trap and routing rules judge nothing
// on it. A closing write that also sets another field, a column auto-assignee included, is
// judged a second time as a full update op on the same transaction.
export function isBareClose(writeSet: Record<string, unknown>): boolean {
  return Object.keys(writeSet).every((key) => CLOSE_WRITE_KEYS.has(key));
}

// Releases the closer's claim after the closing move was written. WHY on the same transaction
// (Root msg_b6d390a40af4): a closed card must not stay held, and a release that fails means the
// claim the owner judged is no longer the stored one, so the whole close rolls back.
export async function releaseClosedClaim(tx: DbExecutor, issueId: number, closer: Closer) {
  // 8429.2: the claim rule now allows an authorized cancel of an UNOWNED card. Releasing a claim
  // that does not exist would refuse (not-claimed) and roll back the close the owner allowed, so
  // the release is skipped when the locked row holds no owner. With an owner present the release
  // runs exactly as before: the same actor and epoch, the same refusals.
  const rows = (await tx.execute(
    sql`SELECT claim_owner FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as { claim_owner: string | null }[];
  if (rows.length === 0) throw new HttpError(404, 'Issue not found');
  if (rows[0].claim_owner === null) return;
  const released = await releaseClaim(tx as ClaimTransaction, {
    issueId,
    actor: closer.actor,
    expectedEpoch: closer.expectedEpoch,
  });
  if (!released.ok) {
    throw new HttpError(
      409,
      `The claim could not be released with the close: ${released.message}`,
      `claim-${released.code}`,
    );
  }
}

// The writer's own check after the gate allowed a close. WHY it stays (sentinel-prod-8429 G2): a
// rule config that relaxed the close rule must still not let a close commit without facts this
// server observed and a claim row it read.
// 8429.2: the server-computed operator_close is its own proof - a human owner's screen close
// carries no close request, so it has no observed close facts and no closer's claim row. The
// fact is computed from the transaction's own reads, never from the body (see operatorCloseFact).
export function closeIsProven(op: Record<string, unknown>): boolean {
  if (op.operator_close === true) return true;
  const facts = op.close_facts as { verified?: unknown } | null | undefined;
  const claim = op.claim_facts;
  return facts != null && facts.verified === true && claim != null && typeof claim === 'object';
}

// Whether that backstop applies to this close at all.
//
// WHY 8429 (Misty 2026-11-15): "i guarantee you EVERY block will block me too". The backstop is the tracker refusing a signed-in
// person on her own card before any rule owner is asked, so a person whose kind this server read from the database passes it. Her
// close facts and claim facts are still read and attached exactly as before, and an agent or a system close is refused on the
// same closeIsProven fact in the same words.
export function closeBackstopApplies(
  op: Record<string, unknown>,
  actorKind: TrackerActorKind,
): boolean {
  return actorKind !== 'human' && !closeIsProven(op);
}

// The one server-side fact the operator close rides on (8429.2): true only when the authenticated
// user of this update is a human non-agent holding the project owner role. Computed from the
// transaction's own reads - the aiAgent row and the membership role - never from the request
// body. An agent key always has an aiAgent row, so it can never carry this fact, and a caller
// that names the flag in its request is never read: buildUpdateOp builds the op field by field.
export async function operatorCloseFact(
  tx: DbExecutor,
  input: { projectId: number; actorUserId: string | null },
): Promise<boolean> {
  if (input.actorUserId === null || input.actorUserId.length === 0) return false;
  const rows = (await tx.execute(
    sql`SELECT EXISTS(
          SELECT 1 FROM ai_agent WHERE user_id = ${input.actorUserId}
        ) AS is_agent,
        (SELECT role FROM project_member
         WHERE project_id = ${input.projectId} AND user_id = ${input.actorUserId}) AS member_role`,
  )) as unknown as { is_agent: boolean; member_role: string | null }[];
  if (rows.length === 0) return false;
  return !rows[0].is_agent && rows[0].member_role === 'owner';
}

// The close op's trusted facts, all read on the transaction that holds the card's lock (8429.2):
// the close request's observed proof (closeOpFields), the claim row of the authenticated closer,
// and the operator_close fact. The closer is the authenticated user of the update, refused before
// any proof is read; nothing a caller sent can set any of these.
export async function attachCloseFacts(
  closeOp: Record<string, unknown>,
  input: {
    tx: DbExecutor;
    id: number;
    rigPrefix: string;
    beadId: string;
    request?: CloseRequest;
    projectId: number;
    actorUserId: string | null;
  },
): Promise<void> {
  const closer = input.request === undefined ? null : closerOf(input.actorUserId, input.request);
  Object.assign(
    closeOp,
    await closeOpFields({
      rigPrefix: input.rigPrefix,
      beadId: input.beadId,
      request: input.request,
    }),
  );
  if (closer !== null) closeOp.claim_facts = await readClaimFacts(input.tx, input.id, closer);
  closeOp.operator_close = await operatorCloseFact(input.tx, {
    projectId: input.projectId,
    actorUserId: input.actorUserId,
  });
  // 8429.2 producer wiring: the unowned Review cancel arm's trusted facts. review_cancel_actors is
  // the owner CONFIG's pinned list (loadTrackerRulesConfig omits a malformed or empty list, so an
  // absent fact means nobody, never a wider arm); author is the creator user id this server
  // recorded when the card was created. Both ride on the op the owner judges, read on the
  // transaction that holds the card's lock and never from the request; a missing author makes the
  // owner's arm refuse, so a card whose creator cannot be proven is never cancelable on it.
  const config = await loadTrackerRulesConfig();
  if (config.state === 'configured' && config.review_cancel_actors !== undefined) {
    closeOp.review_cancel_actors = config.review_cancel_actors;
  }
  closeOp.author = await cardAuthor(input.tx, input.id);
}

// The operator close wins over any held claim (8429.2): a closed card must not stay held, so when
// the operator closes a card another lane holds, the server clears that claim on the same
// transaction. WHY a direct clear rather than releaseClaim: the operator is not the claim's owner,
// so the owner/epoch release would refuse; the owner rule already judged this close, and the clear
// reads the claim row it judged under the same locks. The stored epoch stays, so the unowned row
// sits at its released epoch, exactly as after an ordinary release.
export async function clearOperatorCloseClaim(tx: DbExecutor, issueId: number): Promise<void> {
  const rows = (await tx.execute(
    sql`SELECT claim_owner FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as { claim_owner: string | null }[];
  if (rows.length === 0) throw new HttpError(404, 'Issue not found');
  if (rows[0].claim_owner === null) return;
  await tx.execute(
    sql`UPDATE issue SET claim_owner = NULL, claim_expires_at = NULL WHERE id = ${issueId}`,
  );
}

// The trusted creator of a card (8429.2): the actor user id this server recorded on the card's
// 'created' activity, the oldest such row. Null when there is no recorded creator; the owner's
// cancel arm fails closed on a missing author, so a card whose creator cannot be proven is never
// cancelable on that arm. Read on the transaction that holds the card's lock, never the request.
export async function cardAuthor(tx: DbExecutor, issueId: number): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT actor_user_id
       FROM issue_activity
       WHERE issue_id = ${issueId} AND kind = 'activity' AND action = 'created'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
  )) as unknown as { actor_user_id: string | null }[];
  return rows.length > 0 ? rows[0].actor_user_id : null;
}

type Observed =
  Awaited<ReturnType<typeof observeCodeFacts>> | Awaited<ReturnType<typeof observeArtifactFacts>>;

function factsOf(observed: Observed) {
  if (observed.status === 'unavailable') {
    throw new HttpError(
      503,
      `The close proof could not be read: ${observed.reason}`,
      observed.code,
    );
  }
  if (observed.status === 'refused') {
    throw new HttpError(409, `close-facts: ${observed.reason}`, observed.code);
  }
  return observed.facts;
}
