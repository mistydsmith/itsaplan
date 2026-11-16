import { Elysia } from 'elysia';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { errors } from '#shared/responses';
import { mcpTool } from '#mcp/generate';
import { TrackerSkillDelivery, TrackerSkillParams } from './model';
import { deliverTrackerSkill } from './service';

// Self-scoped to the caller: the receipt is recorded for the authenticated user and nobody else,
// so no project guard applies.
export const trackerSkillRoutes = new Elysia({
  name: 'tracker-skills',
  detail: { tags: ['Issues'] },
})
  .use(authContext)

  .get(
    '/tracker/skills/:skill',
    ({ user, params }) => deliverTrackerSkill(requireUser(user).id, params.skill),
    {
      params: TrackerSkillParams,
      response: { 200: TrackerSkillDelivery, ...errors(400, 401, 404, 409) },
      detail: {
        summary: 'Read a tracker skill',
        description:
          'Returns the pinned text of a tracker skill - templates, law_library, pleading, ' +
          'headnote_authoring or jurisprudence - and records that you were served it. A ' +
          'legal-template issue write by an agent is refused until that agent has read templates ' +
          'and law_library in the last eight hours, and a claim names the skills its card labels ' +
          'ask for. Read the text before you write: the record covers only you and only this ' +
          'version of the text.',
        ...mcpTool('read_tracker_skill'),
      },
    },
  );
