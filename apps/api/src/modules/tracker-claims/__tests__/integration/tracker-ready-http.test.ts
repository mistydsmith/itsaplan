// The claim of an issue on a project with a rig, and the two ready routes, through the app with
// real sessions and the pinned rule owner. Every case reads the stored lease after the call.
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
// A person with a real session who owns the fixture project. A person has no ai_agent row, so
// the routing facts carry no lane and the pinned manifest needs no routing section.
async function owner(f: F.GateFacts) {
  seq += 1;
  const user = await signUpTestUser({
    email: `zz-u4-ready-${f.projectId}-${seq}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  await F.db.execute(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, 'owner')`,
  );
  return { api: authedApi(user.cookie), userId: user.userId };
}
type Person = Awaited<ReturnType<typeof owner>>;

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

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await F.db.execute(query)) as unknown as T[])[0];
}
const idOf = async (query: ReturnType<typeof sql>) =>
  Number((await one<{ id: number | string }>(query)).id);

type Stored = { claim_owner: string | null; claim_epoch: number | string; live: boolean | null };
const storedOf = async (issueId: number) => {
  const row = await one<Stored>(
    sql`SELECT claim_owner, claim_epoch, claim_expires_at > clock_timestamp() AS live
        FROM issue WHERE id = ${issueId}`,
  );
  return { owner: row.claim_owner, epoch: Number(row.claim_epoch), live: row.live };
};
const UNCLAIMED = { owner: null, epoch: 0, live: null };
type Failure = { value?: { code?: string; error?: string } } | null;
const codeOf = (error: unknown) => String((error as Failure)?.value?.code ?? '');
const textOf = (error: unknown) => String((error as Failure)?.value?.error ?? '');

// One project with a rig and twelve cards, made in the order the ready pool lists them. The
// comment on each card is what the pool answers for it.
async function pool(tag: string) {
  const f = await F.fixture(true, tag);
  const p = f.projectId;
  const { key } = await one<{ key: string }>(sql`SELECT key FROM project WHERE id = ${p}`);
  const type = (name: string) =>
    idOf(sql`INSERT INTO issue_type (project_id, name) VALUES (${p}, ${name}) RETURNING id`);
  const column = (name: string, state: string, position: number) =>
    idOf(sql`INSERT INTO project_column (project_id, name, state_type, position)
             VALUES (${p}, ${name}, ${state}, ${position}) RETURNING id`);
  const task = await type('Task');
  const epic = await type('Epic');
  const story = await type('Story');
  const blockedColumn = await column('Blocked', 'unstarted', 2);
  const doneColumn = await column('Done', 'completed', 3);
  const marker = await idOf(
    sql`INSERT INTO label (project_id, name, color) VALUES (${p}, 'operator-owned', '#123456') RETURNING id`,
  );
  // Each title is distinct, so a refusal that repeats card text is found by its title.
  const title = (name: string) => `zz-private-${name}-${p}`;
  const card = async (name: string, typeId: number, columnId = f.columnId) => {
    const made = await F.gatedCard(f, title(name));
    await F.db.execute(
      sql`UPDATE issue SET type_id = ${typeId}, column_id = ${columnId} WHERE id = ${made.issueId}`,
    );
    return made.issueId;
  };
  const blocks = (source: number, target: number) =>
    F.db.execute(
      sql`INSERT INTO issue_link (source_issue_id, target_issue_id, kind) VALUES (${source}, ${target}, 'blocks')`,
    );

  const ok = await card('ok', task); // ready
  const blocked = await card('blocked', task, blockedColumn); // owner-refused
  const anEpic = await card('epic', epic); // owner-refused
  const operatorOwned = await card('operator', task); // owner-refused
  await F.storeLabel(operatorOwned, marker);
  const unknownKind = await card('story', story); // kind-unknown
  const openPrerequisite = await card('pre-open', task); // ready
  const waits = await card('waits', task); // owner-refused
  await blocks(openPrerequisite, waits);
  const closedPrerequisite = await card('pre-done', task, doneColumn); // not a candidate
  const unblocked = await card('unblocked', task); // ready
  await blocks(closedPrerequisite, unblocked);
  // A card inserted with no bead id: it holds no ledger row.
  const bare = (await F.ordinaryCard(f, title('bare'), 9001)).issueId; // issue-without-identity
  const waitsOnBare = await card('waits-bare', task); // dependency-without-identity
  await blocks(bare, waitsOnBare);
  // A card whose issue column and ledger row name two different bead ids.
  const mismatch = (await F.ordinaryCard(f, title('mismatch'), 9002)).issueId; // issue-identity-mismatch
  await F.db.execute(
    sql`UPDATE issue SET bead_id = ${`${F.RIG_PREFIX}-mismatch-a-${p}`} WHERE id = ${mismatch}`,
  );
  await F.db.execute(
    sql`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
        VALUES (${f.rigId}, ${`mismatch-b-${p}`}, 'imported', ${mismatch})`,
  );
  return {
    f,
    key,
    cards: {
      ok,
      blocked,
      anEpic,
      operatorOwned,
      unknownKind,
      openPrerequisite,
      waits,
      closedPrerequisite,
      unblocked,
      bare,
      waitsOnBare,
      mismatch,
    },
  };
}
const REFUSED = {
  blocked: 'tracker-rules-violation',
  anEpic: 'tracker-rules-violation',
  operatorOwned: 'tracker-rules-violation',
  waits: 'tracker-rules-violation',
  unknownKind: 'claim-unproven-kind-unknown',
  bare: 'issue-without-identity',
  waitsOnBare: 'claim-unproven-dependency-without-identity',
  mismatch: 'issue-identity-mismatch',
} as const;
const EXCLUDED = {
  'owner-refused': 4,
  'kind-unknown': 1,
  'issue-without-identity': 1,
  'dependency-without-identity': 1,
  'issue-identity-mismatch': 1,
};
const ready = (who: Person, key: string) => who.api.projects({ projectKey: key }).tracker.ready;
const claimOf = (who: Person, issueId: number) => who.api.issues({ issueId }).claim;

