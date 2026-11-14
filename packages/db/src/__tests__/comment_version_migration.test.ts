/**
 * 8364 E1 proof harness: the migration's real DDL, applied and rolled back inside one transaction.
 *
 * WHY this new file exists (NEW-TEST-FILE reason): E1a proves the drizzle table shape and E1b is the
 * migration text, but neither proves that the SQL applies, that its CHECK and UNIQUE and trigger refuse
 * what they must, or that the cascade boundaries behave. No existing test owns comment_version, and this
 * harness must never touch a real migration runner, so it gets its own file.
 *
 * PREP ONLY. This file has never been executed and it opens no connection without Root's distinct grant.
 * It is kept apart from the frozen E1a and E1b artifacts.
 *
 * WHAT IS PROVEN, and how each can fail:
 *   - the five statements of packages/db/drizzle/0183_comment_version.sql apply on a real server;
 *   - the table has the eight designed columns with the designed nullability;
 *   - revision 0 refuses with 23514, and a duplicate (comment_id, revision) with 23505;
 *   - BEFORE UPDATE refuses every rewrite with 23514, while DELETE still succeeds;
 *   - deleting a live comment (and its replies, which cascade) leaves the stored version bodies;
 *   - deleting the original author leaves the author snapshot untouched and does not refuse - the reason
 *     this column carries no FK: an ON DELETE SET NULL could never fire on an immutable row;
 *   - deleting the issue cascades the history rows with it, the one deletion boundary accepted.
 *
 * WHAT IT DOES NOT PROVE: that a migration runner journals it, or anything about a release. Every
 * statement runs inside one transaction that is rolled back at the end, so the table, its function and
 * its trigger never survive the test.
 *
 * If the table, function or trigger already exists when Root grants the run, this refuses and reports
 * instead of dropping or replacing anything - a pre-existing object means the harness is running against
 * a database it did not prepare.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// Distinct from every other grant this lane uses: the E1 proof has its own key and stays unset.
const GRANT = 'ITSAPLAN_8364_E1_PROOF';
const MIGRATION = join(import.meta.dir, '..', '..', 'drizzle', '0183_comment_version.sql');
const SENTINEL = 'u3c4_e1_rollback_sentinel';
const OWNED_TABLES = [
  'workspace',
  'team',
  'project',
  'project_column',
  'issue',
  'issue_activity',
  'user',
];

function guard(): void {
  if (process.env[GRANT] !== 'granted')
    throw new Error(
      `DB held: this harness runs only when ${GRANT}=granted is set on Root's serial GO`,
    );
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (url.hostname && !LOOPBACK.has(url.hostname))
    throw new Error(`refusing non-loopback host ${url.hostname}`);
  // An omitted port connects 5432, so the fallback must be 5432 for this to refuse it.
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this harness uses ${REQUIRED_DB}`);
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('this harness runs serial, with no worker id');
}
guard();

const { db } = await import('@repo/db');
const { sql } = await import('drizzle-orm');

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}
async function many<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)) as unknown as T[];
}

// The exact migration bytes, split the way the migrator splits them. Nothing is re-typed here.
function statements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// One expected SQL error, inside its own savepoint so the surrounding transaction stays usable.
async function refusal(
  executor: Executor,
  name: string,
  run: () => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  await executor.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    await run();
    await executor.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    return { code: undefined, message: '(the statement was allowed)' };
  } catch (error) {
    const wrapped = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    await executor.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    return {
      code: wrapped.code ?? wrapped.cause?.code,
      message: String(wrapped.cause?.message ?? wrapped.message ?? error),
    };
  }
}

async function counts(executor: Executor): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of OWNED_TABLES) {
    const row = await one<{ n: number }>(
      executor,
      sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)}`,
    );
    out[table] = row.n;
  }
  const catalog = await one<{ tables: number; functions: number; triggers: number }>(
    executor,
    sql`SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'comment_version') AS tables,
          (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'comment_version_immutable') AS functions,
          (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal
            AND tgname = 'comment_version_no_update') AS triggers`,
  );
  out.catalog_tables = catalog.tables;
  out.catalog_functions = catalog.functions;
  out.catalog_triggers = catalog.triggers;
  return out;
}

describe('the comment_version migration, applied and rolled back in one transaction', () => {
  it('proves the DDL and its refusals, then leaves the database exactly as it was', async () => {
    const before = await counts(db);
    // A pre-existing object means this harness is not running against a database it prepared: refuse
    // rather than drop or replace somebody else's table.
    expect(before.catalog_tables).toBe(0);
    expect(before.catalog_functions).toBe(0);
    expect(before.catalog_triggers).toBe(0);

    const parts = statements();
    expect(parts).toHaveLength(5);

    let failure: unknown = null;
    try {
      await db.transaction(async (tx) => {
        const executor = tx as unknown as Executor;
        for (const part of parts) await executor.execute(sql.raw(part));

        // The table is the designed shape.
        const columns = await many<{ column_name: string; is_nullable: string }>(
          executor,
          sql`SELECT column_name, is_nullable FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'comment_version' ORDER BY ordinal_position`,
        );
        expect(columns.map((row) => `${row.column_name}:${row.is_nullable}`)).toEqual([
          'id:NO',
          'comment_id:NO',
          'issue_id:NO',
          'revision:NO',
          'body:NO',
          'author_user_id:YES',
          'superseded_at:NO',
          'deleted_after:NO',
        ]);

        // Owned fixtures: one card, one live comment, one reply, one author.
        const ws = await one<{ id: number }>(
          executor,
          sql`INSERT INTO workspace (name) VALUES ('u3c4 e1 ws') RETURNING id`,
        );
        const team = await one<{ id: number }>(
          executor,
          sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, 'u3c4 e1 team', 'u3c4-e1') RETURNING id`,
        );
        const project = await one<{ id: number }>(
          executor,
          sql`INSERT INTO project (team_id, key, name) VALUES (${team.id}, 'E1CU', 'u3c4 e1 project') RETURNING id`,
        );
        const column = await one<{ id: number }>(
          executor,
          sql`INSERT INTO project_column (project_id, name, position) VALUES (${project.id}, 'Todo', 1) RETURNING id`,
        );
        const issue = await one<{ id: number }>(
          executor,
          sql`INSERT INTO issue (project_id, sequence_number, column_id, title)
              VALUES (${project.id}, 1, ${column.id}, 'u3c4 e1 issue') RETURNING id`,
        );
        const author = await one<{ id: string }>(
          executor,
          sql`INSERT INTO "user" (id, name, username, email, email_verified)
              VALUES ('u3c4-e1-author', 'Author', 'u3c4e1author', 'u3c4-e1@example.com', true) RETURNING id`,
        );
        const parent = await one<{ id: number }>(
          executor,
          sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body)
              VALUES (${issue.id}, 'comment', ${author.id}, 'the first body') RETURNING id`,
        );
        const reply = await one<{ id: number }>(
          executor,
          sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body, reply_to_id)
              VALUES (${issue.id}, 'comment', ${author.id}, 'a reply', ${parent.id}) RETURNING id`,
        );

        // The revision check refuses zero, and the unique key refuses a second row for one revision.
        const zero = await refusal(executor, 'sp_zero', () =>
          executor.execute(sql`INSERT INTO comment_version (comment_id, issue_id, revision, body)
            VALUES (${parent.id}, ${issue.id}, 0, 'never')`),
        );
        expect(zero.code).toBe('23514');
        const first = await one<{ id: number }>(
          executor,
          sql`INSERT INTO comment_version (comment_id, issue_id, revision, body, author_user_id)
              VALUES (${parent.id}, ${issue.id}, 1, 'the first body', ${author.id}) RETURNING id`,
        );
        const duplicate = await refusal(executor, 'sp_dup', () =>
          executor.execute(sql`INSERT INTO comment_version (comment_id, issue_id, revision, body)
            VALUES (${parent.id}, ${issue.id}, 1, 'again')`),
        );
        expect(duplicate.code).toBe('23505');
        const replyVersion = await one<{ id: number }>(
          executor,
          sql`INSERT INTO comment_version (comment_id, issue_id, revision, body)
              VALUES (${reply.id}, ${issue.id}, 1, 'a reply') RETURNING id`,
        );
        expect(replyVersion.id).toBeGreaterThan(first.id);

        // A stored version never changes, and the author snapshot survives its user.
        const rewrite = await refusal(executor, 'sp_update', () =>
          executor.execute(
            sql`UPDATE comment_version SET body = 'rewritten' WHERE id = ${first.id}`,
          ),
        );
        expect(rewrite.code).toBe('23514');
        await executor.execute(sql`DELETE FROM "user" WHERE id = ${author.id}`);
        const snapshot = await one<{ body: string; author_user_id: string | null }>(
          executor,
          sql`SELECT body, author_user_id FROM comment_version WHERE id = ${first.id}`,
        );
        expect(snapshot).toEqual({ body: 'the first body', author_user_id: 'u3c4-e1-author' });

        // Deleting the live comment and its reply leaves the stored bodies: that is the whole point of
        // the table, and the reason comment_id carries no FK.
        await executor.execute(sql`DELETE FROM issue_activity WHERE id = ${parent.id}`);
        const survivors = await many<{ comment_id: number; body: string }>(
          executor,
          sql`SELECT comment_id, body FROM comment_version ORDER BY id`,
        );
        expect(survivors).toEqual([
          { comment_id: parent.id, body: 'the first body' },
          { comment_id: reply.id, body: 'a reply' },
        ]);
        // Both live rows are gone, including the reply the cascade took with its parent. Scoped to this
        // fixture's issue: a comment elsewhere in the database is not this harness's evidence.
        const liveComments = await one<{ n: number }>(
          executor,
          sql`SELECT count(*)::int AS n FROM issue_activity
              WHERE issue_id = ${issue.id} AND kind = 'comment'`,
        );
        expect(liveComments.n).toBe(0);

        // The card going away is the one cascade accepted: history ends with the issue.
        await executor.execute(sql`DELETE FROM issue WHERE id = ${issue.id}`);
        const afterCascade = await one<{ n: number }>(
          executor,
          sql`SELECT count(*)::int AS n FROM comment_version`,
        );
        expect(afterCascade.n).toBe(0);

        throw new Error(SENTINEL);
      });
    } catch (error) {
      failure = error;
    }

    // The transaction always rolls back: that sentinel is the only accepted way out.
    expect(String((failure as Error)?.message)).toBe(SENTINEL);
    // Nothing of this harness survives, and no real table moved.
    expect(await counts(db)).toEqual(before);
  }, 120_000);
});
