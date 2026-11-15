// The bead id on the issue responses, through the app with real sessions and the pinned rule owner.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag. This file
// never calls resetDb: the issues made through the API, the signed-up users and the workspace
// sign-up gives each are removed by id. A deleted issue leaves its ledger row as a tombstone,
// which the schema forbids deleting, in the synthetic rig the fixtures keep.
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as F from './tracker-labels-gate-fixtures';

const { authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');

const signedUp: { userId: string; workspaceId: number | null }[] = [];
const createdIssues: number[] = [];
let seq = 0;
// A person with a real session who owns the fixture project.
async function owner(f: F.GateFacts) {
  seq += 1;
  const user = await signUpTestUser({
    email: `zz-u4-beadid-${f.projectId}-${seq}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  await F.db.execute(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${user.userId}, 'owner')`,
  );
  return authedApi(user.cookie);
}

afterEach(async () => {
  const drop = (query: ReturnType<typeof sql>, what: string) =>
    F.db.execute(query).catch((error) => F.cleanupErrors.push(`${what}: ${error}`));
  // The issues go first: the fixture cleanup removes their project and column.
  for (const id of createdIssues.splice(0)) {
    await drop(sql`DELETE FROM issue_label WHERE issue_id = ${id}`, `issue_label ${id}`);
    await drop(sql`DELETE FROM issue_activity WHERE issue_id = ${id}`, `issue_activity ${id}`);
    await drop(sql`DELETE FROM notification WHERE issue_id = ${id}`, `notification ${id}`);
    await drop(sql`DELETE FROM issue WHERE id = ${id}`, `issue ${id}`);
  }
  await F.cleanUp();
  for (const { userId, workspaceId } of signedUp.splice(0)) {
    if (workspaceId !== null) {
      await drop(sql`DELETE FROM team WHERE workspace_id = ${workspaceId}`, `team of ${userId}`);
      await drop(sql`DELETE FROM workspace WHERE id = ${workspaceId}`, `workspace of ${userId}`);
    }
    await drop(sql`DELETE FROM "user" WHERE id = ${userId}`, `sign-up ${userId}`);
  }
});

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await F.db.execute(query)) as unknown as T[])[0];
}
const keyOf = async (projectId: number) =>
  (await one<{ key: string }>(sql`SELECT key FROM project WHERE id = ${projectId}`)).key;
// The bead id on the issue row and the one the ledger row of that issue spells.
const storedOf = (issueId: number) =>
  one<{ column: string | null; ledger: string | null }>(
    sql`SELECT i.bead_id AS "column",
               (SELECT r.prefix || '-' || b.local_token FROM bead_identity b
                JOIN rig r ON r.id = b.rig_id WHERE b.issue_id = i.id) AS ledger
        FROM issue i WHERE i.id = ${issueId}`,
  );
type Failure = { value?: { error?: string } } | null;
const textOf = (error: unknown) => String((error as Failure)?.value?.error ?? '');

type Api = Awaited<ReturnType<typeof owner>>;
async function create(api: Api, key: string, f: F.GateFacts, extra: Record<string, unknown> = {}) {
  const body = { columnId: f.columnId, title: `zz bead id ${f.projectId}`, labelIds: [f.small] };
  const made = await api
    .projects({ projectKey: key })
    .issues.post({ ...body, ...extra } as typeof body);
  if (made.data?.id != null) createdIssues.push(Number(made.data.id));
  return made;
}

describe('the bead id on an issue response', () => {
  it('is the stored id on create and on read, in a project with a rig', async () => {
    const f = await F.fixture(true, 'beadid');
    const api = await owner(f);
    const key = await keyOf(f.projectId);
    await F.withOwner(async () => {
      const made = await create(api, key, f);
      expect([made.status, textOf(made.error)]).toEqual([201, '']);
      const issueId = Number(made.data?.id);
      const stored = await storedOf(issueId);
      expect(stored.column).toMatch(new RegExp(`^${F.RIG_PREFIX}-\\S+$`));
      expect(stored.ledger).toBe(stored.column);
      expect(made.data?.beadId).toBe(stored.column);
      const read = await api.issues({ issueId }).get();
      expect(read.status).toBe(200);
      expect(read.data?.beadId).toBe(stored.column);
    });
  }, 240_000);

  it('never takes the id from the create body', async () => {
    const f = await F.fixture(true, 'beadid-forged');
    const api = await owner(f);
    const key = await keyOf(f.projectId);
    const forged = `${F.RIG_PREFIX}-forged-${f.projectId}`;
    await F.withOwner(async () => {
      const made = await create(api, key, f, { beadId: forged, bead_id: forged });
      // The schema refuses the extra fields, or strips them. Either way they are never read.
      if (made.status !== 201) {
        expect([400, 422]).toContain(made.status);
        return;
      }
      const stored = await storedOf(Number(made.data?.id));
      expect(stored.column).not.toBe(forged);
      expect(stored.ledger).toBe(stored.column);
      expect(made.data?.beadId).toBe(stored.column);
    });
    const taken = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue WHERE bead_id = ${forged}`,
    );
    expect(taken.n).toBe(0);
  }, 240_000);

  it('is null in a project with no rig', async () => {
    const f = await F.fixture(false, 'beadid-ordinary');
    const api = await owner(f);
    const key = await keyOf(f.projectId);
    // No rule config at all: a project with no rig never asks the owner.
    await F.withNoConfig(async () => {
      const made = await create(api, key, f);
      expect([made.status, textOf(made.error)]).toEqual([201, '']);
      expect(made.data?.beadId).toBeNull();
      const issueId = Number(made.data?.id);
      expect(await storedOf(issueId)).toEqual({ column: null, ledger: null });
      const read = await api.issues({ issueId }).get();
      expect(read.data?.beadId).toBeNull();
    });
  }, 120_000);
});
