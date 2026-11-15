import { Elysia } from 'elysia';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { entityGuard, guards } from '#shared/guards';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import { mcpTool } from '#mcp/generate';
import { getIssueProjectId } from '#modules/issues/service';
import { HttpError } from '#shared/lib';
import { DEFAULT_PAGE_SIZE } from '#shared/pagination';
import {
  BeadIssueResponse,
  BeadParams,
  ClaimBody,
  ClaimParams,
  ClaimResponse,
  ProjectKeyParams,
  ReadyClaimBody,
  ReadyClaimResponse,
  ReadyQuery,
  ReadyResponse,
} from './model';
import { claimReady, readReady } from './ready';
import { dropClaim, extendClaim, readBeadIssue, readClaim, takeClaim } from './service';

const writeResponse = { 200: ClaimResponse, ...commonErrors, ...errors(409) };

// The claim on an issue: who is working on it, under which epoch, until when. The holder is
// always the authenticated user; a request carries only the epoch it last read.
export const trackerClaimRoutes = new Elysia({
  name: 'tracker-claims',
  detail: { tags: ['Issues'] },
})
  .use(authContext)
  .use(guards)
  .macro({
    workItem: entityGuard('work_items', 'Issue not found', (p) =>
      getIssueProjectId(Number(p.issueId)),
    ),
    // WHY a guard of its own: the project comes from the issue that carries the bead id, so an id
    // the caller cannot read answers 404 or 403 exactly as an issue id does.
    beadItem: entityGuard(
      'work_items',
      'Issue not found',
      async (p) => (await readBeadIssue(p.beadId))?.projectId ?? null,
    ),
  })

  .get(
    '/tracker/issues/:beadId',
    async ({ params }) => {
      const found = await readBeadIssue(params.beadId);
      if (!found) throw new HttpError(404, 'Issue not found');
      return { id: found.id, beadId: found.beadId };
    },
    {
      params: BeadParams,
      beadItem: 'read',
      response: { 200: BeadIssueResponse, ...accessErrors },
      detail: {
        summary: 'Find the issue that carries a bead id',
        description:
          'Returns the issue id for one full bead id, matched exactly against the id stored on ' +
          'the issue. Use the issue id with the claim and issue routes.',
      },
    },
  )

  .get(
    '/projects/:projectKey/tracker/ready',
    async ({ project, query, user }) => {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
      const read = await readReady(project.id, requireUser(user).id, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { ...read, page, pageSize };
    },
    {
      params: ProjectKeyParams,
      query: ReadyQuery,
      permission: ['work_items', 'read'],
      response: { 200: ReadyResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'List the issues you may claim on one page of the ready pool',
        description:
          'Judges one page of the open, unclaimed issues of a project with a rig, ordered by ' +
          'priority and then age, and returns the ones you may claim. The counts are about ' +
          'this page only. Read further pages until candidateTotal is passed: an empty page ' +
          'does not mean an empty pool.',
      },
    },
  )

  .post(
    '/projects/:projectKey/tracker/ready/claim',
    ({ project, user }) => claimReady(project.id, requireUser(user).id),
    {
      params: ProjectKeyParams,
      body: ReadyClaimBody,
      permission: ['work_items', 'edit'],
      response: { 200: ReadyClaimResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Claim the first ready issue',
        description:
          'Walks the ready pool in order and claims the first issue you may claim, for you. ' +
          'claimed is null when no issue in the pool may be claimed by you.',
      },
    },
  )

  .get(
    '/issues/:issueId/claim',
    ({ params, user }) => readClaim(params.issueId, requireUser(user).id),
    {
      params: ClaimParams,
      workItem: 'read',
      response: { 200: ClaimResponse, ...accessErrors },
      detail: {
        summary: 'Read the claim on an issue',
        description:
          'Returns who holds the claim on the issue, the claim epoch and when the claim lapses. ' +
          'Send the epoch as expectedEpoch when you claim, extend or release.',
        ...mcpTool('read_issue_claim'),
      },
    },
  )

  .post(
    '/issues/:issueId/claim',
    ({ params, body, user }) => takeClaim(params.issueId, requireUser(user).id, body.expectedEpoch),
    {
      params: ClaimParams,
      body: ClaimBody,
      workItem: 'edit',
      response: writeResponse,
      detail: {
        summary: 'Claim an issue',
        description:
          'Takes the claim on an issue that is unclaimed or whose claim has lapsed, for you. ' +
          'Fails with 409 when someone else holds a live claim (code claim-live-other-owner) or ' +
          'when expectedEpoch is not the current epoch (code claim-stale-epoch). The claim ' +
          'lapses after five minutes unless you extend it.',
        ...mcpTool('claim_issue'),
      },
    },
  )

  .post(
    '/issues/:issueId/claim/heartbeat',
    ({ params, body, user }) =>
      extendClaim(params.issueId, requireUser(user).id, body.expectedEpoch),
    {
      params: ClaimParams,
      body: ClaimBody,
      workItem: 'edit',
      response: writeResponse,
      detail: {
        summary: 'Extend your claim on an issue',
        description:
          'Extends your live claim by another five minutes. Fails with 409 when you do not hold ' +
          'the claim, when it has lapsed, or when expectedEpoch is not the current epoch.',
        ...mcpTool('extend_issue_claim'),
      },
    },
  )

  .post(
    '/issues/:issueId/claim/release',
    ({ params, body, user }) => dropClaim(params.issueId, requireUser(user).id, body.expectedEpoch),
    {
      params: ClaimParams,
      body: ClaimBody,
      workItem: 'edit',
      response: writeResponse,
      detail: {
        summary: 'Release your claim on an issue',
        description:
          'Drops your claim, lapsed or not, and adds one to the epoch. Fails with 409 when you ' +
          'do not hold the claim or when expectedEpoch is not the current epoch.',
        ...mcpTool('release_issue_claim'),
      },
    },
  );
