import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The outbound connector on a real transaction. This file owns its rows and removes them by exact
// id in a finally. No shared preload, no resetDb, no provider, no network and no credentials.
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
const { notifyTextMentions } = await import('../../service');

// The executor both fixtures and reads use. Every supplied-transaction case passes the transaction,
// so a fixture written there is uncommitted and only that transaction can see it.
type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const EMAIL_TOGGLES = { assigned: false, mentioned: true, commented: false, state_changed: false };
const NO_TELEGRAM = { assigned: false, mentioned: false, commented: false, state_changed: false };
// SMTP is switched on so composeEmail renders. Nothing sends: the connector only queues rows.
const SMTP = {
  enabled: true,
  host: 'smtp.invalid',
  port: 587,
  encryption: 'starttls',
  username: 'dummy',
  hasPassword: true,
  timeout: null,
};
const SMTP_ENABLED = {
  system: { enabled: false },
  smtp: SMTP,
  resend: { enabled: false, hasApiKey: false },
  from: 'dummy@example.invalid',
  telegram: { enabled: false, hasBotToken: false },
};
const TEMPLATE_KEY = 'email_templates';

const made = {
  project: [] as number[],
  team: [] as number[],
  workspace: [] as number[],
  user: [] as string[],
  member: [] as { teamId: number; userId: string }[],
  settings: [] as number[],
  issue: [] as number[],
};

// The email_templates setting is shared state, not this file's fixture: its exact value and
// updated_at are captured before any case mutates it and put back in a finally, so no other
// suite's baseline is destroyed even when this file's transaction is rolled back.
interface TemplateBaseline {
  present: boolean;
  value: string | null;
  updatedAt: string | null;
}

async function snapshotTemplates(): Promise<TemplateBaseline> {
  const row = await one<{ value: string; updated_at: string } | undefined>(
    db,
    sql`
    SELECT value::text AS value, updated_at::text AS updated_at FROM app_setting WHERE key = ${TEMPLATE_KEY}`,
  );
  return row
    ? { present: true, value: row.value, updatedAt: row.updated_at }
    : { present: false, value: null, updatedAt: null };
}

