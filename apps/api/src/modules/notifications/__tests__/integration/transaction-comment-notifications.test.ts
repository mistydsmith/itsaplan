import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The comment notification doors on a real transaction. Both resolve watchers and subscribe the
// people they mention, so a caller that supplies its transaction needs those reads and writes to be
// the same ones. Every fixture row is written through the executor under test and removed by exact
// id in a finally. No SMTP setting, so nothing is rendered and no provider is reached.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function targetUrl(raw: string | undefined, env: string | undefined): string {
  if (env !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (/sentinel|trial/i.test(name)) throw new Error('refusing a trial or Sentinel database');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}

void targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

const { db } = await import('@repo/db');
const { notifyComment, notifyEditedCommentMentions } = await import('../../service');

type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const made = {
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
  user: [] as string[],
  issue: [] as number[],
};

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// A project with four people: the author, one member who is mentioned, one member who watches, and
// one member neither of them touches. Rows are written through the executor the case is testing.
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${tag}-${Date.now()}`;
  const projectKey = `C${suffix.slice(-6)}`;
  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${`team ${suffix}`}, ${`ct-${suffix}`}) RETURNING id`,
  );
  made.team.push(team.id);
  const project = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project (team_id, key, name) VALUES (${team.id}, ${projectKey}, ${`project ${suffix}`}) RETURNING id`,
  );
  made.project.push(project.id);
  const column = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project.id}, 'Todo', 1) RETURNING id`,
  );
  const people: Record<string, string> = {};
  for (const name of ['actor', 'mentioned', 'watcher', 'other']) {
    const user = await one<{ id: string }>(
      executor,
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${name}-${suffix}`}, ${name}, ${`${name}${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase()}, ${`${name}-${suffix}@example.com`}, true) RETURNING id`,
    );
    made.user.push(user.id);
    people[name] = user.id;
  }
  // Subscribing and mentioning reach project members only, so all four join; the author is a
  // member who watches their own issue but is never notified of their own comment.
  for (const name of ['actor', 'mentioned', 'watcher', 'other']) {
    await executor.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${project.id}, ${people[name]}, 'member')`,
    );
  }
  const issue = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title)
        VALUES (${project.id}, 1, ${column.id}, ${`comment issue ${suffix}`}) RETURNING id`,
  );
  made.issue.push(issue.id);
  // The watcher already follows the issue; the author and the mentioned member do not.
  await executor.execute(
    sql`INSERT INTO issue_watcher (issue_id, user_id) VALUES (${issue.id}, ${people.watcher})`,
  );
  const comment = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body)
        VALUES (${issue.id}, 'comment', ${people.actor}, ${`comment ${suffix}`}) RETURNING id`,
  );
  return { projectId: project.id, issueId: issue.id, commentId: comment.id, people };
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

async function inbox(executor: Executor, issueId: number) {
  const rows = (await executor.execute(
    sql`SELECT user_id, type FROM notification WHERE issue_id = ${issueId} ORDER BY type, user_id`,
  )) as unknown as { user_id: string; type: string }[];
  // The SQL orders by type then user id, while the expectations sort "user:type" strings, so the
  // helper normalises its own order; otherwise this case would fail on an ordering detail alone.
  return rows.map((row) => `${row.user_id}:${row.type}`).sort();
}

async function watchers(executor: Executor, issueId: number) {
  const rows = (await executor.execute(
    sql`SELECT user_id FROM issue_watcher WHERE issue_id = ${issueId} ORDER BY user_id`,
  )) as unknown as { user_id: string }[];
  // Same normalisation as inbox(): compare in one order whatever the database collation returns.
  return rows.map((row) => row.user_id).sort();
}

// An owned statement trigger on notification, scoped by WHEN to this case's own project, so it
// cannot affect another lane's rows. Dropped in the caller's finally.
async function withFailingInsert<T>(projectId: number, body: () => Promise<T>): Promise<T> {
  const nonce = `u3c4_cn_fail_${Date.now()}`;
  // WHY the id is inlined and the trigger has no WHEN clause: Postgres cannot infer a parameter's
  // type inside DDL, so "WHEN (NEW.project_id = $1)" fails to create the trigger. The guard lives in
  // the function body instead, on this case's own serial id, and creation sits inside the try so a
  // failure there still drops what was created.
  await db.execute(sql`CREATE OR REPLACE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id = ${sql.raw(String(projectId))} THEN
    RAISE EXCEPTION 'u3c4 forced comment notification failure';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`);
  try {
    await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} BEFORE INSERT ON notification
FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
    return await body();
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON notification`);
    await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(nonce)}()`);
  }
}

