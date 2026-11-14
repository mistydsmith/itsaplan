import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TRACKER_GATE_ENV } from '@repo/db/tracker-gate';

// E3b DELETE proof: the decided cases against the real public deleteComment, real D2 rows and the pinned
// R5 owner. The fixture import runs guard() before any client exists. No mock, no new production seam.
import {
  applyHistoryDdl,
  board,
  chainVersions,
  cleanUp,
  cleanupErrors,
  db,
  ddl,
  deleteFixture,
  dropOwnedDdl,
  ever,
  n,
  objects0183,
  one,
  OWNER_CONFIG,
  residue,
  rows,
  seq,
  TOKEN_BASE,
  version,
  versionRows,
  withLateDeliveryFailure,
  type DeleteFixture,
} from './tracker-comment-delete-fixtures';

const { deleteComment } = await import('../../activity');

// The owner environment under the names the gate reads, installed per call and restored exactly.
const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE = [
  [TRACKER_GATE_ENV.python, OWNER.python],
  [TRACKER_GATE_ENV.owner, OWNER.owner],
  [TRACKER_GATE_ENV.manifest, OWNER_CONFIG],
] as const;
async function withOwner<T>(run: () => Promise<T>): Promise<T> {
  const prior = GATE.map(([name]) => process.env[name]);
  for (const [name, value] of GATE) process.env[name] = value;
  try {
    return await run();
  } finally {
    GATE.forEach(([name], i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
    return {};
  } catch (error) {
    const http = error as { status?: number; code?: string; message?: string };
    return { status: http.status, code: http.code, message: http.message };
  }
}
function causeChain(error: unknown): string {
  const parts: string[] = [];
  type Link = { message?: unknown; code?: unknown; cause?: unknown } | null;
  for (let link = error as Link; link; link = link.cause as Link)
    parts.push(String(link.code ?? '') + String(link.message ?? link));
  return parts.join(' | ');
}
const onlyUnrelated = (f: DeleteFixture) => `${f.unrelatedId}:0:unrelated body`;

// A competitor that holds its write open. `ready` resolves with its backend pid only after its statement
// has run, so the delete starts strictly behind a lock that already exists.
function holdOpen(statement: ReturnType<typeof sql>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: (pid: number) => void = () => {};
  const readyPid = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const done = db.transaction(async (tx) => {
    await tx.execute(statement);
    const [{ pid }] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as {
      pid: number;
    }[];
    ready(pid);
    await gate;
  });
  // A holder that fails before publishing its pid must not leave the test waiting on `ready`.
  void done.catch(() => ready(-1));
  return { readyPid, release, done };
}

// Observed, not slept: a backend blocked by exactly this holder, on a statement matching `expected`.
async function waitBlockedBy(holderPid: number, expected: RegExp): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waiting = await rows<{ query: string }>(sql`SELECT query FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`);
    const hit = waiting.find((row) => expected.test(row.query));
    if (hit) return hit.query;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no backend blocked by ${holderPid} on ${expected}`);
}

// Registered before setup, so a failed or refused setup still runs it; it drops only DDL this run owns.
afterAll(async () => {
  await cleanUp();
  cleanupErrors.push(...(await dropOwnedDdl()));
});
beforeAll(async () => {
  await applyHistoryDdl();
});
afterEach(async () => {
  await cleanUp();
});

describe('the gated comment delete', () => {
  it('versions every removed body once, with its own author, and leaves the rest alone', async () => {
    const f = await deleteFixture('chain', { gated: true });
    // A preexisting version proves the revision continues rather than restarting at one.
    await db.execute(sql`
      INSERT INTO comment_version (comment_id, issue_id, revision, body, author_user_id, deleted_after)
      VALUES (${f.childId}, ${f.issueId}, 1, 'an older child body', ${f.authorIds.child}, false)`);
    const before = await board(f);
    expect(await withOwner(() => deleteComment(f.rootId, f.actorId, f.projectId))).toBe(true);
    // One comment_deleted activity and one root webhook, not one per removed row; the rest untouched.
    expect(await board(f)).toEqual({
      ...before,
      comments: onlyUnrelated(f),
      activity: Number(before.activity) + 1,
      deleted: Number(before.deleted) + 1,
      deliveries: Number(before.deliveries) + 1,
      versions: 4,
    });
    const [root, child, grandchild] = chainVersions(f);
    expect(await versionRows(f.issueId)).toEqual([
      root,
      version(f.childId, 1, 'an older child body', f.authorIds.child, false),
      { ...child, revision: 2 },
      grandchild,
    ]);
  }, 120_000);

  it('refuses a non-compliant law-library card under its own rule and writes nothing', async () => {
    const f = await deleteFixture('refuse', { gated: true, ll: true });
    const before = await board(f);
    const refusal = await withOwner(() =>
      refusalOf(() => deleteComment(f.rootId, f.actorId, f.projectId)),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toStartWith('law-library-compliance: ');
    expect(await board(f)).toEqual(before);
    expect(await versionRows(f.issueId)).toEqual([]);
  }, 120_000);

  it('refuses a cross-issue descendant before any version, delete or effect', async () => {
    const f = await deleteFixture('crossissue', { gated: true });
    const other = await deleteFixture('otherissue', { gated: true });
    // A legacy reply that points at this root but hangs on the other issue.
    const strayId =
      await n(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body, reply_to_id)
        VALUES (${other.issueId}, 'comment', ${f.actorId}, 'stray', ${f.rootId}) RETURNING id AS n`);
    ever.issue_activity.push(strayId);
    const [before, otherBefore] = [await board(f), await board(other)];
    const refusal = await withOwner(() =>
      refusalOf(() => deleteComment(f.rootId, f.actorId, f.projectId)),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'comment-cascade-unsupported']);
    expect(await board(f)).toEqual(before);
    expect(await board(other)).toEqual(otherBefore);
    expect(await versionRows(f.issueId)).toEqual([]);
    expect(await versionRows(other.issueId)).toEqual([]);
    expect(
      await one(sql`SELECT issue_id, reply_to_id, body FROM issue_activity WHERE id = ${strayId}`),
    ).toEqual({ issue_id: other.issueId, reply_to_id: f.rootId, body: 'stray' });
  }, 120_000);

  it('refuses a non-comment descendant the same way', async () => {
    const f = await deleteFixture('noncomment', { gated: true });
    // reply_to_id is only meant for comments, so a legacy activity row hanging off the chain is refused.
    const rowId =
      await n(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, action, reply_to_id)
        VALUES (${f.issueId}, 'activity', ${f.actorId}, 'created', ${f.childId}) RETURNING id AS n`);
    ever.issue_activity.push(rowId);
    const before = await board(f);
    const refusal = await withOwner(() =>
      refusalOf(() => deleteComment(f.rootId, f.actorId, f.projectId)),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'comment-cascade-unsupported']);
    expect(await board(f)).toEqual(before);
    expect(await versionRows(f.issueId)).toEqual([]);
  }, 120_000);

  it('rolls back history, deletion, activity and delivery when the in-transaction webhook fails', async () => {
    const f = await deleteFixture('gatedlate', { gated: true });
    const before = await board(f);
    // The gated emit runs on the delete's own transaction, so a failure there must undo every write.
    const error = await withLateDeliveryFailure(f.webhookId, () =>
      withOwner(() => deleteComment(f.rootId, f.actorId, f.projectId)),
    );
    expect(causeChain(error)).toContain('E3B_LATE');
    expect(await board(f)).toEqual(before);
    expect(await versionRows(f.issueId)).toEqual([]);
  }, 120_000);
});

describe('the ordinary delete and the missing id', () => {
  it('commits history and runs both effects after the commit', async () => {
    const f = await deleteFixture('ordinary', { gated: false });
    const before = await board(f);
    expect(await deleteComment(f.rootId, f.actorId, f.projectId)).toBe(true);
    expect(await board(f)).toEqual({
      ...before,
      comments: onlyUnrelated(f),
      activity: Number(before.activity) + 1,
      deleted: Number(before.deleted) + 1,
      deliveries: Number(before.deliveries) + 1,
      versions: 3,
    });
    expect(await versionRows(f.issueId)).toEqual(chainVersions(f));
  }, 120_000);

  it('keeps the committed history and deletion when the post-commit webhook fails', async () => {
    const f = await deleteFixture('ordinarylate', { gated: false });
    const before = await board(f);
    const error = await withLateDeliveryFailure(f.webhookId, () =>
      deleteComment(f.rootId, f.actorId, f.projectId),
    );
    expect(causeChain(error)).toContain('E3B_LATE');
    // recordActivity ran after the commit and before the failing emit; no delivery row survived.
    expect(await board(f)).toEqual({
      ...before,
      comments: onlyUnrelated(f),
      activity: Number(before.activity) + 1,
      deleted: Number(before.deleted) + 1,
      versions: 3,
    });
    expect(await versionRows(f.issueId)).toEqual(chainVersions(f));
  }, 120_000);

  it('returns false for a comment that is not there', async () => {
    expect(await deleteComment(2_000_000_000, null, 2_000_000_000)).toBe(false);
  }, 60_000);
});

describe('the delete under a live competitor', () => {
  it('versions and deletes a reply committed by a holder the delete had to wait for', async () => {
    const f = await deleteFixture('race-reply', { gated: true });
    const holder =
      holdOpen(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body, reply_to_id)
        VALUES (${f.issueId}, 'comment', ${f.editorId}, 'racing reply', ${f.rootId})`);
    let pending: Promise<boolean> | undefined;
    try {
      const pid = await holder.readyPid;
      expect(pid).toBeGreaterThan(0);
      pending = withOwner(() => deleteComment(f.rootId, f.actorId, f.projectId));
      // The reply's FK key-share on the issue and root rows blocks the delete's FOR UPDATE on them.
      await waitBlockedBy(
        pid,
        /FROM issue WHERE id = \$\d+ FOR UPDATE|FROM issue_activity\s+WHERE id = \$\d+ AND kind = 'comment' FOR UPDATE/,
      );
      holder.release();
      await holder.done;
      expect(await pending).toBe(true);
      const reply = await rows<Record<string, unknown>>(sql`SELECT comment_id, revision, body,
          author_user_id, deleted_after FROM comment_version
          WHERE issue_id = ${f.issueId} AND body = 'racing reply'`);
      expect(reply).toHaveLength(1);
      expect(reply[0]).toMatchObject(
        version(reply[0].comment_id as number, 1, 'racing reply', f.editorId),
      );
      expect(
        await n(sql`SELECT count(*)::int AS n FROM issue_activity
            WHERE issue_id = ${f.issueId} AND body = 'racing reply'`),
      ).toBe(0);
      expect(await versionRows(f.issueId)).toEqual(
        [...chainVersions(f), reply[0]].sort((a, b) => Number(a.comment_id) - Number(b.comment_id)),
      );
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
      await pending?.catch(() => undefined);
    }
  }, 120_000);

  it('versions the latest committed descendant body when an edit holds the row', async () => {
    const f = await deleteFixture('race-edit', { gated: true });
    const holder = holdOpen(
      sql`UPDATE issue_activity SET body = 'grandchild edited' WHERE id = ${f.grandchildId}`,
    );
    let pending: Promise<boolean> | undefined;
    try {
      const pid = await holder.readyPid;
      expect(pid).toBeGreaterThan(0);
      pending = withOwner(() => deleteComment(f.rootId, f.actorId, f.projectId));
      // The cascade's FOR UPDATE reaches the edited grandchild and waits on the holder's row lock.
      await waitBlockedBy(pid, /WHERE reply_to_id = ANY\(.*FOR UPDATE/s);
      holder.release();
      await holder.done;
      expect(await pending).toBe(true);
      const [root, child, grandchild] = chainVersions(f);
      expect(await versionRows(f.issueId)).toEqual([
        root,
        child,
        { ...grandchild, body: 'grandchild edited' },
      ]);
      expect((await board(f)).comments).toBe(onlyUnrelated(f));
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
      await pending?.catch(() => undefined);
    }
  }, 120_000);
});

describe('the fixture itself', () => {
  it('left no owned row, no owned DDL and only the null-linked ledger behind', async () => {
    await cleanUp();
    const { left, ledger } = await residue();
    expect(Object.values(left).every((count) => count === 0)).toBe(true);
    expect(left).toEqual(Object.fromEntries(Object.keys(left).map((k) => [k, 0])));
    expect(ledger).toEqual({ n: seq.token - TOKEN_BASE, live: 0 });
    expect(ddl.owned).toBe(true);
    cleanupErrors.push(...(await dropOwnedDdl()));
    expect(await objects0183()).toBe(0);
    expect(cleanupErrors).toEqual([]);
  }, 60_000);
});
