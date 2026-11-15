// The import-job creation dispatch (Root P0 2026-11-15 module-guard repair):
// the per-source job-creation responsibilities moved whole from service.ts
// so the service monolith does not grow when a source (bd) joins the
// dispatch. Bodies, validation and the credential handling are
// byte-identical; the dispatch's one insertImportJob call stays in
// service.ts.
import { HttpError } from '#shared/lib';
import { bdJobFields, type CreateBdImportJobInput } from './bd';
import { linearJobFields, type CreateLinearImportJobInput } from './linear';
import { trelloJobFields, type CreateTrelloImportJobInput } from './trello';
import {
  insertImportJob,
  normalizePlaneBaseUrl,
  type CreatePlaneImportJobInput,
  type ImportJobChoices,
  type ImportJobDto,
} from './service';

export type CreateImportJobInput = ImportJobChoices &
  (
    | CreatePlaneImportJobInput
    | CreateLinearImportJobInput
    | CreateTrelloImportJobInput
    | CreateBdImportJobInput
  );

function planeJobFields(input: CreatePlaneImportJobInput) {
  const baseUrl = normalizePlaneBaseUrl(input.baseUrl);
  const workspaceSlug = input.workspaceSlug.trim();
  const apiToken = input.apiToken.trim();
  const planeProjectId = input.planeProjectId.trim();
  const planeProjectKey = input.planeProjectKey.trim();
  if (!workspaceSlug) throw new HttpError(400, 'workspaceSlug is required');
  if (!apiToken) throw new HttpError(400, 'apiToken is required');
  if (!planeProjectId) throw new HttpError(400, 'planeProjectId is required');
  if (!planeProjectKey) throw new HttpError(400, 'planeProjectKey is required');
  return {
    source: 'plane' as const,
    credential: { baseUrl, workspaceSlug, apiKey: apiToken },
    config: { planeProjectId, planeProjectKey },
  };
}

export async function createImportJob(
  projectId: number,
  actorUserId: string,
  input: CreateImportJobInput,
): Promise<ImportJobDto> {
  switch (input.source) {
    case 'linear':
      return insertImportJob(projectId, actorUserId, linearJobFields(input), input);
    case 'trello':
      return insertImportJob(
        projectId,
        actorUserId,
        await trelloJobFields(projectId, input),
        input,
      );
    case 'bd':
      // No credential to validate against a remote: the path is checked when the
      // connection test or the first worker tick reads it.
      return insertImportJob(projectId, actorUserId, bdJobFields(input), input);
    default:
      return insertImportJob(projectId, actorUserId, planeJobFields(input), input);
  }
}