async function restoreTemplates(baseline: TemplateBaseline): Promise<void> {
  if (!baseline.present) {
    await db.execute(sql`DELETE FROM app_setting WHERE key = ${TEMPLATE_KEY}`);
    return;
  }
  await db.execute(sql`UPDATE app_setting SET value = ${baseline.value}::jsonb, updated_at = ${baseline.updatedAt}::timestamptz
    WHERE key = ${TEMPLATE_KEY}`);
}

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// The facts one case needs, all written through the executor the case is testing.
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${tag}-${Date.now()}`;
  const username = `rcpt${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase();
  const issueTitle = `issue title ${suffix}`;
  const templateText = `template marker ${suffix}`;

  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${`team ${suffix}`}, ${`slug-${suffix}`}) RETURNING id`,
  );
  made.team.push(team.id);
  const project = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project (team_id, key, name) VALUES (${team.id}, ${`K${suffix.slice(-6)}`}, ${`project ${suffix}`}) RETURNING id`,
  );
  made.project.push(project.id);
  const column = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project.id}, 'Todo', 1) RETURNING id`,
  );
  made.project.push(-column.id); // column ids are cleaned with their project below
  // Every fact this case needs - both identity rows included - is written on the supplied executor,
  // so the fan-out must see uncommitted users through it. Rows are removed by exact id in cleanUp.
  const actor = await one<{ id: string }>(
    executor,
    sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${`actor-${suffix}`}, 'Actor', ${`actor${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase()}, ${`actor-${suffix}@example.com`}, true) RETURNING id`,
  );
  made.user.push(actor.id);
  const recipient = await one<{ id: string }>(
    executor,
    sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${`rcpt-${suffix}`}, 'Recipient', ${username}, ${`rcpt-${suffix}@example.com`}, true) RETURNING id`,
  );
  made.user.push(recipient.id);
  await executor.execute(
    sql`INSERT INTO team_member (team_id, user_id, role, source) VALUES (${team.id}, ${recipient.id}, 'member', 'invite')`,
  );
  made.member.push({ teamId: team.id, userId: recipient.id });
  // A mention resolves through project_member by username, so the recipient joins the project.
  await executor.execute(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${project.id}, ${recipient.id}, 'member')`,
  );
  await executor.execute(
    sql`INSERT INTO user_preference (user_id, locale) VALUES (${recipient.id}, 'fr') ON CONFLICT (user_id) DO UPDATE SET locale = 'fr'`,
  );
  await executor.execute(sql`INSERT INTO user_notification_preference (user_id, project_id, email_events, telegram_events)
    VALUES (${recipient.id}, ${project.id}, ${JSON.stringify(EMAIL_TOGGLES)}::jsonb, ${JSON.stringify(NO_TELEGRAM)}::jsonb)
    ON CONFLICT (user_id, project_id) DO UPDATE SET email_events = ${JSON.stringify(EMAIL_TOGGLES)}::jsonb`);
  // The table keeps its credentials encrypted; the redacted mirror is what the reader returns.
  await executor.execute(sql`INSERT INTO team_notification_setting (team_id, redacted, ciphertext, iv, auth_tag)
    VALUES (${team.id}, ${JSON.stringify(SMTP_ENABLED)}::jsonb, '', '', '')`);
  made.settings.push(team.id);
  const issue = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title) VALUES (${project.id}, 1, ${column.id}, ${issueTitle}) RETURNING id`,
  );
  made.issue.push(issue.id);
  const activity = await one<{ id: number }>(
    executor,
    sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, payload) VALUES (${issue.id}, 'activity', ${actor.id}, '{}'::jsonb) RETURNING id`,
  );
  // An uncommitted template for this case only, so the queued payload can be traced back to it.
  const fr = {
    subject: `{title} ${templateText}`,
    body: `{title} — ${templateText}`,
    button: 'Open',
  };
  const templates = { texts: { mentioned: { fr } }, layout: null };
  await executor.execute(sql`INSERT INTO app_setting (key, value) VALUES (${TEMPLATE_KEY}, ${JSON.stringify(templates)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(templates)}::jsonb`);
  return {
    projectId: project.id,
    issueId: issue.id,
    actorId: actor.id,
    recipientId: recipient.id,
    activityId: activity.id,
    username,
    issueTitle,
    templateText,
  };
}

async function cleanUp() {
  for (const id of made.issue.splice(0)) {
    await db.execute(
      sql`DELETE FROM notification_delivery WHERE project_id = (SELECT project_id FROM issue WHERE id = ${id})`,
    );
    await db.execute(sql`DELETE FROM notification WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue_watcher WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue_activity WHERE issue_id = ${id}`);
    await db.execute(sql`DELETE FROM issue WHERE id = ${id}`);
  }
  for (const id of made.project.splice(0)) {
    if (id > 0) {
      await db.execute(sql`DELETE FROM project_member WHERE project_id = ${id}`);
      await db.execute(sql`DELETE FROM project_column WHERE project_id = ${id}`);
      await db.execute(sql`DELETE FROM project WHERE id = ${id}`);
    }
  }
  for (const teamId of made.settings.splice(0))
    await db.execute(sql`DELETE FROM team_notification_setting WHERE team_id = ${teamId}`);
  for (const m of made.member.splice(0))
    await db.execute(
      sql`DELETE FROM team_member WHERE team_id = ${m.teamId} AND user_id = ${m.userId}`,
    );
  for (const userId of made.user.splice(0)) {
    await db.execute(sql`DELETE FROM user_notification_preference WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM user_preference WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
  }
  for (const id of made.team.splice(0)) await db.execute(sql`DELETE FROM team WHERE id = ${id}`);
  for (const id of made.workspace.splice(0))
    await db.execute(sql`DELETE FROM workspace WHERE id = ${id}`);
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

function mentionInput(f: Facts) {
  return {
    projectId: f.projectId,
    issueId: f.issueId,
    actorUserId: f.actorId,
    sourceActivityId: f.activityId,
    before: 'nothing',
    after: `hello @${f.username}`,
  };
}

async function counts(executor: Executor, projectId: number, issueId: number) {
  return one<{ deliveries: number; inbox: number; watchers: number; payloads: string[] }>(
    executor,
    sql`
    SELECT (SELECT count(*)::int FROM notification_delivery WHERE project_id = ${projectId}) AS deliveries,
           (SELECT count(*)::int FROM notification WHERE issue_id = ${issueId}) AS inbox,
           (SELECT count(*)::int FROM issue_watcher WHERE issue_id = ${issueId}) AS watchers,
           (SELECT coalesce(array_agg(payload::text), '{}') FROM notification_delivery WHERE project_id = ${projectId}) AS payloads`,
  );
}

