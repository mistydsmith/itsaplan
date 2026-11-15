import { db } from '@repo/db';
import type { CloseRequest } from './close-facts';
import { setIssueLabels, updateIssue } from './service';

type IssueFields = Parameters<typeof updateIssue>[1];
// The PATCH body without labelIds: the issue fields, plus the close request the body may carry.
type IssuePatch = IssueFields & { closeRequest?: CloseRequest };
type PatchedIssue = Awaited<ReturnType<typeof updateIssue>>;

// The PATCH /issues/:issueId write: the field update, then the label save when the body carries
// labelIds.
//
// WHY one transaction for every project (sentinel-prod-8364): each writer asks the rule owner on
// its own. Run one after the other on the pool, the field update commits before the label save is
// judged, so a body whose labels the owner refuses still changes the title or description and
// queues their side effects. Both writers run on one transaction with the same actor, so a refusal
// from either rolls back both and nothing is queued. Each writer still takes its own locks and
// asks the owner itself: this adds no second gate and skips none.
//
// No rig read picks a branch here. A read on the pool can be stale by the time the writers run,
// and a project that became gated in between would commit the first write and refuse the second.
// Each writer reads the rig on this transaction, so both judge the same project state.
export async function patchIssue(input: {
  projectId: number;
  issueId: number;
  patch: IssuePatch;
  labelIds: number[] | undefined;
  actorUserId: string;
}): Promise<PatchedIssue> {
  const { projectId, issueId, labelIds, actorUserId } = input;
  // The close request is not a field of the issue. It goes to updateIssue as an option, where the
  // closer is taken from actorUserId and never from the request.
  const { closeRequest, ...patch } = input.patch;
  if (labelIds === undefined) return updateIssue(issueId, patch, actorUserId, { closeRequest });
  return db.transaction(async (tx) => {
    const updated = await updateIssue(issueId, patch, actorUserId, {
      executor: tx,
      closeRequest,
    });
    if (!updated) return null;
    await setIssueLabels(projectId, issueId, labelIds, actorUserId, true, tx);
    updated.labelIds = labelIds;
    return updated;
  });
}