describe('8429 gated claim and ready routes', () => {
  it('claims a ready task directly and refuses each card the owner or the facts refuse', async () => {
    const { f, cards } = await pool('direct');
    const holder = await owner(f);
    await F.withOwner(async () => {
      for (const [name, code] of Object.entries(REFUSED)) {
        const issueId = cards[name as keyof typeof REFUSED];
        const taken = await claimOf(holder, issueId).post({ expectedEpoch: 0 });
        expect([name, taken.status, codeOf(taken.error)]).toEqual([name, 409, code]);
        expect(textOf(taken.error)).not.toContain('zz-private-');
        expect(await storedOf(issueId)).toEqual(UNCLAIMED);
      }
      for (const issueId of [cards.ok, cards.unblocked]) {
        const taken = await claimOf(holder, issueId).post({ expectedEpoch: 0 });
        expect(taken.status).toBe(200);
        expect(taken.data).toMatchObject({ owner: holder.userId, epoch: 1, mine: true });
        expect(await storedOf(issueId)).toEqual({ owner: holder.userId, epoch: 1, live: true });
      }
      // The owner's lease decision still applies after the readiness decision.
      const stale = await claimOf(holder, cards.openPrerequisite).post({ expectedEpoch: 7 });
      expect(stale.status).toBe(409);
      expect(await storedOf(cards.openPrerequisite)).toEqual(UNCLAIMED);
    });
  }, 240_000);

  it('lists one judged page of the pool and writes nothing', async () => {
    const { f, key, cards } = await pool('list');
    const reader = await owner(f);
    await F.withOwner(async () => {
      const all = await ready(reader, key).get({ query: {} });
      expect(all.status).toBe(200);
      expect(all.data?.items.map((item) => item.id)).toEqual([
        cards.ok,
        cards.openPrerequisite,
        cards.unblocked,
      ]);
      expect(all.data).toMatchObject({
        candidateTotal: 11,
        evaluatedCount: 11,
        eligibleCountOnPage: 3,
        excluded: EXCLUDED,
        page: 1,
      });
      // The stored title, which createIssue may have written in its own canonical form.
      const { title } = await one<{ title: string }>(
        sql`SELECT title FROM issue WHERE id = ${cards.ok}`,
      );
      expect(all.data?.items[0]).toMatchObject({ epoch: 0, title });
      expect(all.data?.items[0].beadId.startsWith(`${F.RIG_PREFIX}-`)).toBe(true);

      // A page counts only its own cards; the candidate total stays the whole pool.
      const second = await ready(reader, key).get({ query: { page: 2, pageSize: 4 } });
      expect(second.data?.items.map((item) => item.id)).toEqual([
        cards.openPrerequisite,
        cards.unblocked,
      ]);
      expect(second.data).toMatchObject({
        candidateTotal: 11,
        evaluatedCount: 4,
        eligibleCountOnPage: 2,
        excluded: { 'kind-unknown': 1, 'owner-refused': 1 },
        page: 2,
        pageSize: 4,
      });
      // A page with no ready card is not an empty pool.
      const none = await ready(reader, key).get({ query: { page: 2, pageSize: 1 } });
      expect(none.data).toMatchObject({ items: [], candidateTotal: 11, evaluatedCount: 1 });
    });
    for (const issueId of Object.values(cards)) expect(await storedOf(issueId)).toEqual(UNCLAIMED);
  }, 240_000);

  it('claims the first ready card in order, skips a live lease, and ends with none', async () => {
    const { f, key, cards } = await pool('walk');
    const walker = await owner(f);
    const other = await owner(f);
    await F.withOwner(async () => {
      const first = await ready(walker, key).claim.post({});
      expect(first.status).toBe(200);
      expect(first.data).toMatchObject({ evaluatedCount: 1, excluded: {} });
      expect(first.data?.claimed).toMatchObject({
        id: cards.ok,
        owner: walker.userId,
        epoch: 1,
        mine: true,
      });
      // The walker's own live lease is not handed out again, and the refused cards are passed.
      const second = await ready(walker, key).claim.post({});
      expect(second.data?.claimed).toMatchObject({ id: cards.openPrerequisite, epoch: 1 });
      expect(second.data).toMatchObject({
        evaluatedCount: 5,
        excluded: { 'owner-refused': 3, 'kind-unknown': 1 },
      });
      // Another user is refused the same cards and passes the two live leases.
      const third = await ready(other, key).claim.post({});
      expect(third.data?.claimed).toMatchObject({ id: cards.unblocked, owner: other.userId });
      expect(third.data).toMatchObject({
        evaluatedCount: 6,
        excluded: { 'owner-refused': 4, 'kind-unknown': 1 },
      });
      const last = await ready(other, key).claim.post({});
      expect(last.status).toBe(200);
      expect(last.data).toMatchObject({ claimed: null, evaluatedCount: 8, excluded: EXCLUDED });
    });
    expect(await storedOf(cards.ok)).toEqual({ owner: walker.userId, epoch: 1, live: true });
    expect(await storedOf(cards.unblocked)).toEqual({ owner: other.userId, epoch: 1, live: true });
    for (const name of Object.keys(REFUSED))
      expect(await storedOf(cards[name as keyof typeof REFUSED])).toEqual(UNCLAIMED);
  }, 240_000);

  it('takes no actor, lease or card from the body of ready/claim', async () => {
    const { f, key, cards } = await pool('body');
    const walker = await owner(f);
    const other = await owner(f);
    const forged = { actor: other.userId, owner: other.userId, issueId: cards.unblocked };
    await F.withOwner(async () => {
      const taken = await ready(walker, key).claim.post(forged as unknown as Record<string, never>);
      // The schema refuses the extra fields, or strips them. Either way they are never read.
      if (taken.status === 200) expect(taken.data?.claimed).toMatchObject({ id: cards.ok });
      else expect([400, 422]).toContain(taken.status);
    });
    expect(await storedOf(cards.unblocked)).toEqual(UNCLAIMED);
    expect((await storedOf(cards.ok)).owner).not.toBe(other.userId);
  }, 240_000);

  it('fails the whole request, claiming nothing, when the rule config is missing', async () => {
    const { f, key, cards } = await pool('unconfigured');
    const walker = await owner(f);
    await F.withNoConfig(async () => {
      const listed = await ready(walker, key).get({ query: {} });
      expect(listed.status).toBe(409);
      expect(codeOf(listed.error).startsWith('tracker-rules-')).toBe(true);
      const walked = await ready(walker, key).claim.post({});
      expect(walked.status).toBe(409);
      const direct = await claimOf(walker, cards.ok).post({ expectedEpoch: 0 });
      expect(direct.status).toBe(409);
      expect(codeOf(direct.error)).not.toBe('tracker-rules-violation');
    });
    for (const issueId of Object.values(cards)) expect(await storedOf(issueId)).toEqual(UNCLAIMED);
  }, 240_000);

  it('keeps the plain lease on a project with no rig and refuses its ready routes', async () => {
    const f = await F.fixture(false, 'ordinary');
    const { key } = await one<{ key: string }>(
      sql`SELECT key FROM project WHERE id = ${f.projectId}`,
    );
    const card = await F.ordinaryCard(f, 'Ordinary ready', 1);
    const holder = await owner(f);
    // No rule config at all: a project with no rig never asks the owner.
    await F.withNoConfig(async () => {
      const listed = await ready(holder, key).get({ query: {} });
      expect([listed.status, codeOf(listed.error)]).toEqual([409, 'ready-needs-rig']);
      const walked = await ready(holder, key).claim.post({});
      expect([walked.status, codeOf(walked.error)]).toEqual([409, 'ready-needs-rig']);
      expect(await storedOf(card.issueId)).toEqual(UNCLAIMED);
      const taken = await claimOf(holder, card.issueId).post({ expectedEpoch: 0 });
      expect(taken.status).toBe(200);
      expect(taken.data).toMatchObject({ owner: holder.userId, epoch: 1, mine: true });
    });
  }, 120_000);

  it('cannot store an issue with no column, so that state reaches no route', async () => {
    const { cards } = await pool('no-column');
    // issue.column_id is NOT NULL. The mapping of a missing column is covered by the unit test.
    // 23502 is not_null_violation. Any other database failure is a different fault and fails the case.
    const sqlState = (error: unknown) => {
      const failure = error as { code?: string; cause?: { code?: string } } | null;
      return String(failure?.cause?.code ?? failure?.code ?? error);
    };
    const cleared = F.db
      .execute(sql`UPDATE issue SET column_id = NULL WHERE id = ${cards.closedPrerequisite}`)
      .then(() => 'stored', sqlState);
    expect(await cleared).toBe('23502');
  }, 120_000);
});
