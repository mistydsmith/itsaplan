import { Elysia, t } from 'elysia';
import { authContext } from '#shared/auth-context';
import { guards, entityGuard, assertMcpAllowed, requiresPermission } from '#shared/guards';
import { assertPermission, requireUser } from '#shared/access';
import { HttpError } from '#shared/lib';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import {
  ImportJobResponse,
  TestConnectionResponse,
  PlanePreviewResponse,
  LinearTestConnectionResponse,
  LinearPreviewResponse,
  TrelloTestConnectionResponse,
  TrelloPreviewResponse,
  BdTestConnectionResponse,
  BdPreviewResponse,
  ProjectExportResponse,
  createImportJobBody,
  importJobParams,
  testConnectionBody,
  planePreviewBody,
  linearConnectionBody,
  linearPreviewBody,
  trelloConnectionBody,
  trelloPreviewBody,
  bdConnectionBody,
  bdPreviewBody,
} from './model';
import { createImportJob } from './job-creation';
import {
  cancelImportJob,
  getImportJobDto,
  getImportJobProjectId,
  listImportJobs,
  pauseImportJob,
  resumeImportJob,
  testPlaneConnection,
  testPlaneStatesPreview,
} from './service';
import { exportProject } from './export';
import { previewLinearStates, testLinearConnection } from './linear';
import { previewTrelloBoard, testTrelloConnection } from './trello';
import {
  previewBdBoard,
  redactBdJobError,
  requireBdOperator,
  requireBdResumeOperator,
  testBdConnection,
} from './bd';

// Import jobs bring issues from an external tracker into a project. Creating one
// stores an encrypted credential and leaves it 'pending' for the worker
// (apps/worker/src/import-worker.ts) to drive through its phases; this module never
// touches the worker's queue directly, only the import_job/import_record rows it reads
// and writes too.

