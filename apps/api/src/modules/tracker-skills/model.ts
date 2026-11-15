import { t } from 'elysia';

export const TrackerSkillParams = t.Object({
  skill: t.Union([t.Literal('templates'), t.Literal('law_library')]),
});

export const TrackerSkillDelivery = t.Object({
  skill: t.String(),
  sha256: t.String(),
  servedAt: t.String(),
  text: t.String(),
});
