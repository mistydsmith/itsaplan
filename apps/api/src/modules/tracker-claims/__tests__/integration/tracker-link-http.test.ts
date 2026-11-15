// Link and unlink of two issues on a project with a rig, through the app with real sessions and
// the pinned rule owner. Every case reads the stored relation and the activity after the call.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag. This file
// never calls resetDb: the signed-up users and the workspace sign-up gives each are removed by id.
// The one row it leaves is the imported ledger row of the mismatch card, which the schema forbids
// deleting, in the synthetic rig the fixtures keep.
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as F from '#modules/issues/__tests__/integration/tracker-labels-gate-fixtures';

const { authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');

const signedUp: { userId: string; workspaceId: number | null }[] = [];
let seq = 0;
// A person with a real session in the fixture project. An 'owner' row is the coordinator role;
// a 'member' row with no role id holds the default member permissions and is a worker. A person
// has no ai_agent row, so the routing facts carry no lane.
async function person(f: F.GateFacts, role: 'owner' | 'member') {
  seq += 1;
  const user = await signUpTestUser({
    email: `zz-u4-link-${f.projectId}-${seq}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  await F.db.execute(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, ${role})`,
  );
  return { api: authedApi(user.cookie), userId: user.userId };
}
type Person = Awaited<ReturnType<typeof person>>;

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

async function all<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await F.db.execute(query)) as unknown as T[];
}
type Failure = { value?: { code?: string; error?: string } } | null;
const codeOf = (error: unknown) => String((error as Failure)?.value?.code ?? '');
const textOf = (error: unknown) => String((error as Failure)?.value?.error ?? '');

// The stored relations between two issues, in either direction, and the link activity of both.
async function stateOf(a: number, b: number) {
  const links = await all<{ id: number | string }>(
    sql`SELECT id FROM issue_link
        WHERE (source_issue_id = ${a} AND target_issue_id = ${b})
           OR (source_issue_id = ${b} AND target_issue_id = ${a})`,
  );
  const actions = [...(await F.activityOf(a)), ...(await F.activityOf(b))]
    .map((entry) => entry.action)
    .filter((action) => action.startsWith('link_'));
  return { links: links.length, actions };
}
const NOTHING = { links: 0, actions: [] as string[] };
const LINKED = { links: 1, actions: ['link_add', 'link_add'] };

// A project with a rig and Task cards a worker can claim.
async function rig(tag: string, count: number) {
  const f = await F.fixture(true, tag);
  const [task] = await all<{ id: number }>(
    sql`INSERT INTO issue_type (project_id, name) VALUES (${f.projectId}, 'Task') RETURNING id`,
  );
  const cards: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const made = await F.gatedCard(f, `zz-private-link-${index}-${f.projectId}`);
    await F.db.execute(sql`UPDATE issue SET type_id = ${task.id} WHERE id = ${made.issueId}`);
    cards.push(made.issueId);
  }
  return { f, cards };
}
const linksOf = (who: Person, issueId: number) => who.api.issues({ issueId }).links;
const link = (who: Person, issueId: number, targetIssueId: number, epochs = {}) =>
  linksOf(who, issueId).post({ targetIssueId, kind: 'blocks', ...epochs });
const unlink = (who: Person, issueId: number, linkId: number, query = {}) =>
  who.api.issues({ issueId }).links({ linkId }).delete(undefined, { query });
async function claim(who: Person, issueId: number, expectedEpoch = 0) {
  const taken = await who.api.issues({ issueId }).claim.post({ expectedEpoch });
  expect([taken.status, textOf(taken.error)]).toEqual([200, '']);
  return Number(taken.data?.epoch);
}
const REFUSED = [409, 'tracker-rules-violation'];

