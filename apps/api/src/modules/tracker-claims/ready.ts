import { db } from '@repo/db';
import { claimIssue, type ClaimTransaction } from '@repo/db/issue-claim';
import { sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { judgeGatedClaim } from './gated-claim';
import { claimDto, claimRefusalError, type ClaimDto } from './service';

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

type Candidate = { id: number | string; priority: string | null };

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
      const [{ total }] = (await tx.execute(
        sql`SELECT count(*)::int AS total ${candidates(projectId)}`,
      )) as unknown as { total: number }[];
      const rows = await window(tx, projectId, page);
      const items: ReadyItem[] = [];
      const excluded: Record<string, number> = {};
      for (const row of rows) {
        const id = Number(row.id);
        try {
          const judged = await judgeGatedClaim(
            tx,
            { issueId: id, rigId, userId, expectedEpoch: 'locked' },
            false,
          );
          items.push({
            id,
            beadId: judged.beadId,
            title: judged.title,
            priority: row.priority,
            epoch: judged.expectedEpoch,
          });
        } catch (error) {
          const reason = excludedReason(error);
          if (reason === null) throw error;
          count(excluded, reason);
        }
      }
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
            const claimed = {
              ...claimDto(result.claim, false, userId),
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