// An owned immediate trigger: it fails the inserting statement itself, so the awaited call raises
// before it can return. Dropped in a finally; no guard is disabled anywhere.
async function withFailingDelivery<T>(body: () => Promise<T>): Promise<T> {
  const nonce = `u3c4_fail_${Date.now()}`;
  await db.execute(sql`CREATE OR REPLACE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'u3c4 forced delivery failure'; END; $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE TRIGGER ${sql.raw(nonce)} AFTER INSERT ON notification_delivery
    FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
  try {
    return await body();
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON notification_delivery`);
    await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(nonce)}()`);
  }
}

describe('the outbound connector on a supplied transaction', () => {
  it('queues real rows with the payload from uncommitted facts, then rolls back', async () => {
    const rollback = Symbol('rollback');
    let inside = { deliveries: 0, inbox: 0, watchers: 0, payloads: [] as string[] };
    let facts: Facts | null = null;
    const baseline = await snapshotTemplates();
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'tx');
          await notifyTextMentions(mentionInput(facts), executor);
          inside = await counts(executor, facts.projectId, facts.issueId);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside.inbox).toBeGreaterThan(0);
      expect(inside.watchers).toBeGreaterThan(0);
      expect(inside.deliveries).toBeGreaterThan(0);
      // Payloads arrive as JSON text with the HTML quotes escaped, so parse before inspecting.
      const payloads = inside.payloads.map(
        (raw) => JSON.parse(raw) as { subject?: string; text?: string; html?: string },
      );
      const html = payloads.map((row) => row.html ?? '').join('\n');
      const prose = payloads.map((row) => `${row.subject ?? ''}\n${row.text ?? ''}`).join('\n');
      expect(payloads.length).toBeGreaterThan(0);
      // The uncommitted issue title and template marker really reached the composed message.
      expect(`${html}\n${prose}`).toContain(f.issueTitle);
      expect(`${html}\n${prose}`).toContain(f.templateText);
      // The rendered HTML names its locale - not a bare substring that a URL or id could match.
      expect(html).toContain('lang="fr"');
      const after = await counts(db, f.projectId, f.issueId);
      expect(after).toEqual({ deliveries: 0, inbox: 0, watchers: 0, payloads: [] });
    } finally {
      await cleanUp();
      await restoreTemplates(baseline);
      expect(await snapshotTemplates()).toEqual(baseline);
    }
  }, 60_000);

  it('propagates a delivery failure before the awaited call returns', async () => {
    let advanced = false;
    let facts: Facts | null = null;
    const baseline = await snapshotTemplates();
    try {
      let failure: unknown = null;
      await withFailingDelivery(async () => {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'fail');
          await notifyTextMentions(mentionInput(facts), executor);
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
      expect(chain(failure)).toMatch(/u3c4 forced delivery failure/);
      // The awaited call never returned: the failure came from its own delivery statement.
      expect(advanced).toBe(false);
      const f = facts as unknown as Facts;
      const after = await counts(db, f.projectId, f.issueId);
      expect(after).toEqual({ deliveries: 0, inbox: 0, watchers: 0, payloads: [] });
    } finally {
      await cleanUp();
      await restoreTemplates(baseline);
      expect(await snapshotTemplates()).toEqual(baseline);
    }
  }, 60_000);

  it('commits the default no-executor path as before', async () => {
    const baseline = await snapshotTemplates();
    try {
      const f = await fixtures(db, 'default');
      await notifyTextMentions(mentionInput(f));
      const after = await counts(db, f.projectId, f.issueId);
      expect(after.inbox).toBeGreaterThan(0);
      expect(after.watchers).toBeGreaterThan(0);
      expect(after.deliveries).toBeGreaterThan(0);
    } finally {
      await cleanUp();
      await restoreTemplates(baseline);
      expect(await snapshotTemplates()).toEqual(baseline);
    }
  }, 60_000);

  it('keeps the default path best-effort: inbox stands, no delivery row', async () => {
    const baseline = await snapshotTemplates();
    try {
      const f = await fixtures(db, 'best');
      await withFailingDelivery(async () => {
        await expect(notifyTextMentions(mentionInput(f))).resolves.toBeUndefined();
      });
      const after = await counts(db, f.projectId, f.issueId);
      expect(after.inbox).toBeGreaterThan(0);
      expect(after.watchers).toBeGreaterThan(0);
      expect(after.deliveries).toBe(0);
    } finally {
      await cleanUp();
      await restoreTemplates(baseline);
      expect(await snapshotTemplates()).toEqual(baseline);
    }
  }, 60_000);

  it('a supplied transaction can neither skip the fan-out nor use its own connection', async () => {
    const rollback = Symbol('rollback');
    let inside = 0;
    let facts: Facts | null = null;
    const baseline = await snapshotTemplates();
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'control');
          await notifyTextMentions(mentionInput(facts), executor);
          inside = (await counts(executor, facts.projectId, facts.issueId)).deliveries;
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      // A skip would leave this zero; an own-connection write would survive the abort below.
      expect(inside).toBeGreaterThan(0);
      expect((await counts(db, f.projectId, f.issueId)).deliveries).toBe(0);
    } finally {
      await cleanUp();
      await restoreTemplates(baseline);
      expect(await snapshotTemplates()).toEqual(baseline);
    }
  }, 60_000);
});
