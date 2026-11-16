import type { DbExecutor } from '@repo/db';
import type { ClaimTransaction } from '@repo/db/issue-claim';
import { loadTrackerRulesConfig } from '@repo/db/tracker-gate';
import {
  holdsSkillReceipt,
  skillPromptsFor,
  skillsNeededForLabels,
  type TrackerSkill,
  type TrackerSkillPins,
  type TrackerSkillPrompt,
  type TrackerWorkItemSkills,
} from '@repo/db/tracker-skill-receipts';
import type { TrackerActorKind } from '@repo/db/tracker-routing-facts';

// What a claim answers about the skills the card needs (sentinel-prod-8429).
//
// Misty 2026-11-15: "i also want lanes to load dss-law related production skills like
// headnote/jurisprudence/template/lawlibrary etc deepending on the work item". The table that maps a card's labels to its
// skills is the owner's pinned config, and this file is the only reader of it on the claim path. WHY the answer names the path
// and the sha256 and not only the skill name: the lane loads the text the manifest pins, from the route that writes the receipt
// for those exact bytes, so the name a lane works from is the name the server can prove it served.
//
// WHY the answer is empty for a person (Misty 2026-11-15: "i guarantee you EVERY block will block me too"): she is never told
// what she may read, and a prompt on her own card is a block in her way. The actor kind is the one the database gives - an
// ai_agent row is an agent, a user without one is a person - and this file adds no second definition of either.
//
// WHY a missing receipt is a prompt and not a refusal: nothing here stops a write. The claim already happened; this is what the
// claim tells the lane to read next. The two skill flags the legal-template rule reads stay exactly as they were, and no new
// gate is added by this file.
export interface ClaimSkillInput {
  actorKind: TrackerActorKind;
  labels: readonly string[];
  pins?: TrackerSkillPins;
  workItemSkills?: TrackerWorkItemSkills;
  /** True when this user already holds a live receipt for the pinned text of that skill. */
  isLive: (skill: TrackerSkill) => boolean;
}

export function claimSkillPrompts(input: ClaimSkillInput): TrackerSkillPrompt[] {
  if (input.actorKind === 'human') return [];
  const needed = skillsNeededForLabels(input.labels, input.workItemSkills);
  return skillPromptsFor(input.pins, needed, input.isLive);
}

// The same answer read from the rows: the manifest sections and this user's live receipts, on the caller's own transaction.
// WHY a read rather than a request field: the labels are the card's stored labels, the pins are the manifest's, and a receipt is
// a row the server wrote. A lane cannot name a skill it needs, cannot drop one it was told about, and cannot claim it loaded one
// the server never served.
// WHY callers reach it through claimSkillPromptsAfterClaim: this reader reads, and a reader can fail. Nothing on the claim path
// may turn a prompt into a cost.
export async function claimSkillPromptsForCard(
  tx: DbExecutor,
  card: { labels: readonly string[]; actorKind: TrackerActorKind; userId: string },
): Promise<TrackerSkillPrompt[]> {
  const config = await loadTrackerRulesConfig();
  const state = config.state === 'configured' ? config : undefined;
  const needed = skillsNeededForLabels(card.labels, state?.workItemSkills);
  if (needed.length === 0) return [];
  const live = new Set<TrackerSkill>();
  for (const skill of needed) {
    if (await holdsSkillReceipt(state?.skills, card.userId, skill, tx)) live.add(skill);
  }
  return claimSkillPrompts({
    actorKind: card.actorKind,
    labels: card.labels,
    pins: state?.skills,
    workItemSkills: state?.workItemSkills,
    isLive: (skill) => live.has(skill),
  });
}

// The prompt answer a claim or a ready walk attaches, in the order that keeps the ruling true.
// WHY the person is answered before anything is read (Office RETURN 2026-11-15): a person is never told what to read, so her
// claim must not depend on a config read, a receipt read or a label lookup. Answering her first means nothing on this path is
// left to fail against her.
// WHY the read is contained: the prompt travels on an answer the owner already allowed, inside the same transaction as the
// claim. A prompt that cannot be computed says nothing, which is all a prompt is allowed to do; it never refuses the claim and
// never rolls it back, for any actor.
export type SkillPromptReader = (
  tx: DbExecutor,
  card: { labels: readonly string[]; actorKind: TrackerActorKind; userId: string },
) => Promise<TrackerSkillPrompt[]>;

export async function claimSkillPromptsAfterClaim(
  tx: ClaimTransaction,
  card: { labels: readonly string[]; actorKind: TrackerActorKind; userId: string },
  // WHY the reader is a parameter with a production default: the witnesses have to hand in a reader that fails, which is the
  // only way to show that a failed prompt read leaves a claim standing. Both callers pass nothing and get the row reader above.
  read: SkillPromptReader = claimSkillPromptsForCard,
): Promise<TrackerSkillPrompt[]> {
  // WHY the read runs inside a nested transaction rather than straight on the caller's (Office D1 delta RETURN 2026-11-16):
  // a rejected statement does not only reject itself. Postgres puts the whole transaction into failed state, and a JavaScript
  // catch cannot undo that, so every statement after it - the release, the commit that carries the claim - would fail. The
  // optional prompt read is exactly the kind of statement that can be rejected, so it gets its own savepoint: a read that
  // fails rolls back to that point and nothing else, the claim's own work in the same transaction stays, and the catch sits
  // outside the boundary so the failure ends as no prompt instead of as a refused claim. This is the pattern this monorepo
  // already uses when a statement inside someone's transaction is expected to be a refusal (packages/db/src/issue-identity.ts
  // and packages/db/src/bead-import-identity.ts), and drizzle runs it as SAVEPOINT / ROLLBACK TO SAVEPOINT on postgres-js.
  // WHY the savepoint is opened before the read is asked, not after: the reader decides how many statements it needs, so the
  // boundary has to exist before the first one runs. One SAVEPOINT and its release on a claim by an actor that is told
  // something is the whole cost, and a person never reaches it.
  if (card.actorKind === 'human') return [];
  try {
    return await tx.transaction((sp) => read(sp, card));
  } catch {
    return [];
  }
}
