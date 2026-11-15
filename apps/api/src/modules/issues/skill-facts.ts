import { eq } from 'drizzle-orm';
import { aiAgent, type DbExecutor } from '@repo/db';
import { loadTrackerRulesConfig } from '@repo/db/tracker-gate';
import { holdsSkillReceipt } from '@repo/db/tracker-skill-receipts';

export interface TrackerSkillFacts {
  actor_kind: 'agent' | 'human' | 'system';
  templates_skill_loaded: boolean;
  law_library_skill_loaded: boolean;
}

// The skill declarations and the actor kind a gated write hands the rule owner.
//
// WHY nothing here comes from the request (sentinel-prod-8364 G5): the owner refuses
// legal-template work until both skills are loaded, and a flag a caller could send would open
// that rule for anyone. The actor is the authenticated writer, never the assignee or delegate.
// A flag is true only while the server holds its own live delivery receipt for that writer and
// the pinned text. The receipt is keyed by user id, because the auth context gives a writer's
// user and no session id. So it proves the server delivered the pinned text to that user. It
// does not prove that the session making this write requested or read it: another session of
// the same user satisfies the flag. The kind is read from the database: an ai_agent row is an agent, a user
// without one is a human, and a write with no user is a system write, which is not a human.
// The owner exempts only a human from the two skill checks, so a wrong 'human' here would open
// legal-template work to an agent that read nothing.
export async function skillFactsFor(
  tx: DbExecutor,
  actorUserId: string | null,
): Promise<TrackerSkillFacts> {
  if (actorUserId === null) {
    return { actor_kind: 'system', templates_skill_loaded: false, law_library_skill_loaded: false };
  }
  const agents = await tx
    .select({ id: aiAgent.id })
    .from(aiAgent)
    .where(eq(aiAgent.userId, actorUserId))
    .limit(1);
  if (agents.length === 0) {
    return { actor_kind: 'human', templates_skill_loaded: false, law_library_skill_loaded: false };
  }
  const config = await loadTrackerRulesConfig();
  const pins = config.state === 'configured' ? config.skills : undefined;
  return {
    actor_kind: 'agent',
    templates_skill_loaded: await holdsSkillReceipt(pins, actorUserId, 'templates', tx),
    law_library_skill_loaded: await holdsSkillReceipt(pins, actorUserId, 'law_library', tx),
  };
}
