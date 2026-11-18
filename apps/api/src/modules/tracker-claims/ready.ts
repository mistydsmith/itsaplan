import { db } from '@repo/db';
import { claimIssue, type ClaimTransaction } from '@repo/db/issue-claim';
import { sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { judgeGatedClaim } from './gated-claim';
import { pageGateFacts } from './readiness-facts';
import { claimDto, claimRefusalError, type ClaimDto } from './service';
import { claimSkillPromptsAfterClaim } from './skill-answer';

// The ready pool of a project with a rig: the open cards nobody holds, each judged by the rule
// owner for the requesting user. WHY every card is judged and none is assumed (Root 2026-11-15):
// an unjudged card in the list would be a card the client treats as allowed. A card the owner
// refuses, or whose facts no stored row proves, is counted under its reason and left out.

export interface ReadyItem {
  id: number;
  beadId: string;
  title: string;
  priority: string | null;
  epoch: number;
}

// The reason a single card is left out, or null for an error that is about the whole request
// (no rule config, no user) and must fail it.
export function excludedReason(error: unknown): string | null {
  // A card deleted after the candidates were read.
  if (error instanceof HttpError && error.status === 404) return 'gone';
  if (!(error instanceof HttpError) || error.status !== 409 || error.code === undefined) {
    return null;
  }
  const { code } = error;
  if (code.startsWith('claim-unproven-')) return code.slice('claim-unproven-'.length);
  if (code === 'tracker-rules-violation') return 'owner-refused';
  if (code === 'lane-unrouted' || code.startsWith('issue-')) return code;
  // A lease that became live after the candidates were read.
  if (code === 'claim-live-other-owner' || code === 'claim-stale-epoch') return 'lease-taken';
  return null;
}

// WHY a null priority sorts last and an unknown value with it: the order must be total and
// stable, and a value outside the four named ones states no urgency.
const ORDER = sql`CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                  WHEN 'low' THEN 3 ELSE 4 END, i.created_at ASC, i.id ASC`;

// Open, not archived, and with no live lease. A lease held by the requesting user is live too,
// so a card the user already works on is never handed out a second time.
const candidates = (projectId: number) => sql`
  FROM issue i JOIN project_column c ON c.id = i.column_id
  WHERE i.project_id = ${projectId} AND i.archived_at IS NULL
    AND c.state_type NOT IN ('completed', 'canceled')
    AND (i.claim_expires_at IS NULL OR i.claim_expires_at <= clock_timestamp())`;

export type Candidate = { id: number | string; priority: string | null };

// The project's rig, held FOR SHARE until commit so every card is judged under one rig.
async function heldRig(tx: ClaimTransaction, projectId: number): Promise<number> {
  const [row] = (await tx.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR SHARE`,
  )) as unknown as { rig_id: number | string | null }[];
  if (!row) throw new HttpError(404, 'Project not found');
  if (row.rig_id === null) {
    throw new HttpError(
      409,
      'This project has no rig, so no rule owner judges which of its issues are ready',
      'ready-needs-rig',
    );
  }
  return Number(row.rig_id);
}

async function window(
  tx: ClaimTransaction,
  projectId: number,
  page: { limit: number; offset: number },
  judged: number[] = [],
) {
  const unjudged =
    judged.length === 0
      ? sql``
      : sql`AND i.id NOT IN (${sql.join(
          judged.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return (await tx.execute(
    sql`SELECT i.id, i.priority ${candidates(projectId)} ${unjudged}
        ORDER BY ${ORDER} LIMIT ${page.limit} OFFSET ${page.offset}`,
  )) as unknown as Candidate[];
}

const count = (excluded: Record<string, number>, reason: string) => {
  excluded[reason] = (excluded[reason] ?? 0) + 1;
};

// HOW MUCH judgment work one page pays (sentinel-prod-8429, measured 2026-11-16): one card is two
// rule-owner spawns, the state op and the claim op, and one page is DEFAULT_PAGE_SIZE = 25 cards, so
// a page of the ready pool is 50 spawns of the pinned owner. Measured through the same transport the
// server uses (loadTrackerRulesConfig plus checkTrackerRules, the pinned runtime config, synthetic
// cards, no database): serial, 1689 ms for the page at 34 ms a spawn, p50 33 ms, p95 37 ms. Two
// judgments in flight: 966 ms, p50 36 ms, p95 39 ms. Three: 714 ms but p95 71 ms. Four: 594 ms, p95
// 80 ms. Eight: 354 ms, p95 61 ms, p50 44 ms. The wall keeps shrinking, the latency of each judgment
// does not, and this machine has 12 cpus already carrying a load average near 7. Two is the largest
// gain that costs nothing in tail latency and the smallest bound the measurement supports, so the
// bound is 2 and not a rounder number. The whole 100-card pool is the same shape: 6876 ms serial,
// 4081 ms at two, 2041 ms at four. Proof file
// /Users/misty/Output/reports/8429_READY_OWNER_SPAWN_TIMING_R2.json.
export const JUDGE_CONCURRENCY = 2;

// Judge every candidate on the page with at most `concurrency` judgments in flight, and hand back
// the allowed ones in the order the candidates arrived. WHY the slots (exported for the focused
// test): a plain concurrent map would answer the page in completion order, and the ready pool is
// ordered by priority and age, so a faster card must not overtake a more urgent one. WHY the
// judgment itself is untouched: every card is still judged by the rule owner, state op and claim op
// both, exactly as a single-card claim is judged. Nothing here decides a card may be skipped.
export async function judgePage(
  rows: Candidate[],
  judge: (row: Candidate) => Promise<ReadyItem>,
  excluded: Record<string, number>,
  concurrency: number = JUDGE_CONCURRENCY,
): Promise<ReadyItem[]> {
  const slots: (ReadyItem | null)[] = rows.map(() => null);
  const bound = Math.max(1, Math.min(concurrency, JUDGE_CONCURRENCY));
  let cursor = 0;
  const judgeOne = async () => {
    for (;;) {
      const at = cursor++;
      if (at >= rows.length) return;
      try {
        slots[at] = await judge(rows[at]);
      } catch (error) {
        const reason = excludedReason(error);
        // An error about the whole request (no rule config, no user) fails the request, as it did
        // when the page was walked one card at a time.
        if (reason === null) throw error;
        count(excluded, reason);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(bound, rows.length) }, () => judgeOne()));
  return slots.filter((item): item is ReadyItem => item !== null);
}

export async function readReady(
  projectId: number,
  userId: string,
  page: { limit: number; offset: number },
) {
  // WHY repeatable read: the count and the window are two statements, and at the default
  // isolation each reads its own snapshot, so a card that leaves the candidates between them
  // gives a short window beside a larger total. It is not read only: heldRig locks FOR SHARE.
  return db.transaction(
    async (tx) => {
      const rigId = await heldRig(tx, projectId);
      // 8429.8: the user-stable gate facts are made once per page, inside the transaction, and
      // every card on the page is judged on them. With unset or refusal rule config this is null
      // and the per-card paths behave exactly as before.
      const pageFacts = await pageGateFacts(tx, projectId, userId);
      const [{ total }] = (await tx.execute(
        sql`SELECT count(*)::int AS total ${candidates(projectId)}`,
      )) as unknown as { total: number }[];
      const rows = await window(tx, projectId, page);
      const excluded: Record<string, number> = {};
      const items = await judgePage(
        rows,
        async (row) => {
          const id = Number(row.id);
          const judged = await judgeGatedClaim(
            tx,
            { issueId: id, rigId, userId, expectedEpoch: 'locked' },
            false,
            pageFacts,
          );
          return {
            id,
            beadId: judged.beadId,
            title: judged.title,
            priority: row.priority,
            epoch: judged.expectedEpoch,
          };
        },
        excluded,
      );
      return {
        items,
        candidateTotal: total,
        evaluatedCount: rows.length,
        eligibleCountOnPage: items.length,
        excluded,
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

// The size of one read of candidates while walking the pool. It bounds one query, not the walk:
// the walk ends at the first allowed card or when no candidate is left.
const WALK_BATCH = 25;

export async function claimReady(
  projectId: number,
  userId: string,
): Promise<{
  claimed: (ClaimDto & { id: number; beadId: string }) | null;
  evaluatedCount: number;
  excluded: Record<string, number>;
}> {
  return db.transaction(async (tx) => {
    const rigId = await heldRig(tx, projectId);
    const excluded: Record<string, number> = {};
    let evaluatedCount = 0;
    // WHY the walk names the cards it judged instead of counting an offset: a refused card can
    // leave the candidates while the walk runs (another user claims it), and an offset would then
    // pass over a card nobody judged. Each card is judged in a savepoint, so a refused card's row
    // lock is released and the walk holds only the one card it is judging.
    // WHY this walk stays one card at a time while the page read judges two cards at once
    // (sentinel-prod-8429): every judgment here runs in its own savepoint inside one transaction and
    // ends by taking the lease, and savepoints on one connection cannot be open side by side - two
    // in flight would write into each other's savepoint. The page read is reads only, so it can
    // overlap. The walk also stops at the first allowed card, so its usual cost is one judgment, not
    // a page of them.
    const judged: number[] = [];
    for (;;) {
      const rows = await window(tx, projectId, { limit: WALK_BATCH, offset: 0 }, judged);
      if (rows.length === 0) return { claimed: null, evaluatedCount, excluded };
      for (const row of rows) {
        const id = Number(row.id);
        evaluatedCount += 1;
        try {
          return await tx.transaction(async (card) => {
            const input = { issueId: id, rigId, userId, expectedEpoch: 'locked' as const };
            const allowed = await judgeGatedClaim(card, input, true);
            const result = await claimIssue(card, {
              issueId: id,
              actor: userId,
              expectedEpoch: allowed.expectedEpoch,
            });
            if (!result.ok) throw claimRefusalError(result);
            // WHY the ready walk answers the same way a claim does (8429): the lane picks the card from this walk and then works
            // it, so a skill this card needs has to reach it here as well as on a claim it asked for by hand. The same wrapper
            // answers here, so a person is answered before anything is read and a prompt that cannot be computed leaves the walk
            // and the claim intact.
            const skillPrompts = await claimSkillPromptsAfterClaim(card, {
              labels: allowed.labels,
              actorKind: allowed.actorKind,
              userId,
            });
            const claimed = {
              ...claimDto(result.claim, false, userId),
              ...(skillPrompts.length === 0 ? {} : { skills: skillPrompts }),
              id,
              beadId: allowed.beadId,
            };
            return { claimed, evaluatedCount, excluded };
          });
        } catch (error) {
          const reason = excludedReason(error);
          if (reason === null) throw error;
          count(excluded, reason);
          judged.push(id);
        }
      }
    }
  });
}
