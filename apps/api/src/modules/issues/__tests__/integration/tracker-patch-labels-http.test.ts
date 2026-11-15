// PATCH /issues/:issueId on a rig-gated project, driven through the app with a real session: a
// body that carries fields and labelIds is one write. A refusal of the labels leaves the fields,
// the labels, the activity and the queued rows as they were, and a valid body commits once.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag. This file
// never calls resetDb: the signed-up users and the workspace sign-up gives each are removed by id.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { tempManifest } from '#tests/helpers/temp-manifest';
import * as F from './tracker-labels-gate-fixtures';

const { authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');

// The composed pins plus a synthetic routing section in a test-owned temp file. qwen2 is local
// here for the test only; it states nothing about the real lane. The copy is removed at process exit.
const ROUTED_MANIFEST = tempManifest('tracker-patch-labels-', {
  ...JSON.parse(readFileSync(F.OWNER_CONFIG, 'utf8')),
  routing: { lanes: { qwen2: { execution: 'local' } } },
}).path;
const withRoutedOwner = <T>(run: () => Promise<T>) =>
  F.withGateEnv([F.OWNER.python, F.OWNER.owner, ROUTED_MANIFEST], run);

const LL_BLOCK = [
  'LAW LIBRARY COMPLIANCE:',
  "(a) SOURCES ARE SETTLED: Misty's source ruling for this card, pasted verbatim.",
  '(b) text source, comment source, act window all verified for the code touched.',
  '(c) no comment rows touched.',
  '(d) byte copy, never retyped.',
].join('\n');

const signedUp: { userId: string; workspaceId: number | null }[] = [];
let seq = 0;
// A person with a real session. `owner` makes them an owner of the fixture project, which is the
// membership the route's guard reads.
async function person(f: F.GateFacts, owner: boolean) {
  seq += 1;
  const user = await signUpTestUser({
    email: `zz-u4-patch-${f.projectId}-${seq}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  if (owner)
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, 'owner')`,
    );
  return authedApi(user.cookie);
}

afterEach(async () => {
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
});

type Stored = { title: string; description: string | null };
const storedOf = async (issueId: number) =>
  (
    (await F.db.execute(
      sql`SELECT title, description FROM issue WHERE id = ${issueId}`,
    )) as unknown as Stored[]
  )[0];
const small = (f: F.GateFacts) => [{ labelId: f.small, name: F.SIZE_SMALL }];
const messageOf = (error: unknown) =>
  String((error as { value?: { error?: string } } | null)?.value?.error ?? '');

describe('8364 PATCH /issues/:issueId with labelIds', () => {
  it('writes nothing when the labels in a mixed body are refused', async () => {
    const f = await F.fixture(true, 'patch-size');
    const card = await F.gatedCard(f, 'Mixed refused');
    const owner = await person(f, true);
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    // The title change alone is allowed. Dropping the only size label is not.
    const res = await F.withOwner(() =>
      owner
        .issues({ issueId: card.issueId })
        .patch({ title: `${card.title} retitled`, labelIds: [f.plain] }),
    );
    expect(res.status).toBe(409);
    expect(messageOf(res.error)).toStartWith('size:');
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.linksOf(card.issueId)).toEqual(small(f));
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('writes nothing when a mixed body moves a card that names a Qwen lane into law-library', async () => {
    const f = await F.fixture(true, 'patch-law');
    const card = await F.gatedCard(f, 'Mixed law move');
    await F.laneAgent(f, 'qwen2');
    await F.storeDescription(card.issueId, `${LL_BLOCK}\nStored note for @qwen2.`);
    const owner = await person(f, true);
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const res = await withRoutedOwner(() =>
      owner
        .issues({ issueId: card.issueId })
        .patch({ title: `${card.title} retitled`, labelIds: [f.small, f.law] }),
    );
    expect(res.status).toBe(409);
    expect(messageOf(res.error)).toStartWith('lane-routing:');
    expect(messageOf(res.error)).toContain(
      "lane 'qwen2' is refused on law-library or legal-template work",
    );
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.linksOf(card.issueId)).toEqual(small(f));
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('refuses the same law-library move sent as labels only', async () => {
    const f = await F.fixture(true, 'patch-law-only');
    const card = await F.gatedCard(f, 'Label only law move');
    await F.laneAgent(f, 'qwen2');
    await F.storeDescription(card.issueId, `${LL_BLOCK}\nStored note for @qwen2.`);
    const owner = await person(f, true);
    const before = await F.board(f);
    const res = await withRoutedOwner(() =>
      owner.issues({ issueId: card.issueId }).patch({ labelIds: [f.small, f.law] }),
    );
    expect(res.status).toBe(409);
    expect(messageOf(res.error)).toContain(
      "lane 'qwen2' is refused on law-library or legal-template work",
    );
    expect(await F.linksOf(card.issueId)).toEqual(small(f));
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('writes nothing when the project becomes gated while a mixed body is being saved', async () => {
    // The project is ordinary when the request starts. An activation holds the project row, the
    // field update waits on it, and the activation commits first.
    const f = await F.fixture(false, 'patch-race');
    const card = await F.ordinaryCard(f, 'Mixed during activation', 1);
    const owner = await person(f, true);
    const rig = await F.sharedRig();
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const links = await F.linksOf(card.issueId);
    const outcome = await F.activationRace(f.projectId, rig, 'commit', async () => {
      const res = await F.withOwner(() =>
        owner
          .issues({ issueId: card.issueId })
          .patch({ title: `${card.title} retitled`, labelIds: [f.large] }),
      );
      if (res.status !== 200) {
        const refusal: F.Refusal = { status: res.status, message: messageOf(res.error) };
        throw refusal;
      }
    }).finally(() => F.resetRig(f));
    expect(outcome.blockedByOther).toBeGreaterThan(0);
    expect(outcome.saved).toBe(false);
    expect(outcome.refusal?.status).toBe(409);
    expect(outcome.refusal?.message).toContain('changed its rig');
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.linksOf(card.issueId)).toEqual(links);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('writes nothing for a person who is not in the project', async () => {
    const f = await F.fixture(true, 'patch-outsider');
    const card = await F.gatedCard(f, 'Outsider');
    const outsider = await person(f, false);
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const res = await F.withOwner(() =>
      outsider
        .issues({ issueId: card.issueId })
        .patch({ title: `${card.title} retitled`, labelIds: [f.large] }),
    );
    expect([403, 404]).toContain(res.status);
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.linksOf(card.issueId)).toEqual(small(f));
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('commits a valid mixed body once and answers with the final labels', async () => {
    const f = await F.fixture(true, 'patch-ok');
    const card = await F.gatedCard(f, 'Mixed allowed');
    const owner = await person(f, true);
    const before = await F.board(f);
    // The card was created with the small label, so its activity already holds that label_add.
    const actsBefore = await F.activityOf(card.issueId);
    const title = `${card.title} retitled`;
    const res = await F.withOwner(() =>
      owner.issues({ issueId: card.issueId }).patch({ title, labelIds: [f.large] }),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: card.issueId, title, labelIds: [f.large] });
    expect((await storedOf(card.issueId)).title).toBe(title);
    expect(await F.linksOf(card.issueId)).toEqual([{ labelId: f.large, name: F.SIZE_LARGE }]);
    const after = await F.board(f);
    // The fixture's webhook subscribes to issue.label_changed only: one label save, one delivery.
    expect(after.deliveries).toBe(before.deliveries + 1);
    // The earlier entries are unchanged, and the label save appended exactly one add and one remove.
    const acts = await F.activityOf(card.issueId);
    expect(acts.slice(0, actsBefore.length)).toEqual(actsBefore);
    expect(acts.slice(actsBefore.length).filter((act) => act.action.startsWith('label_'))).toEqual([
      { action: 'label_add', from: null, to: F.SIZE_LARGE },
      { action: 'label_remove', from: F.SIZE_SMALL, to: null },
    ]);
    expect(after.labels).toBe(before.labels);
    expect(after.issues).toBe(before.issues);
  }, 120_000);
});
