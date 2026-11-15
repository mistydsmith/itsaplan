import type { DbExecutor } from '@repo/db';
import { releaseClaim, type ClaimTransaction } from '@repo/db/issue-claim';
import { observeArtifactFacts, observeCodeFacts } from '@repo/db/tracker-close-facts';
import { loadTrackerRulesConfig, type TrackerCloseRepo } from '@repo/db/tracker-gate';
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
export function closeIsProven(op: Record<string, unknown>): boolean {
  const facts = op.close_facts as { verified?: unknown } | null | undefined;
  const claim = op.claim_facts;
  return facts != null && facts.verified === true && claim != null && typeof claim === 'object';
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
