// The gated close through updateIssue with a server close request: the commit or artifact is read
// from a disposable Git repository and root, the claim from the issue row, and the composed owner
// judges both. A refused close leaves the card, its activity and its queued rows as they were.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag.
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as C from './tracker-close-request-fixtures';
import * as F from './tracker-labels-gate-fixtures';
import type { CloseRequest } from '../../close-facts';

const { claim, close, column, commit, family, person, repo, session, setUp, snapshot, storedOf } =
  C;
const { withCloseOwner } = C;
afterAll(C.cleanWork);
afterEach(C.cleanEach);

describe('8429 G2 gated close with a close request', () => {
  it('commits the closing move once for the authenticated holder and releases the claim', async () => {
    const { f, card, done, request } = await setUp('ok');
    const before = await F.board(f);
    const after = await close(card.issueId, { columnId: done }, f.actorId, request);
    expect(after?.columnId).toBe(done);
    const stored = await storedOf(card.issueId);
    expect(stored.column_id).toBe(done);
    // Released on the same transaction: no owner, and the epoch moved by one.
    expect([stored.claim_owner, Number(stored.claim_epoch)]).toEqual([null, 2]);
    const board = await F.board(f);
    expect(board.issues).toBe(before.issues);
    expect((await F.activityOf(card.issueId)).length).toBeGreaterThan(0);
  }, 120_000);

  it('commits a report close on a file inside the configured root', async () => {
    const { f, card, done } = await setUp('report');
    const report: CloseRequest = {
      kind: 'report',
      reason: 'done',
      artifact: 'report.md',
      expectedEpoch: 1,
    };
    const after = await close(card.issueId, { columnId: done }, f.actorId, report);
    expect(after?.columnId).toBe(done);
  }, 120_000);

  it('still refuses a closing move with no close request, writing nothing', async () => {
    const { f, card, done } = await setUp('none');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const refusal = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, undefined),
    );
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('close_facts');
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('refuses another authenticated user, a lapsed claim and a stale epoch, writing nothing', async () => {
    const { f, card, done, request } = await setUp('claim');
    const other = await F.laneAgent(f, 'closeother');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    // The request object carries the stored owner in extra fields; the authenticated user decides.
    const forged = { ...request, claimActor: f.actorId, actor: f.actorId } as CloseRequest;
    const wrongUser = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, other, forged),
    );
    expect(wrongUser.status).toBe(409);
    const staleEpoch = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, { ...request, expectedEpoch: 0 }),
    );
    expect(staleEpoch.status).toBe(409);
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
    await claim(card.issueId, f.actorId, 1, '-1 second');
    const lapsed = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, request),
    );
    expect(lapsed.status).toBe(409);
    expect((await storedOf(card.issueId)).column_id).toBe(stored.column_id);
    expect(await F.board(f)).toEqual(before);
  }, 180_000);

  it('refuses a close with no authenticated user before any proof is read', async () => {
    const { f, card, done, request } = await setUp('principal');
    const before = await F.board(f);
    const refusal = await F.refusalOf(() => close(card.issueId, { columnId: done }, null, request));
    expect([refusal.status, refusal.code]).toEqual([409, 'close-without-principal']);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('refuses a partial commit and a repository key the manifest does not list', async () => {
    const { f, card, done, request } = await setUp('proof');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const partialSha = commit(`${card.beadId} (partial): one piece`);
    const partial = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, { ...request, sha: partialSha }),
    );
    expect(partial.status).toBe(409);
    expect(partial.message).toContain('partial marker');
    const unknown = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, { ...request, repo: 'elsewhere' }),
    );
    expect([unknown.status, unknown.code]).toEqual([409, 'close-unconfigured']);
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
  }, 180_000);

  it('commits a close that also changes the title, judged as a full update too', async () => {
    const { f, card, done, request } = await setUp('title');
    const title = `${card.title} retitled`;
    const after = await close(card.issueId, { columnId: done, title }, f.actorId, request);
    expect([after?.columnId, after?.title]).toEqual([done, title]);
    const stored = await storedOf(card.issueId);
    expect([stored.column_id, stored.title, stored.claim_owner]).toEqual([done, title, null]);
  }, 120_000);

  it('rolls the close back when the same write changes a field the rules refuse', async () => {
    const { f, card, done, request } = await setUp('trap');
    await F.storeDescription(card.issueId, 'The stored prose that stays.');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    // The proof and the claim are valid. The description drops the stored text.
    const refusal = await F.refusalOf(() =>
      close(
        card.issueId,
        { columnId: done, description: 'Brand new text that drops the old.' },
        f.actorId,
        request,
      ),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toContain('stored description');
    // The move, the text and the claim are all as they were.
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(Number(stored.claim_epoch)).toBe(1);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('refuses a close request on a move that is not a close', async () => {
    const { f, card, request } = await setUp('shape');
    const open = await column(f, 'started');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const notClose = await F.refusalOf(() =>
      close(card.issueId, { columnId: open }, f.actorId, request),
    );
    expect([notClose.status, notClose.code]).toEqual([409, 'close-request-without-close']);
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('applies the completed column auto-assignee when the routing rule allows it', async () => {
    const { f, card, request } = await setUp('auto');
    const assignee = await person(f);
    const assigning = await column(f, 'completed', assignee);
    const after = await close(card.issueId, { columnId: assigning }, f.actorId, request);
    expect(after?.columnId).toBe(assigning);
    const stored = await storedOf(card.issueId);
    expect([stored.column_id, stored.assignee_user_id, stored.claim_owner]).toEqual([
      assigning,
      assignee,
      null,
    ]);
  }, 120_000);

  // The cascade runs on the close's own transaction. A subtask or parent it would close has no
  // close facts and no claim of its own, so the whole close is refused and nothing is written.
  it('rolls the close back when the cascade would close an open subtask without proof', async () => {
    const { f, card, done, request } = await setUp('kids');
    const child = await F.gatedCard(f, 'Close kids child');
    await family(f, card.issueId, child.issueId);
    const before = await snapshot(f, card.issueId, child.issueId);
    const refusal = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, request),
    );
    expect(refusal.status).toBe(409);
    // The primary move, its claim release, the activity and the queued rows all rolled back.
    expect(await snapshot(f, card.issueId, child.issueId)).toEqual(before);
    expect([before.cards[0].claim_owner, Number(before.cards[0].claim_epoch)]).toEqual([
      f.actorId,
      1,
    ]);
  }, 120_000);

  it('rolls the close back when the cascade would close the open parent without proof', async () => {
    const { f, card, done, request } = await setUp('parent');
    const parent = await F.gatedCard(f, 'Close parent parent');
    await family(f, parent.issueId, card.issueId);
    const before = await snapshot(f, card.issueId, parent.issueId);
    const refusal = await F.refusalOf(() =>
      close(card.issueId, { columnId: done }, f.actorId, request),
    );
    expect(refusal.status).toBe(409);
    expect(await snapshot(f, card.issueId, parent.issueId)).toEqual(before);
    expect([before.cards[0].claim_owner, Number(before.cards[0].claim_epoch)]).toEqual([
      f.actorId,
      1,
    ]);
  }, 120_000);

  it('commits the close once when the subtask and the parent are already settled', async () => {
    const { f, card, done, request } = await setUp('settled');
    const parent = await F.gatedCard(f, 'Close settled parent');
    const child = await F.gatedCard(f, 'Close settled child');
    const settled = await column(f, 'completed');
    await F.db.execute(
      sql`UPDATE issue SET column_id = ${settled} WHERE id IN (${parent.issueId}, ${child.issueId})`,
    );
    await family(f, parent.issueId, card.issueId);
    await family(f, card.issueId, child.issueId);
    const before = await snapshot(f, parent.issueId, child.issueId);
    const moves = (await F.activityOf(card.issueId)).length;
    const after = await close(card.issueId, { columnId: done }, f.actorId, request);
    expect(after?.columnId).toBe(done);
    const stored = await storedOf(card.issueId);
    expect([stored.column_id, stored.claim_owner, Number(stored.claim_epoch)]).toEqual([
      done,
      null,
      2,
    ]);
    // The card's move is recorded; the settled parent and subtask are untouched.
    expect((await F.activityOf(card.issueId)).length).toBeGreaterThan(moves);
    const now = await snapshot(f, parent.issueId, child.issueId);
    expect([now.cards, now.activity]).toEqual([before.cards, before.activity]);
  }, 120_000);
});

// 8429.2 D1 (office PAIRED-RETURN-R3): the server-proven operator close must win over a held
// claim. An explicit human CloseRequest sets gated.closer nonnull AND operator_close true, so the
// writer must clear the held claim (operator path) instead of delegating a wrong-owner release.
describe('8429.2 D1 operator close over a held claim', () => {
  it("clears another lane's held claim on an explicit owner close instead of rolling back", async () => {
    const { f, card, done, request } = await setUp('ok');
    // The fixture actor is a human project owner, so the server-computed operator_close is true.
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role)
          VALUES (${f.projectId}, ${f.actorId}, 'owner')`,
    );
    // Another lane holds the card (not the fixture actor), so an ordinary release would refuse wrong-owner.
    const holder = await F.laneAgent(f, 'closehold');
    await claim(card.issueId, holder, 3, '5 minutes');
    // The human owner sends an explicit CloseRequest: gated.closer nonnull AND operator_close true.
    const after = await close(card.issueId, { columnId: done }, f.actorId, request);
    expect(after?.columnId).toBe(done);
    // The operator close cleared the held claim on the same transaction (no wrong-owner rollback).
    const stored = await storedOf(card.issueId);
    expect(stored.claim_owner).toBe(null);
  }, 120_000);
});

// The same close through PATCH /issues/:issueId with a real session. The closer is the session
// user; the body names only where the proof is.
describe('8429 gated close through PATCH with a closeRequest', () => {
  it('closes for the session user that holds the claim and releases the claim', async () => {
    const { f, card, done, request } = await setUp('http-ok');
    const holder = await session(f);
    // setUp left the actor's claim at epoch 1. The claim guard takes a change of owner only at
    // the next epoch, so the session user's claim is epoch 2 and the release makes it 3.
    await claim(card.issueId, holder.userId, 2, '5 minutes');
    const res = await withCloseOwner(() =>
      holder.api
        .issues({ issueId: card.issueId })
        .patch({ columnId: done, closeRequest: { ...request, expectedEpoch: 2 } }),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: card.issueId, columnId: done });
    const stored = await storedOf(card.issueId);
    expect([stored.column_id, stored.claim_owner, Number(stored.claim_epoch)]).toEqual([
      done,
      null,
      3,
    ]);
  }, 120_000);

  it('refuses a session user that does not hold the claim, whatever the body adds', async () => {
    const { f, card, done, request } = await setUp('http-forged');
    const other = await session(f);
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    // Properties the schema does not list: the closer, a repository path, a branch, a verdict.
    const forged = {
      ...request,
      actor: f.actorId,
      claimActor: f.actorId,
      repoRoot: repo,
      targetRef: 'main',
      verified: true,
    } as CloseRequest;
    const res = await withCloseOwner(() =>
      other.api.issues({ issueId: card.issueId }).patch({ columnId: done, closeRequest: forged }),
    );
    expect(res.status).toBe(409);
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);

  it('refuses a closing PATCH with no closeRequest and one with a malformed commit', async () => {
    const { f, card, done, request } = await setUp('http-shape');
    const holder = await session(f);
    await claim(card.issueId, holder.userId, 2, '5 minutes');
    const before = await F.board(f);
    const stored = await storedOf(card.issueId);
    const bare = await withCloseOwner(() =>
      holder.api.issues({ issueId: card.issueId }).patch({ columnId: done }),
    );
    expect(bare.status).toBe(409);
    const malformed = await withCloseOwner(() =>
      holder.api
        .issues({ issueId: card.issueId })
        .patch({ columnId: done, closeRequest: { ...request, expectedEpoch: 2, sha: 'main' } }),
    );
    // errorAnswer in shared/lib.ts answers a schema failure with 400 and the validator's summary.
    expect(malformed.status).toBe(400);
    expect(typeof (malformed.error?.value as { error?: unknown } | undefined)?.error).toBe(
      'string',
    );
    expect(await storedOf(card.issueId)).toEqual(stored);
    expect(await F.board(f)).toEqual(before);
  }, 120_000);
});