export const importExportRoutes = new Elysia({
  name: 'import-export',
  detail: { tags: ['Import/Export'] },
})
  .use(authContext)
  .use(guards)
  .macro({
    importJobEntity: entityGuard('import_export', 'Import job not found', (p) =>
      getImportJobProjectId(Number(p.id)),
    ),
  })

  .post(
    '/projects/:projectKey/import-jobs/test-connection',
    ({ body }) => testPlaneConnection(body.baseUrl, body.workspaceSlug, body.apiToken),
    {
      permission: ['import_export', 'create'],
      body: testConnectionBody,
      response: { 200: TestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test a Plane connection',
        description:
          'Validate a base URL, workspace slug, and API token against the source live, without ' +
          'storing anything. Returns the projects of the workspace to pick a source project from.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/plane-preview',
    ({ body }) =>
      testPlaneStatesPreview(body.baseUrl, body.workspaceSlug, body.apiToken, body.planeProjectId),
    {
      permission: ['import_export', 'create'],
      body: planePreviewBody,
      response: { 200: PlanePreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview a Plane project before importing it',
        description:
          "Fetch the source project's states, each with the category itsaplan would " +
          'automatically map it to, for review before a job is created.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/linear-test-connection',
    ({ body }) => testLinearConnection(body.apiToken),
    {
      permission: ['import_export', 'create'],
      body: linearConnectionBody,
      response: { 200: LinearTestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test a Linear API key',
        description:
          'Validate a Linear personal API key live, without storing anything. Returns the ' +
          'teams it can see, each with its projects, to pick what to import from.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/linear-preview',
    ({ body }) => previewLinearStates(body.apiToken, body.teamId),
    {
      permission: ['import_export', 'create'],
      body: linearPreviewBody,
      response: { 200: LinearPreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview a Linear team before importing from it',
        description:
          "Fetch the team's workflow states, each with the category itsaplan would " +
          'automatically map it to, for review before a job is created.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/trello-test-connection',
    ({ body }) => testTrelloConnection(body),
    {
      permission: ['import_export', 'create'],
      body: trelloConnectionBody,
      response: { 200: TrelloTestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test a Trello API key and token',
        description:
          'Validate a Trello API key and token live, without storing anything. Returns the ' +
          'boards they can see, to pick one to import from.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/trello-preview',
    ({ body }) => previewTrelloBoard(body),
    {
      permission: ['import_export', 'create'],
      body: trelloPreviewBody,
      response: { 200: TrelloPreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview a Trello board before importing it',
        description:
          "Fetch the board's open lists, each with the category itsaplan would automatically " +
          'map it to, and its members, for review before a job is created.',
      },
    },
  )

  // The bd board is server-global (D2 R2): the instance operator ('god') is
  // required IN ADDITION TO the project permission.
  .post(
    '/projects/:projectKey/import-jobs/bd-test-connection',
    ({ user }) => {
      requireBdOperator(user);
      return testBdConnection();
    },
    {
      permission: ['import_export', 'create'],
      body: bdConnectionBody,
      response: { 200: BdTestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test the server-configured bd board',
        description:
          'Read the board the operator configured (BD_IMPORT_BOARD_ROOT) read-only with bd ' +
          '(the same command the worker adapter runs) without storing anything. Returns its ' +
          'card count and the states the import would create. The body carries no path and ' +
          'no command: the board is privileged server config.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/bd-preview',
    ({ user }) => {
      requireBdOperator(user);
      return previewBdBoard();
    },
    {
      permission: ['import_export', 'create'],
      body: bdPreviewBody,
      response: { 200: BdPreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview the server-configured bd board before importing it',
        description:
          "Read the board's cards with bd and return its states, each with the category " +
          'the import would map it to, for review before a job is created.',
      },
    },
  )

  .get('/projects/:projectKey/import-jobs/export', ({ project }) => exportProject(project.id), {
    permission: ['import_export', 'create'],
    response: { 200: ProjectExportResponse, ...accessErrors },
    detail: {
      summary: "Export a project's data",
      description:
        "A self-contained snapshot of the project's states, labels, cycles, and issues " +
        '(with their comments and relations), as portable JSON. Not a live sync to any ' +
        'target — a download.',
    },
  })

  .post(
    '/projects/:projectKey/import-jobs',
    ({ project, body, user, set }) => {
      // A bd job reads the server-global board: the operator guard applies to
      // the bd source ONLY (D2 R2); the project permission still applies to
      // every source.
      if (body.source === 'bd') requireBdOperator(user);
      set.status = 201;
      return createImportJob(project.id, requireUser(user).id, body);
    },
    {
      permission: ['import_export', 'create'],
      body: createImportJobBody,
      response: { 201: ImportJobResponse, ...commonErrors },
      detail: {
        summary: 'Create an import job',
        description:
          "Create a Plane job, a Linear one with source 'linear', a Trello one with source " +
          "'trello', or a local bd one with source 'bd'. Encrypt and store the submitted " +
          "credential (a bd job carries none) and leave the job 'pending' " +
          'for the worker.',
      },
    },
  )

  .get(
    '/projects/:projectKey/import-jobs',
    async ({ project, user }) => {
      const jobs = await listImportJobs(project.id);
      return jobs.map((job) => redactBdJobError(job, user));
    },
    {
      permission: ['import_export', 'read'],
      response: { 200: t.Array(ImportJobResponse), ...accessErrors },
      detail: { summary: "List a project's import jobs" },
    },
  )

  // Fetches the row itself and asserts on it, like GET /issues/:issueId — the entity
  // guard would resolve the project id with a second query this handler doesn't need.
  .get(
    '/import-jobs/:id',
    async ({ params, user, request }) => {
      const job = await getImportJobDto(params.id);
      if (!job) throw new HttpError(404, 'Import job not found');
      await assertPermission(job.projectId, user, 'import_export', 'read');
      await assertMcpAllowed(job.projectId, request.headers);
      return redactBdJobError(job, user);
    },
    {
      params: importJobParams,
      response: { 200: ImportJobResponse, ...commonErrors },
      detail: {
        summary: 'Get an import job',
        description: 'Get the status and per-entity progress counts of an import job.',
        ...requiresPermission(['import_export', 'read']),
      },
    },
  )

  // CT review 2026-11-15 (Root msg_d1d642d0af0a): pause and cancel return the
  // fresh DTO, which can carry a stored bd lastError from the previous step -
  // the same leak the list/get readers already redact for non-operators.
  // Wrap BOTH responses with redactBdJobError(job, user); the error paths
  // (404/409) and the other sources are untouched.
  .post(
    '/import-jobs/:id/pause',
    async ({ params, user }) => {
      const job = await pauseImportJob(params.id);
      return redactBdJobError(job, user);
    },
    {
      params: importJobParams,
      importJobEntity: 'edit',
      response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
      detail: { summary: 'Pause an import job' },
    },
  )

  // Resume restarts the bd export for a stored bd job: the STORED source, not
  // any body claim, triggers the operator guard (Root 2026-11-15).
  .post(
    '/import-jobs/:id/resume',
    async ({ params, user }) => {
      const job = await getImportJobDto(params.id);
      if (job) requireBdResumeOperator(user, job.source);
      return resumeImportJob(params.id);
    },
    {
      params: importJobParams,
      importJobEntity: 'edit',
      response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
      detail: { summary: 'Resume a paused import job' },
    },
  )

  .post(
    '/import-jobs/:id/cancel',
    async ({ params, user }) => {
      const job = await cancelImportJob(params.id);
      return redactBdJobError(job, user);
    },
    {
      params: importJobParams,
      importJobEntity: 'edit',
      response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
      detail: { summary: 'Cancel an import job' },
    },
  );