describe('link and unlink on a project with a rig', () => {
  it('lets a coordinator link and unlink unclaimed backlog with no epochs', async () => {
    const { f, cards } = await rig('coordinator', 2);
    const coordinator = await person(f, 'owner');
    await F.withOwner(async () => {
      const made = await link(coordinator, cards[0], cards[1]);
      expect([made.status, textOf(made.error)]).toEqual([201, '']);
      expect(await stateOf(cards[0], cards[1])).toEqual(LINKED);
      const removed = await unlink(coordinator, cards[1], Number(made.data?.id));
      expect(removed.status).toBe(204);
    });
    expect(await stateOf(cards[0], cards[1])).toEqual({
      links: 0,
      actions: ['link_add', 'link_remove', 'link_add', 'link_remove'],
    });
  }, 240_000);

  it('lets a worker link and unlink two cards it holds live, with both epochs', async () => {
    const { f, cards } = await rig('worker', 2);
    const worker = await person(f, 'member');
    await F.withOwner(async () => {
      const expectedEpoch = await claim(worker, cards[0]);
      const targetExpectedEpoch = await claim(worker, cards[1]);
      const made = await link(worker, cards[0], cards[1], { expectedEpoch, targetExpectedEpoch });
      expect([made.status, textOf(made.error)]).toEqual([201, '']);
      expect(await stateOf(cards[0], cards[1])).toEqual(LINKED);
      // The unlink names the other issue in the path, so the two epochs swap ends.
      const removed = await unlink(worker, cards[1], Number(made.data?.id), {
        expectedEpoch: targetExpectedEpoch,
        targetExpectedEpoch: expectedEpoch,
      });
      expect(removed.status).toBe(204);
    });
    expect((await stateOf(cards[0], cards[1])).links).toBe(0);
  }, 240_000);

  it('refuses a worker link unless both ends are its own live leases at the epochs sent', async () => {
    const { f, cards } = await rig('worker-refused', 4);
    const [mine, free, theirs, lapsed] = cards;
    const worker = await person(f, 'member');
    const other = await person(f, 'member');
    await F.withOwner(async () => {
      const epoch = await claim(worker, mine);
      const otherEpoch = await claim(other, theirs);
      const lapsedEpoch = await claim(worker, lapsed);
      await F.db.execute(
        sql`UPDATE issue SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lapsed}`,
      );
      const attempts = [
        // The target is unclaimed.
        [free, { expectedEpoch: epoch, targetExpectedEpoch: 0 }],
        // Another user holds the target.
        [theirs, { expectedEpoch: epoch, targetExpectedEpoch: otherEpoch }],
        // The target lease has lapsed.
        [lapsed, { expectedEpoch: epoch, targetExpectedEpoch: lapsedEpoch }],
      ] as const;
      for (const [target, epochs] of attempts) {
        const refused = await link(worker, mine, target, epochs);
        expect([refused.status, codeOf(refused.error)]).toEqual(REFUSED);
        // The refusal names the rule and repeats no card text.
        expect(textOf(refused.error)).not.toContain('zz-private');
        expect(await stateOf(mine, target)).toEqual(NOTHING);
      }
    });
  }, 240_000);

  it('refuses a worker that holds both ends but sends a stale epoch or none', async () => {
    const { f, cards } = await rig('worker-epoch', 2);
    const worker = await person(f, 'member');
    await F.withOwner(async () => {
      const expectedEpoch = await claim(worker, cards[0]);
      const targetExpectedEpoch = await claim(worker, cards[1]);
      for (const epochs of [
        {},
        { expectedEpoch },
        { expectedEpoch, targetExpectedEpoch: targetExpectedEpoch + 1 },
        { expectedEpoch: expectedEpoch + 1, targetExpectedEpoch },
      ]) {
        const refused = await link(worker, cards[0], cards[1], epochs);
        expect([refused.status, codeOf(refused.error)]).toEqual(REFUSED);
        expect(await stateOf(cards[0], cards[1])).toEqual(NOTHING);
      }
    });
  }, 240_000);

  it('judges an unlink by the same rule and keeps the relation on a refusal', async () => {
    const { f, cards } = await rig('unlink', 2);
    const coordinator = await person(f, 'owner');
    const worker = await person(f, 'member');
    await F.withOwner(async () => {
      const made = await linksOf(coordinator, cards[0]).post({
        targetIssueId: cards[1],
        kind: 'relates',
      });
      const linkId = Number(made.data?.id);
      const expectedEpoch = await claim(worker, cards[0]);
      // One end held, the other free.
      const oneEnd = await unlink(worker, cards[0], linkId, { expectedEpoch });
      expect([oneEnd.status, codeOf(oneEnd.error)]).toEqual(REFUSED);
      const targetExpectedEpoch = await claim(worker, cards[1]);
      // Both held, one epoch stale.
      const stale = await unlink(worker, cards[0], linkId, {
        expectedEpoch,
        targetExpectedEpoch: targetExpectedEpoch + 1,
      });
      expect([stale.status, codeOf(stale.error)]).toEqual(REFUSED);
      expect(await stateOf(cards[0], cards[1])).toEqual(LINKED);
      const removed = await unlink(worker, cards[0], linkId, {
        expectedEpoch,
        targetExpectedEpoch,
      });
      expect(removed.status).toBe(204);
      // A link id that is no relation of the issue is not found, as on a project with no rig.
      const gone = await unlink(coordinator, cards[0], linkId);
      expect(gone.status).toBe(404);
    });
    expect((await stateOf(cards[0], cards[1])).links).toBe(0);
  }, 240_000);

  it('judges the unlink of a relation that outlived a move, in both projects', async () => {
    const { f, cards } = await rig('moved', 2);
    const elsewhere = await F.fixture(true, 'moved-to');
    const both = await person(f, 'owner');
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${elsewhere.projectId}, ${both.userId}, 'owner')`,
    );
    const ownerHere = await person(f, 'owner');
    const memberThere = await person(f, 'owner');
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${elsewhere.projectId}, ${memberThere.userId}, 'member')`,
    );
    await F.withOwner(async () => {
      const made = await link(both, cards[0], cards[1]);
      const linkId = Number(made.data?.id);
      // The second card is moved on the row: the relation and both bead ids stay as stored.
      await F.db.execute(
        sql`UPDATE issue SET project_id = ${elsewhere.projectId}, column_id = ${elsewhere.columnId},
                sequence_number = 9100 WHERE id = ${cards[1]}`,
      );
      // A new relation across two projects is still refused.
      const across = await link(both, cards[0], cards[1], { kind: 'relates' });
      expect(across.status).toBe(400);
      // An owner of one project with no access to the other is not authorized.
      const noAccess = await unlink(ownerHere, cards[0], linkId);
      expect([noAccess.status, codeOf(noAccess.error)]).toEqual(REFUSED);
      // An owner of one project and member of the other is a worker and holds no lease.
      const asWorker = await unlink(memberThere, cards[0], linkId);
      expect([asWorker.status, codeOf(asWorker.error)]).toEqual(REFUSED);
      expect(await stateOf(cards[0], cards[1])).toEqual(LINKED);
      const removed = await unlink(both, cards[0], linkId);
      expect(removed.status).toBe(204);
    });
    expect((await stateOf(cards[0], cards[1])).links).toBe(0);
  }, 240_000);

  it('takes no actor, role or authorization from the body', async () => {
    const { f, cards } = await rig('forged', 2);
    const coordinator = await person(f, 'owner');
    const worker = await person(f, 'member');
    const forged = {
      actor: coordinator.userId,
      actorRole: 'coordinator',
      actor_role: 'operator',
      authorized: true,
      link_facts: { actor_role: 'operator', authorized: true },
    };
    await F.withOwner(async () => {
      const refused = await link(worker, cards[0], cards[1], forged);
      // The schema refuses the extra fields, or strips them. Either way they are never read.
      if (refused.status === 409) expect(codeOf(refused.error)).toBe('tracker-rules-violation');
      else expect([400, 422]).toContain(refused.status);
    });
    expect(await stateOf(cards[0], cards[1])).toEqual(NOTHING);
  }, 240_000);

  it('refuses an end whose bead id the ledger does not prove', async () => {
    const { f, cards } = await rig('identity', 1);
    const p = f.projectId;
    const coordinator = await person(f, 'owner');
    // A card inserted with no bead id: it holds no ledger row.
    const bare = (await F.ordinaryCard(f, `zz-private-bare-${p}`, 9001)).issueId;
    // A card whose issue column and ledger row name two different bead ids.
    const mismatch = (await F.ordinaryCard(f, `zz-private-mismatch-${p}`, 9002)).issueId;
    await F.db.execute(
      sql`UPDATE issue SET bead_id = ${`${F.RIG_PREFIX}-linkmis-a-${p}`} WHERE id = ${mismatch}`,
    );
    await F.db.execute(
      sql`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
          VALUES (${f.rigId}, ${`linkmis-b-${p}`}, 'imported', ${mismatch})`,
    );
    await F.withOwner(async () => {
      for (const [source, target, code] of [
        [cards[0], bare, 'issue-without-identity'],
        [bare, cards[0], 'issue-without-identity'],
        [cards[0], mismatch, 'issue-identity-mismatch'],
        [mismatch, cards[0], 'issue-identity-mismatch'],
      ] as const) {
        const refused = await link(coordinator, source, target);
        expect([refused.status, codeOf(refused.error)]).toEqual([409, code]);
        expect(textOf(refused.error)).not.toContain('zz-private');
        expect(await stateOf(source, target)).toEqual(NOTHING);
      }
    });
  }, 240_000);

  it('writes nothing when the rule config is missing', async () => {
    const { f, cards } = await rig('unconfigured', 2);
    const coordinator = await person(f, 'owner');
    await F.withNoConfig(async () => {
      const refused = await link(coordinator, cards[0], cards[1]);
      expect(refused.status).toBe(409);
      expect(codeOf(refused.error).startsWith('tracker-rules-')).toBe(true);
      expect(codeOf(refused.error)).not.toBe('tracker-rules-violation');
    });
    expect(await stateOf(cards[0], cards[1])).toEqual(NOTHING);
  }, 240_000);

  it('keeps the plain writers on a project with no rig', async () => {
    const f = await F.fixture(false, 'ordinary-link');
    const a = (await F.ordinaryCard(f, 'Ordinary link a', 1)).issueId;
    const b = (await F.ordinaryCard(f, 'Ordinary link b', 2)).issueId;
    const member = await person(f, 'member');
    // No rule config at all: a project with no rig never asks the owner.
    await F.withNoConfig(async () => {
      const made = await link(member, a, b);
      expect([made.status, textOf(made.error)]).toEqual([201, '']);
      expect(made.data).toMatchObject({ kind: 'blocks', direction: 'outward', issue: { id: b } });
      const again = await link(member, a, b);
      expect(again.status).toBe(409);
      const self = await link(member, a, a);
      expect(self.status).toBe(400);
      expect(await stateOf(a, b)).toEqual(LINKED);
      const removed = await unlink(member, b, Number(made.data?.id));
      expect(removed.status).toBe(204);
      const gone = await unlink(member, b, Number(made.data?.id));
      expect(gone.status).toBe(404);
    });
    expect((await stateOf(a, b)).links).toBe(0);
  }, 120_000);
});
