// Setup for tracker-close-request.test.ts: the disposable Git repository, artifact root and
// manifest, the session and person helpers, and the claim, column and close helpers.
// The test file registers cleanWork and cleanEach, so importing this file registers no hook.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import * as F from './tracker-labels-gate-fixtures';
import type { CloseRequest } from '../../close-facts';

const { updateIssue } = await import('../../service');
const { setSubtaskAutomationSettings } = await import('../../../projects/service');
const { authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');

// Removed by cleanWork. It holds the repository, the artifact root and the manifest copy.
const work = mkdtempSync(join(tmpdir(), 'tracker-close-request-'));
export const repo = join(work, 'repo');
const roots = join(work, 'roots');
const manifest = join(work, 'CONFIG.json');
mkdirSync(repo);
mkdirSync(roots);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'close-request@local');
git('config', 'user.name', 'Close Request');
writeFileSync(join(roots, 'report.md'), 'the report');
// The composed pins plus a close section for this run's synthetic rig only.
writeFileSync(
  manifest,
  JSON.stringify({
    ...JSON.parse(readFileSync(F.OWNER_CONFIG, 'utf8')),
    close: {
      rigs: {
        [F.RIG_PREFIX]: {
          repos: { fixture: { repoRoot: repo, targetRef: 'main' } },
          artifactRoots: [roots],
        },
      },
    },
  }),
);
export const cleanWork = () => rmSync(work, { recursive: true, force: true });
const people: string[] = [];
const signedUp: { userId: string; workspaceId: number | null }[] = [];
// An owner of the fixture project with a real session, for the PATCH route.
export async function session(f: F.GateFacts) {
  const user = await signUpTestUser({
    email: `zz-u4-close-${f.projectId}-${signedUp.length}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  await F.db.execute(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, 'owner')`,
  );
  return { api: authedApi(user.cookie), userId: user.userId };
}
export async function cleanEach() {
  await F.cleanUp();
  for (const { userId, workspaceId } of signedUp.splice(0)) {
    const drops = [
      ...(workspaceId === null
        ? []
        : [
            sql`DELETE FROM team WHERE workspace_id = ${workspaceId}`,
            sql`DELETE FROM workspace WHERE id = ${workspaceId}`,
          ]),
      sql`DELETE FROM "user" WHERE id = ${userId}`,
    ];
    for (const drop of drops)
      await F.db
        .execute(drop)
        .catch((error) => F.cleanupErrors.push(`sign-up ${userId}: ${error}`));
  }
  for (const id of people.splice(0))
    await F.db
      .execute(sql`DELETE FROM "user" WHERE id = ${id}`)
      .catch((error) => F.cleanupErrors.push(`user ${id}: ${error}`));
}
// A person who is no agent, so the routing rule has no lane to judge.
export async function person(f: F.GateFacts) {
  const id = `u4-closeperson-${f.projectId}`;
  await F.db.execute(sql`INSERT INTO "user" (id, name, username, email, email_verified)
    VALUES (${id}, 'Close Person', ${`closeperson${f.projectId}`}, ${`${id}@example.com`}, true)`);
  people.push(id);
  return id;
}

export const withCloseOwner = <T>(run: () => Promise<T>) =>
  F.withGateEnv([F.OWNER.python, F.OWNER.owner, manifest], run);
let files = 0;
export const commit = (subject: string) => {
  files += 1;
  writeFileSync(join(repo, `file-${files}.txt`), subject);
  git('add', '.');
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
};

type Stored = {
  column_id: number;
  title: string;
  assignee_user_id: string | null;
  claim_owner: string | null;
  claim_epoch: number | string;
};
export const storedOf = async (issueId: number) =>
  (
    (await F.db.execute(
      sql`SELECT column_id, title, assignee_user_id, claim_owner, claim_epoch
          FROM issue WHERE id = ${issueId}`,
    )) as unknown as Stored[]
  )[0];
let columns = 1;
export async function column(f: F.GateFacts, stateType: string, autoAssign: string | null = null) {
  columns += 1;
  const rows = (await F.db.execute(
    sql`INSERT INTO project_column (project_id, name, position, state_type, auto_assign_user_id)
        VALUES (${f.projectId}, ${`Close ${stateType} ${columns}`}, ${columns}, ${stateType}, ${autoAssign})
        RETURNING id`,
  )) as unknown as { id: number | string }[];
  return Number(rows[0].id);
}
// The claim as a claim writer leaves it: held under the holder's user id.
export const claim = (issueId: number, owner: string, epoch: number, lease: string) =>
  F.db.execute(
    sql`UPDATE issue SET claim_owner = ${owner}, claim_epoch = ${epoch},
               claim_expires_at = clock_timestamp() + ${lease}::interval
        WHERE id = ${issueId}`,
  );
// A gated card with a live claim by the fixture's actor at epoch 1, a completed column to close
// into, and a final commit for the card on the configured branch.
export async function setUp(tag: string) {
  const f = await F.fixture(true, tag);
  const card = await F.gatedCard(f, `Close ${tag}`);
  const done = await column(f, 'completed');
  await claim(card.issueId, f.actorId, 1, '5 minutes');
  const sha = commit(`${card.beadId}: the closing commit`);
  const request: CloseRequest = {
    kind: 'code',
    reason: 'landed',
    repo: 'fixture',
    sha,
    expectedEpoch: 1,
  };
  return { f, card, done, request };
}
// A second gated card under the first, with the cascade rules turned on for the project.
export async function family(f: F.GateFacts, parentId: number, childId: number) {
  await F.db.execute(sql`UPDATE issue SET parent_id = ${parentId} WHERE id = ${childId}`);
  await setSubtaskAutomationSettings(f.projectId, { completeParent: true, closeSubtasks: true });
}
export const snapshot = async (f: F.GateFacts, ...issueIds: number[]) => ({
  board: await F.board(f),
  cards: await Promise.all(issueIds.map(storedOf)),
  activity: await Promise.all(issueIds.map(F.activityOf)),
});
export const close = (
  issueId: number,
  patch: Parameters<typeof updateIssue>[1],
  actor: string | null,
  closeRequest: CloseRequest | undefined,
) => withCloseOwner(() => updateIssue(issueId, patch, actor, { closeRequest }));
