// The claim routes through the app with real sessions: the holder is the signed-in user, the
// body carries only the epoch, and a refusal leaves the stored claim as it was.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag. This file
// never calls resetDb: the signed-up users and the workspace sign-up gives each are removed by id.
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as F from '#modules/issues/__tests__/integration/tracker-labels-gate-fixtures';

const { authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');

const signedUp: { userId: string; workspaceId: number | null }[] = [];
let seq = 0;
// A person with a real session. `role` is their membership of the fixture project, null for none.
async function person(f: F.GateFacts, role: 'owner' | null) {
  seq += 1;
  const user = await signUpTestUser({
    email: `zz-u4-claim-${f.projectId}-${seq}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  if (role !== null)
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, ${role})`,
    );
  return { api: authedApi(user.cookie), userId: user.userId };
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

type Stored = { claim_owner: string | null; claim_epoch: number | string; live: boolean | null };
const storedOf = async (issueId: number) => {
  const [row] = (await F.db.execute(
    sql`SELECT claim_owner, claim_epoch, claim_expires_at > clock_timestamp() AS live
        FROM issue WHERE id = ${issueId}`,
  )) as unknown as Stored[];
  return { owner: row.claim_owner, epoch: Number(row.claim_epoch), live: row.live };
};
const codeOf = (error: unknown) =>
  String((error as { value?: { code?: string } } | null)?.value?.code ?? '');
async function setUp(tag: string) {
  const f = await F.fixture(false, tag);
  const card = await F.ordinaryCard(f, `Claim ${tag}`, 1);
  return {
    f,
    card,
    claims: (who: Awaited<ReturnType<typeof person>>) =>
      who.api.issues({ issueId: card.issueId }).claim,
  };
}

describe('8429 claim routes', () => {
  it('claims for the signed-in user, extends, reads and releases', async () => {
    const { f, card, claims } = await setUp('claim-ok');
    const holder = await person(f, 'owner');
    const unclaimed = await claims(holder).get();
    expect(unclaimed.data).toMatchObject({ owner: null, epoch: 0, expired: false, mine: false });

    const taken = await claims(holder).post({ expectedEpoch: 0 });
    expect(taken.status).toBe(200);
    expect(taken.data).toMatchObject({
      owner: holder.userId,
      epoch: 1,
      mine: true,
      unchanged: false,
    });
    expect(await storedOf(card.issueId)).toEqual({ owner: holder.userId, epoch: 1, live: true });

    // The same holder at the same epoch: nothing is written.
    const again = await claims(holder).post({ expectedEpoch: 1 });
    expect(again.data).toMatchObject({ epoch: 1, unchanged: true });

    const first = taken.data?.expiresAt as unknown as Date;
    const beat = await claims(holder).heartbeat.post({ expectedEpoch: 1 });
    expect(beat.status).toBe(200);
    expect(beat.data).toMatchObject({ owner: holder.userId, epoch: 1, mine: true });
    expect(new Date(beat.data?.expiresAt as unknown as Date).getTime()).toBeGreaterThanOrEqual(
      new Date(first).getTime(),
    );

    const read = await claims(holder).get();
    expect(read.data).toMatchObject({ owner: holder.userId, epoch: 1, expired: false, mine: true });

    const released = await claims(holder).release.post({ expectedEpoch: 1 });
    expect(released.status).toBe(200);
    expect(released.data).toMatchObject({ owner: null, epoch: 2, expiresAt: null, mine: false });
    expect(await storedOf(card.issueId)).toEqual({ owner: null, epoch: 2, live: null });
  }, 120_000);

  it('refuses a second user while the claim is live, and a stale epoch, writing nothing', async () => {
    const { f, card, claims } = await setUp('claim-other');
    const holder = await person(f, 'owner');
    const other = await person(f, 'owner');
    await claims(holder).post({ expectedEpoch: 0 });
    const stored = await storedOf(card.issueId);

    const taken = await claims(other).post({ expectedEpoch: 1 });
    expect([taken.status, codeOf(taken.error)]).toEqual([409, 'claim-live-other-owner']);
    const beat = await claims(other).heartbeat.post({ expectedEpoch: 1 });
    expect(beat.status).toBe(409);
    const released = await claims(other).release.post({ expectedEpoch: 1 });
    expect(released.status).toBe(409);
    const stale = await claims(holder).heartbeat.post({ expectedEpoch: 0 });
    expect([stale.status, codeOf(stale.error)]).toEqual([409, 'claim-stale-epoch']);
    expect(await storedOf(card.issueId)).toEqual(stored);

    // The other user reads the claim and sees it is not theirs.
    expect((await claims(other).get()).data).toMatchObject({ owner: holder.userId, mine: false });
  }, 120_000);

  it('claims for the session user when the body names another owner and a lease', async () => {
    const { f, card, claims } = await setUp('claim-forged');
    const holder = await person(f, 'owner');
    const other = await person(f, 'owner');
    // The schema lists expectedEpoch only; the extra properties never reach the service.
    const forged = {
      expectedEpoch: 0,
      owner: holder.userId,
      actor: holder.userId,
      leaseSeconds: 86_400,
    };
    const taken = await claims(other).post(forged as { expectedEpoch: number });
    expect(taken.status).toBe(200);
    expect(taken.data).toMatchObject({ owner: other.userId, mine: true });
    const [row] = (await F.db.execute(
      sql`SELECT claim_owner, claim_expires_at <= clock_timestamp() + interval '6 minutes' AS short
          FROM issue WHERE id = ${card.issueId}`,
    )) as unknown as { claim_owner: string; short: boolean }[];
    expect([row.claim_owner, row.short]).toEqual([other.userId, true]);
  }, 120_000);

  it('takes over a lapsed claim and refuses a heartbeat on it', async () => {
    const { f, card, claims } = await setUp('claim-lapsed');
    const holder = await person(f, 'owner');
    const other = await person(f, 'owner');
    await claims(holder).post({ expectedEpoch: 0 });
    await F.db.execute(
      sql`UPDATE issue SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${card.issueId}`,
    );
    expect((await claims(other).get()).data).toMatchObject({ owner: holder.userId, expired: true });
    const beat = await claims(holder).heartbeat.post({ expectedEpoch: 1 });
    expect(beat.status).toBe(409);
    const taken = await claims(other).post({ expectedEpoch: 1 });
    expect(taken.status).toBe(200);
    expect(taken.data).toMatchObject({ owner: other.userId, epoch: 2, mine: true });
  }, 120_000);

  it('refuses a caller with no access to the project and a missing issue', async () => {
    const { f, card, claims } = await setUp('claim-outsider');
    const outsider = await person(f, null);
    const stored = await storedOf(card.issueId);
    const taken = await claims(outsider).post({ expectedEpoch: 0 });
    expect([403, 404]).toContain(taken.status);
    const read = await claims(outsider).get();
    expect([403, 404]).toContain(read.status);
    expect(await storedOf(card.issueId)).toEqual(stored);
    const owner = await person(f, 'owner');
    const missing = await owner.api
      .issues({ issueId: 2_000_000_000 })
      .claim.post({ expectedEpoch: 0 });
    expect(missing.status).toBe(404);
  }, 120_000);

  it('resolves only the exact stored bead identity under the project access guard', async () => {
    const f = await F.fixture(true, 'lookup-exact');
    const card = await F.gatedCard(f, 'Exact identity lookup');
    if (!card.beadId) throw new Error('gated fixture has no bead identity');
    const holder = await person(f, 'owner');
    const outsider = await person(f, null);
    const before = await F.board(f);
    const claimBefore = await storedOf(card.issueId);
    const found = await holder.api.tracker.issues({ beadId: card.beadId }).get();
    expect(found.status).toBe(200);
    expect(found.data).toEqual({ id: card.issueId, beadId: card.beadId });
    for (const beadId of [card.beadId.toUpperCase(), `${card.beadId}x`, `${F.RIG_PREFIX}-999999999`]) {
      const missing = await holder.api.tracker.issues({ beadId }).get();
      expect(missing.status).toBe(404);
    }
    const denied = await outsider.api.tracker.issues({ beadId: card.beadId }).get();
    expect([403, 404]).toContain(denied.status);
    expect(await F.board(f)).toEqual(before);
    expect(await storedOf(card.issueId)).toEqual(claimBefore);
  }, 120_000);
});