async function cleanUp() {
  for (const issueId of made.issue.splice(0)) {
    await db.execute(sql`DELETE FROM notification WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue_watcher WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue_activity WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue WHERE id = ${issueId}`);
  }
  for (const projectId of made.project.splice(0)) {
    await db.execute(sql`DELETE FROM project_member WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project_column WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project WHERE id = ${projectId}`);
  }
  for (const userId of made.user.splice(0))
    await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
  for (const teamId of made.team.splice(0))
    await db.execute(sql`DELETE FROM team WHERE id = ${teamId}`);
  for (const wsId of made.workspace.splice(0))
    await db.execute(sql`DELETE FROM workspace WHERE id = ${wsId}`);
}

describe('the comment notification doors on a supplied transaction', () => {
  it('notifies the mention once and the watchers once, subscribing both, then rolls back', async () => {
    const rollback = Symbol('rollback');
    let inside = { inbox: [] as string[], watchers: [] as string[] };
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'comment');
          await notifyComment(
            facts.projectId,
            {
              issueId: facts.issueId,
              id: facts.commentId,
              actorUserId: facts.people.actor,
              body: 'hi',
            },
            { memberIds: [facts.people.mentioned], agentUserIds: [] },
            executor,
          );
          inside = {
            inbox: await inbox(executor, facts.issueId),
            watchers: await watchers(executor, facts.issueId),
          };
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      // The mentioned member gets one 'mentioned'; the existing watcher gets one 'commented'; the
      // mentioned member is not also told it commented, and the author hears nothing.
      expect(inside.inbox).toEqual(
        [`${f.people.mentioned}:mentioned`, `${f.people.watcher}:commented`].sort(),
      );
      // Commenting subscribed the author and the mentioned member, on the same transaction.
      expect(inside.watchers).toEqual(
        [f.people.actor, f.people.mentioned, f.people.watcher].sort(),
      );
      expect(await inbox(db, f.issueId)).toEqual([]);
      expect(await watchers(db, f.issueId)).toEqual([]);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('notifies only the newly mentioned ids on an edit, with no watcher event, then rolls back', async () => {
    const rollback = Symbol('rollback');
    let inside = { inbox: [] as string[], watchers: [] as string[] };
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'edited');
          await notifyEditedCommentMentions(
            facts.projectId,
            { issueId: facts.issueId, id: facts.commentId, actorUserId: facts.people.actor },
            { memberIds: [facts.people.other], agentUserIds: [] },
            executor,
          );
          inside = {
            inbox: await inbox(executor, facts.issueId),
            watchers: await watchers(executor, facts.issueId),
          };
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside.inbox).toEqual([`${f.people.other}:mentioned`]);
      // An edit subscribes the newly mentioned member and says nothing to the watchers.
      expect(inside.watchers).toEqual([f.people.other, f.people.watcher].sort());
      expect(await inbox(db, f.issueId)).toEqual([]);
      expect(await watchers(db, f.issueId)).toEqual([]);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('keeps the default no-executor path as before', async () => {
    try {
      const f = await fixtures(db, 'default');
      await notifyComment(
        f.projectId,
        { issueId: f.issueId, id: f.commentId, actorUserId: f.people.actor, body: 'hi' },
        { memberIds: [f.people.mentioned], agentUserIds: [] },
      );
      expect(await inbox(db, f.issueId)).toEqual(
        [`${f.people.mentioned}:mentioned`, `${f.people.watcher}:commented`].sort(),
      );
      expect(await watchers(db, f.issueId)).toEqual(
        [f.people.actor, f.people.mentioned, f.people.watcher].sort(),
      );
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('propagates a scoped insert failure before the awaited call returns', async () => {
    let advanced = false;
    let facts: Facts | null = null;
    try {
      // These fixtures are committed on purpose: the WHEN clause has to name a real project id
      // before the transaction opens. The door under test still runs on the transaction, and its
      // rows - notification and the watchers it subscribed - are what the rollback has to remove.
      facts = await fixtures(db, 'fail');
      const f = facts;
      let failure: unknown = null;
      await withFailingInsert(f.projectId, async () => {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          await notifyComment(
            f.projectId,
            { issueId: f.issueId, id: f.commentId, actorUserId: f.people.actor, body: 'hi' },
            { memberIds: [f.people.mentioned], agentUserIds: [] },
            executor,
          );
          advanced = true;
        });
      }).catch((error: unknown) => {
        failure = error;
      });
      // Drizzle wraps the driver error, so the trigger's words ride on the cause of the rejection.
      const chain = (error: unknown) => {
        const out: string[] = [];
        type Link = { message?: unknown; cause?: unknown } | null;
        for (let link = error as Link; link; link = link.cause as Link) {
          out.push(String(link.message ?? link));
        }
        return out.join(' | ');
      };
      expect(chain(failure)).toMatch(/u3c4 forced comment notification failure/);
      expect(advanced).toBe(false);
      expect(await inbox(db, f.issueId)).toEqual([]);
      expect(await watchers(db, f.issueId)).toEqual([f.people.watcher]);
    } finally {
      await cleanUp();
    }
  }, 60_000);
});
