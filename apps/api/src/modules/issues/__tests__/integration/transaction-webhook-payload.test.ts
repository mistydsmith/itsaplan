import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// Payloads come from facts this connector reads itself, so a supplied transaction must see its own rows.
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
const { emitIssueEvent, emitIssueEvents, emitCommentEvent } = await import('../../webhook-payload');

type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface Payload {
  action: string;
  type: string;
  event: string;
  actor: { type: string; name: string | null };
  data: {
    title?: string;
    url?: string | null;
    state?: { name: string } | null;
    assignee?: { name: string | null } | null;
    issueType?: { name: string } | null;
    labels?: { name: string }[];
    issue?: { identifier: string; title: string; url: string | null } | null;
    rootProofMarker?: string;
  };
}

const made = {
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
  user: [] as string[],
  issue: [] as number[],
  webhook: [] as number[],
};

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// The facts one case needs, all written through the executor the case is testing.
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${tag}-${Date.now()}`;
  const projectKey = `W${suffix.slice(-6)}`;
  const teamSlug = `wt-${suffix}`;
  const issueTitle = `webhook issue ${suffix}`;
  const typeName = `Bug ${suffix}`;
  const labelName = `urgent ${suffix}`;
  const rootProofMarker = `root-marker-${suffix}`;
  const sequenceNumber = 7;

  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${`team ${suffix}`}, ${teamSlug}) RETURNING id`,
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
  const actor = await one<{ id: string }>(
    executor,
    sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${`actor-${suffix}`}, 'Actor', ${`actor${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase()}, ${`actor-${suffix}@example.com`}, true) RETURNING id`,
  );
  made.user.push(actor.id);
  const assignee = await one<{ id: string }>(
    executor,
    sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${`asg-${suffix}`}, 'Assignee', ${`asg${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase()}, ${`asg-${suffix}@example.com`}, true) RETURNING id`,
  );
  made.user.push(assignee.id);
  const type = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue_type (project_id, name) VALUES (${project.id}, ${typeName}) RETURNING id`,
  );
  const label = await one<{ id: number }>(
    executor,
    sql`INSERT INTO label (project_id, name, color) VALUES (${project.id}, ${labelName}, '#ff0000') RETURNING id`,
  );
  const issue = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, assignee_user_id, type_id)
        VALUES (${project.id}, ${sequenceNumber}, ${column.id}, ${issueTitle}, ${assignee.id}, ${type.id}) RETURNING id`,
  );
  made.issue.push(issue.id);
  await executor.execute(
    sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${issue.id}, ${label.id})`,
  );
  const webhook = await one<{ id: number }>(
    executor,
    sql`INSERT INTO webhook (project_id, url, secret, events)
        VALUES (${project.id}, 'https://example.invalid/hook', 'dummy', ${JSON.stringify(['issue.created', 'comment.created'])}::jsonb) RETURNING id`,
  );
  made.webhook.push(webhook.id);
  const comment = await one<{ id: number; created_at: string }>(
    executor,
    sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body) VALUES (${issue.id}, 'comment', ${actor.id}, ${`comment ${suffix}`}) RETURNING id, created_at::text AS created_at`,
  );

  const issueRow = {
    id: issue.id,
    projectId: project.id,
    sequenceNumber,
    identifier: `${projectKey}-${sequenceNumber}`,
    typeId: type.id,
    initiative: null,
    cycle: null,
    assigneeUserId: assignee.id,
    delegateUserId: null,
    columnId: column.id,
    parentId: null,
    title: issueTitle,
    description: '',
    priority: null,
    estimatePoints: null,
    estimateMinutes: null,
    loggedMinutes: 0,
    startDate: null,
    dueDate: null,
    position: 0,
    createdAt: comment.created_at,
    updatedAt: comment.created_at,
    archivedAt: null,
    statusSince: comment.created_at,
    shareToken: null,
    shareExtended: false,
    shareExpiresAt: null,
    labelIds: [label.id],
    fieldValues: [],
  };

  return {
    projectId: project.id,
    issueId: issue.id,
    webhookId: webhook.id,
    actorId: actor.id,
    commentId: comment.id,
    issueRow,
    comment: {
      id: comment.id,
      issueId: issue.id,
      kind: 'comment' as const,
      replyToId: null,
      actorUserId: actor.id,
      actorName: null,
      body: `comment ${suffix}`,
      action: null,
      payload: {},
      createdAt: comment.created_at,
      editedAt: null,
    },
    rootProofMarker,
    projectKey,
    teamSlug,
    sequenceNumber,
    issueTitle,
    typeName,
    labelName,
  };
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

async function counts(executor: Executor, webhookId: number) {
  return one<{ deliveries: number; payloads: string[] }>(
    executor,
    sql`
      SELECT (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id = ${webhookId}) AS deliveries,
             (SELECT coalesce(array_agg(payload::text), '{}') FROM webhook_delivery WHERE webhook_id = ${webhookId}) AS payloads`,
  );
}

async function issueCount(id: number): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM issue WHERE id = ${id}`,
  );
  return row.n;
}

async function withFailingDelivery<T>(body: () => Promise<T>): Promise<T> {
  const nonce = `u3c4_wh_fail_${Date.now()}`;
  await db.execute(sql`CREATE OR REPLACE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'u3c4 forced webhook delivery failure'; END; $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} AFTER INSERT ON webhook_delivery
FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
  try {
    return await body();
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON webhook_delivery`);
    await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(nonce)}()`);
  }
}

async function cleanUp() {
  for (const webhookId of made.webhook.splice(0)) {
    await db.execute(sql`DELETE FROM webhook_delivery WHERE webhook_id = ${webhookId}`);
    await db.execute(sql`DELETE FROM webhook WHERE id = ${webhookId}`);
  }
  for (const issueId of made.issue.splice(0)) {
    await db.execute(sql`DELETE FROM issue_label WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue_activity WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue WHERE id = ${issueId}`);
  }
  for (const userId of made.user.splice(0)) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
  }
  for (const projectId of made.project.splice(0)) {
    await db.execute(sql`DELETE FROM issue_type WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM label WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project_column WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project WHERE id = ${projectId}`);
  }
  for (const teamId of made.team.splice(0))
    await db.execute(sql`DELETE FROM team WHERE id = ${teamId}`);
  for (const wsId of made.workspace.splice(0)) {
    await db.execute(sql`DELETE FROM workspace WHERE id = ${wsId}`);
  }
}

describe('the issue webhook connector on a supplied transaction', () => {
  it('queues issue payloads built from uncommitted facts, then rolls back', async () => {
    const rollback = Symbol('rollback');
    let inside = { deliveries: 0, payloads: [] as string[] };
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'issue');
          await emitIssueEvents(
            facts.projectId,
            'issue.created',
            async () => [facts!.issueRow],
            facts!.actorId,
            executor,
          );
          await emitIssueEvent(
            'issue.created',
            facts.issueRow,
            facts.actorId,
            { rootProofMarker: facts.rootProofMarker },
            executor,
          );
          inside = await counts(executor, facts.webhookId);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      // Both doors ran on the same transaction, so the queue holds exactly two rows.
      expect(inside.deliveries).toBe(2);
      const payloads = inside.payloads.map((raw) => JSON.parse(raw) as Payload);
      const singular = payloads.find((p) => p.data.rootProofMarker === f.rootProofMarker);
      const plural = payloads.find((p) => p.data.rootProofMarker === undefined);
      expect(singular).toBeDefined();
      expect(plural).toBeDefined();
      // The plural envelope keeps its shape, and the singular one keeps the caller's extra.
      expect(plural!.action).toBe('create');
      expect(plural!.type).toBe('Issue');
      expect(plural!.event).toBe('issue.created');
      expect(plural!.actor.name).toBe('Actor');
      expect(singular!.data.title).toBe(f.issueTitle);
      expect(singular!.data.state?.name).toBe('Todo');
      expect(singular!.data.assignee?.name).toBe('Assignee');
      expect(singular!.data.issueType?.name).toBe(f.typeName);
      expect(singular!.data.labels?.map((l) => l.name)).toEqual([f.labelName]);
      expect(singular!.data.url).toEndWith(
        `/${f.teamSlug}/issue/${f.projectKey}-${f.sequenceNumber}`,
      );
      expect(await counts(db, f.webhookId)).toEqual({ deliveries: 0, payloads: [] });
      expect(await issueCount(f.issueId)).toBe(0);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('queues a comment payload that links to its uncommitted issue', async () => {
    const rollback = Symbol('rollback');
    let inside = { deliveries: 0, payloads: [] as string[] };
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'comment');
          await emitCommentEvent(
            facts.projectId,
            'comment.created',
            facts.comment,
            facts.actorId,
            executor,
          );
          inside = await counts(executor, facts.webhookId);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside.deliveries).toBe(1);
      const [payload] = inside.payloads.map((raw) => JSON.parse(raw) as Payload);
      expect(payload.type).toBe('Comment');
      expect(payload.data.issue?.identifier).toBe(`${f.projectKey}-${f.sequenceNumber}`);
      expect(payload.data.issue?.title).toBe(f.issueTitle);
      expect(payload.data.issue?.url).toEndWith(
        `/${f.teamSlug}/issue/${f.projectKey}-${f.sequenceNumber}`,
      );
      expect(payload.data.url).toEndWith(`#comment-${f.commentId}`);
      expect(await counts(db, f.webhookId)).toEqual({ deliveries: 0, payloads: [] });
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('commits the default no-executor path as before', async () => {
    try {
      const f = await fixtures(db, 'default');
      await emitIssueEvents(f.projectId, 'issue.created', async () => [f.issueRow], f.actorId);
      const after = await counts(db, f.webhookId);
      expect(after.deliveries).toBe(1);
      const [payload] = after.payloads.map((raw) => JSON.parse(raw) as Payload);
      expect(payload.data.assignee?.name).toBe('Assignee');
      expect(payload.data.labels?.[0]?.name).toBe(f.labelName);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('propagates a delivery failure before the awaited call returns', async () => {
    let advanced = false;
    let facts: Facts | null = null;
    try {
      let failure: unknown = null;
      await withFailingDelivery(async () => {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'fail');
          await emitIssueEvents(
            facts.projectId,
            'issue.created',
            async () => [facts!.issueRow],
            facts!.actorId,
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
      expect(chain(failure)).toMatch(/u3c4 forced webhook delivery failure/);
      expect(advanced).toBe(false);
      const f = facts as unknown as Facts;
      expect(await counts(db, f.webhookId)).toEqual({ deliveries: 0, payloads: [] });
      expect(await issueCount(f.issueId)).toBe(0);
    } finally {
      await cleanUp();
    }
  }, 60_000);
});
