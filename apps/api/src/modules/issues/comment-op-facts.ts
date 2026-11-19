import { type DbExecutor } from '@repo/db';
import { sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';

// The card facts and the op shape the tracker owner judges a gated comment write on.
//
// WHY this file exists (sentinel-prod-8429, Misty 2026-11-15: "i guarantee you EVERY block will block me too"): giving a comment
// create, edit or delete the actor kind the owner needs has to happen where that op is built, and comment-history.ts already
// stands over the 400-line module-size ceiling at main, where the gate lets a file stay the same or shrink but never grow. These
// two pieces move out whole so the comment doors can gain their actor fact in the file that builds their op. Nothing about either
// one changed: same queries, same transaction, same refusal codes and words, same op fields.

// The card facts and identity the owner op is built from, read on the caller's transaction under its
// locks. The bead id comes from the ledger scoped to the locked rig, never from a title.
export async function ownerCardFacts(
  executor: DbExecutor,
  issueId: number,
  rigId: number,
): Promise<{
  beadId: string;
  rigPrefix: string;
  title: string;
  description: string;
  labels: string[];
}> {
  const identity = (await executor.execute(sql`
    SELECT b.local_token AS bead_id, r.prefix AS rig_prefix
    FROM bead_identity b JOIN rig r ON r.id = b.rig_id
    WHERE b.issue_id = ${issueId} AND b.rig_id = ${rigId}`)) as unknown as {
    bead_id: string;
    rig_prefix: string;
  }[];
  if (identity.length !== 1) {
    throw new HttpError(
      409,
      'This issue holds no bead identity in its rig, so its comment cannot be judged',
      'issue-without-identity',
    );
  }
  const card = (await executor.execute(sql`
    SELECT title, description FROM issue WHERE id = ${issueId}`)) as unknown as {
    title: string;
    description: string;
  }[];
  const labels = (await executor.execute(sql`
    SELECT l.name FROM issue_label il JOIN label l ON l.id = il.label_id
    WHERE il.issue_id = ${issueId} ORDER BY l.name`)) as unknown as { name: string }[];
  return {
    // The owner names a card by rig prefix plus ledger token, the same composed id W1 hands it.
    beadId: `${identity[0].rig_prefix}-${identity[0].bead_id}`,
    rigPrefix: identity[0].rig_prefix,
    title: card[0]?.title ?? '',
    description: card[0]?.description ?? '',
    labels: labels.map((row) => row.name),
  };
}

// The op the owner judges: the retained comments in previous_state and the new body as the top-level
// comment. Built only from the facts read on this transaction.
//
// WHY the actor user id is a required field (sentinel-prod-8429): it is the only way the op can say who wrote this comment, and
// the kind is derived from her database rows by actorKindOf on the caller's transaction - never from the body, never from a field
// the request supplied. A door that cannot name its user passes null, which is a system write, not an unknown one.
export function commentOp(input: {
  opName: 'comment_create' | 'comment_edit' | 'comment_delete';
  facts: Awaited<ReturnType<typeof ownerCardFacts>>;
  // Stored version bodies only, oldest first.
  versions: string[];
  // The live comments in record order, including the one this write touches.
  liveBefore: { id: number; body: string }[];
  // The bodies this write supersedes, taken from the locked rows: the edited comment's old body, or
  // every body a delete removes. Never a body the request supplied.
  superseded: string[];
  editBody?: string;
  actorUserId: string | null;
}): Record<string, unknown> {
  const base = {
    title: input.facts.title,
    description: input.facts.description,
    labels: input.facts.labels,
    bead_id: input.facts.beadId,
  };
  const op: Record<string, unknown> = {
    op: input.opName,
    id: input.facts.beadId,
    rig_prefix: input.facts.rigPrefix,
    title: input.facts.title,
    labels: input.facts.labels,
    ...(input.editBody === undefined ? {} : { comment: input.editBody }),
    // Retained history is the stored versions plus every live body as it stood before the write.
    previous_state: {
      ...base,
      comments: [...input.versions, ...input.liveBefore.map((r) => r.body)],
    },
    // WHY proposed_state carries no comments (sentinel-prod-8364, the 9913.5 HTTP 409): it used to repeat the
    // versions, the superseded bodies and the post-write live list, so a card with about 512 KiB of history
    // passed the owner's 1 MiB input limit. No rule needs that copy. tracker_rule_compliance reads only
    // previous_state.comments. tracker_rule_routing reads comments in both states, but only for @lane
    // mentions, and every proposed body is a retained body above or the top-level comment it already reads.
    // An absent key reads as an empty list in both rules. Do not put the list back to "complete" the state,
    // and do not dedupe or split previous_state.comments: compliance's \s+ patterns can match across the
    // join between two retained bodies, so its order and every body stay exactly as stored.
    proposed_state: base,
  };
  return op;
}
