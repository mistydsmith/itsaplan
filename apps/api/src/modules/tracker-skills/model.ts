import { t } from 'elysia';
import { TRACKER_SKILLS } from '@repo/db/tracker-skill-receipts';

// WHY derived from TRACKER_SKILLS: a claim can name any skill the owner's work-item table maps, and the route a lane loads from
// has to accept every name the claim answer gives. A list copied here would one day be shorter than the claim's.
export const TrackerSkillParams = t.Object({
  skill: t.Union(TRACKER_SKILLS.map((skill) => t.Literal(skill))),
});

export const TrackerSkillDelivery = t.Object({
  skill: t.String(),
  sha256: t.String(),
  servedAt: t.String(),
  text: t.String(),
});
