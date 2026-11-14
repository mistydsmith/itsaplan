import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  aiAgent,
  agentFieldTrigger,
  customField,
  db,
  project,
  projectMember,
  team,
  user,
  workspace,
} from '@repo/db';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  canTriggerAgent,
  getAssignTriggerAgent,
  getFieldTriggerAgent,
  isTriggerableBy,
} from '../../service';

// The three trigger readers (canTriggerAgent, getAssignTriggerAgent, getFieldTriggerAgent) answer
// from a SELECT over ai_agent, project_member and agent_field_trigger. A caller that queues a run
// inside one transaction has often just written the membership, the agent or the field trigger in
// that same transaction, and no committed row exists yet; no existing suite proves a reader can
// answer for those uncommitted rows, because every suite writes through the API first and reads
// afterwards. This file is that proof: it writes its own fixtures inside a transaction it never
// commits, asks each reader on that transaction and on the process pool at the same moment, and
// the abort leaves nothing of mine behind. No run is enqueued; no model, provider or credential is
// touched. It never calls resetDb, never truncates a public schema, never creates a database or a
// per-worker clone, and writes only its own test-owned rows. Runner gate (serial, only when this
// lane holds the D2 proof slot): the exact-target preflight guard runs BEFORE bun test, so no
// client or preload opens a connection first; see the packet's d5_preflight_guard.ts and
// GATED_PROOF_D5.sh.

const MARK = 'zz_qwen3_d5';
const ACTOR = `${MARK}_actor`;
const OTHER = `${MARK}_other`;
const BOT = `${MARK}_bot`; // the bot user of the committed agent
const NEW_BOT = `${MARK}_newbot`; // a member with no agent row until a transaction adds one
const MY_USERS = [ACTOR, OTHER, BOT, NEW_BOT];
const MISSING_AGENT_ID = 2_000_000_000; // no row is ever written at this id

const ROLLBACK = Symbol('rollback');
type CallerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertTarget(): void {
  const raw = process.env.DATABASE_URL ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`target guard: DATABASE_URL is not parseable (${JSON.stringify(raw)})`);
  }
  const dbName = url.pathname.replace(/^\//, '');
  if (process.env.NODE_ENV !== 'test') {
    const env = JSON.stringify(process.env.NODE_ENV);
    throw new Error(`target guard: NODE_ENV must be test, got ${env}`);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '::1') {
    throw new Error(`target guard: host must be loopback, got ${url.hostname}`);
  }
  if (url.port !== '5433') throw new Error(`target guard: port must be 5433, got ${url.port}`);
  if (dbName !== 'itsaplan_8364_d2_test') {
    throw new Error(`target guard: database must be itsaplan_8364_d2_test, got ${dbName}`);
  }
  if (dbName.includes('sentinel') || dbName.includes('trial')) {
    throw new Error(`target guard: ${dbName} is not this unit's database`);
  }
  if (process.env.BUN_TEST_WORKER_ID) {
    throw new Error('target guard: the serial D2 run must not carry a worker id');
  }
}

// Runs the body on a real transaction and aborts it: only the intended rollback may leave this
// helper, so a driver failure cannot pass as a refusal and an expectation failure still fails.
async function rolledBack(body: (tx: CallerTx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

// Turns the committed agent's assign trigger on or off, for the one case that needs a
// trigger-enabled committed baseline and puts it back afterwards.
async function commitTriggerFlag(on: boolean): Promise<void> {
  await db.update(aiAgent).set({ triggerOnAssign: on }).where(eq(aiAgent.id, fixture.agentId));
}

async function countAgents(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(aiAgent)
    .where(inArray(aiAgent.userId, MY_USERS));
  return row.n;
}

async function countMemberships(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(projectMember)
    .where(inArray(projectMember.userId, MY_USERS));
  return row.n;
}

async function countFieldTriggers(): Promise<number> {
  const ids = myAgentIds();
  if (ids.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(agentFieldTrigger)
    .where(inArray(agentFieldTrigger.agentId, ids));
  return row.n;
}

const myAgentIds = (): number[] => (fixture.agentId ? [fixture.agentId, fixture.newAgentId] : []);

const fixture = {
  workspaceId: 0,
  teamId: 0,
  projectId: 0,
  fieldId: 0,
  agentId: 0,
  newAgentId: 0,
  baselineAgents: 0,
  baselineMemberships: 0,
};

async function insertUser(id: string): Promise<void> {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.test`,
    username: id,
    displayUsername: id,
    role: 'user',
  });
}

beforeAll(async () => {
  assertTarget();
  await cleanOwnRows();

  const [ws] = await db
    .insert(workspace)
    .values({ name: `${MARK}_ws` })
    .returning({ id: workspace.id });
  const [tm] = await db
    .insert(team)
    .values({ workspaceId: ws.id, name: `${MARK}_team` })
    .returning({ id: team.id });
  const [pr] = await db
    .insert(project)
    .values({ teamId: tm.id, key: 'ZZQ3', name: `${MARK}_project` })
    .returning({ id: project.id });
  const [cf] = await db
    .insert(customField)
    .values({ projectId: pr.id, name: `${MARK}_field`, fieldType: 'member', memberScope: 'agents' })
    .returning({ id: customField.id });
  for (const id of MY_USERS) await insertUser(id);
  const [ag] = await db
    .insert(aiAgent)
    .values({
      teamId: tm.id,
      userId: BOT,
      username: `${MARK}_bot`,
      kind: 'external',
      runnerScope: 'team',
      triggerOnMention: true,
      // Committed off: the tests turn it on only inside a transaction they abort.
      triggerOnAssign: false,
      delegationDelaySec: 60,
    })
    .returning({ id: aiAgent.id });

  // The committed state this file reads against: the agent's bot user is a member of the
  // project, the second member has no agent row at all, and no field trigger exists yet.
  await db.insert(projectMember).values([
    { projectId: pr.id, userId: BOT },
    { projectId: pr.id, userId: NEW_BOT },
  ]);

  fixture.workspaceId = ws.id;
  fixture.teamId = tm.id;
  fixture.projectId = pr.id;
  fixture.fieldId = cf.id;
  fixture.agentId = ag.id;
  fixture.newAgentId = MISSING_AGENT_ID; // replaced by the second agent a test inserts uncommitted
  fixture.baselineAgents = await countAgents();
  fixture.baselineMemberships = await countMemberships();
  expect(fixture.baselineAgents).toBe(1);
  expect(fixture.baselineMemberships).toBe(2);
  expect(await countFieldTriggers()).toBe(0);
});

afterAll(async () => {
  await cleanOwnRows();
  expect(await countAgents()).toBe(0);
  expect(await countMemberships()).toBe(0);
  expect(await countFieldTriggers()).toBe(0);
  const [left] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(user)
    .where(inArray(user.id, MY_USERS));
  expect(left.n).toBe(0);
});

async function cleanOwnRows(): Promise<void> {
  // Exact cleanup of this file's own rows only: its own users (which cascade its memberships
  // and its agents) and its own workspace (which cascades its team, project and member field).
  const ids = myAgentIds();
  if (ids.length > 0)
    await db.delete(agentFieldTrigger).where(inArray(agentFieldTrigger.agentId, ids));
  await db.delete(aiAgent).where(inArray(aiAgent.userId, MY_USERS));
  await db.delete(projectMember).where(inArray(projectMember.userId, MY_USERS));
  await db.delete(customField).where(eq(customField.projectId, fixture.projectId));
  await db.delete(project).where(eq(project.id, fixture.projectId));
  await db.delete(team).where(eq(team.id, fixture.teamId));
  await db.delete(workspace).where(eq(workspace.id, fixture.workspaceId));
  await db.delete(user).where(inArray(user.id, MY_USERS));
}

describe('trigger readers on a caller transaction', () => {
  it('reads the membership its own transaction removed, while the pool still sees it', async () => {
    // The delegation reader answers only for an agent whose assign trigger is on, so this case
    // commits that baseline for itself and puts the flag back off in the finally: the flag,
    // internal and default cases below still read the trigger-off baseline beforeAll committed.
    await commitTriggerFlag(true);
    try {
      await rolledBack(async (tx) => {
        await tx.delete(projectMember).where(eq(projectMember.userId, BOT));
        // On the transaction the bot user is no longer a member of the project, so the
        // delegation trigger has nothing to answer with.
        expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR, tx)).toBeNull();
        // On the pool the committed membership and the committed trigger are untouched, so the
        // same call still answers with the agent.
        expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR)).toEqual({
          id: fixture.agentId,
          delegationDelaySec: 60,
        });
      });
      // The abort undid the removal: the committed membership is still the only one there is.
      expect(fixture.baselineMemberships).toBe(2);
      expect(await countMemberships()).toBe(2);
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR)).toEqual({
        id: fixture.agentId,
        delegationDelaySec: 60,
      });
    } finally {
      await commitTriggerFlag(false);
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR)).toBeNull();
    }
  });

  it('reads the agent row its own transaction inserted, invisible to the pool', async () => {
    await rolledBack(async (tx) => {
      const [second] = await tx
        .insert(aiAgent)
        .values({
          teamId: fixture.teamId,
          userId: NEW_BOT,
          username: `${MARK}_bot2`,
          kind: 'external',
          runnerScope: 'team',
          triggerOnAssign: true,
          delegationDelaySec: 15,
        })
        .returning({ id: aiAgent.id });
      fixture.newAgentId = second.id;
      const onTx = await getAssignTriggerAgent(fixture.projectId, NEW_BOT, ACTOR, tx);
      expect(onTx).toEqual({ id: second.id, delegationDelaySec: 15 });
      // Same key, same moment, the reader's own pool: the agent does not exist there yet.
      expect(await getAssignTriggerAgent(fixture.projectId, NEW_BOT, ACTOR)).toBeNull();
      expect(await canTriggerAgent(second.id, ACTOR, tx)).toBe(true);
      // A missing agent reads as triggerable on the pool, which is the rule on main: the
      // caller's own lookup reports it missing. It is not evidence that the row exists.
      expect(await canTriggerAgent(second.id, ACTOR)).toBe(true);
    });
    expect(await countAgents()).toBe(1);
    expect(await getAssignTriggerAgent(fixture.projectId, NEW_BOT, ACTOR)).toBeNull();
  });

  it('reads the field trigger its own transaction inserted, invisible to the pool', async () => {
    await rolledBack(async (tx) => {
      await tx
        .insert(agentFieldTrigger)
        .values({ agentId: fixture.agentId, fieldId: fixture.fieldId, delaySec: 30 });
      expect(
        await getFieldTriggerAgent(fixture.projectId, BOT, fixture.fieldId, ACTOR, tx),
      ).toEqual({
        id: fixture.agentId,
        delaySec: 30,
      });
      expect(await getFieldTriggerAgent(fixture.projectId, BOT, fixture.fieldId, ACTOR)).toBeNull();
    });
    expect(await countFieldTriggers()).toBe(0);
    expect(await getFieldTriggerAgent(fixture.projectId, BOT, fixture.fieldId, ACTOR)).toBeNull();
  });

  it('reads the trigger flag its own transaction turned on, invisible to the pool', async () => {
    await rolledBack(async (tx) => {
      await tx
        .update(aiAgent)
        .set({ triggerOnAssign: true })
        .where(eq(aiAgent.id, fixture.agentId));
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR, tx)).toEqual({
        id: fixture.agentId,
        delegationDelaySec: 60,
      });
      // The committed row still has the trigger off, so the default door still refuses.
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR)).toBeNull();
    });
    expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR)).toBeNull();
  });

  it('keeps the owner-scope decision the same on the pool while the transaction narrows it', async () => {
    // Committed: an external agent with team runner scope is triggerable for every member.
    expect(await canTriggerAgent(fixture.agentId, ACTOR)).toBe(true);
    expect(await canTriggerAgent(fixture.agentId, OTHER)).toBe(true);

    await rolledBack(async (tx) => {
      await tx
        .update(aiAgent)
        .set({ runnerScope: 'owner', ownerUserId: ACTOR, triggerOnAssign: true })
        .where(eq(aiAgent.id, fixture.agentId));
      expect(await canTriggerAgent(fixture.agentId, ACTOR, tx)).toBe(true);
      expect(await canTriggerAgent(fixture.agentId, OTHER, tx)).toBe(false);
      // The delegation reader applies the same rule on the same transaction, and the flag it
      // just set on that transaction is what lets the owner's call answer at all.
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR, tx)).toEqual({
        id: fixture.agentId,
        delegationDelaySec: 60,
      });
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, OTHER, tx)).toBeNull();
      // Its own door is unchanged for the pool: still the committed team scope.
      expect(await canTriggerAgent(fixture.agentId, ACTOR)).toBe(true);
      expect(await canTriggerAgent(fixture.agentId, OTHER)).toBe(true);
    });

    expect(await canTriggerAgent(fixture.agentId, ACTOR)).toBe(true);
    expect(await canTriggerAgent(fixture.agentId, OTHER)).toBe(true);
    expect(await countAgents()).toBe(1);
  });

  it('keeps an internal agent triggerable for any member, on the transaction too', async () => {
    await rolledBack(async (tx) => {
      await tx
        .update(aiAgent)
        .set({ kind: 'internal', runnerScope: 'owner', ownerUserId: ACTOR, triggerOnAssign: true })
        .where(eq(aiAgent.id, fixture.agentId));
      // An internal agent ignores the owner scope: any member may trigger it.
      expect(await canTriggerAgent(fixture.agentId, OTHER, tx)).toBe(true);
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, OTHER, tx)).toEqual({
        id: fixture.agentId,
        delegationDelaySec: 60,
      });
      expect(
        isTriggerableBy({ kind: 'internal', runnerScope: 'owner', ownerUserId: ACTOR }, OTHER),
      ).toBe(true);
      // The pool still sees the committed external agent with its trigger off.
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, OTHER)).toBeNull();
    });
    const [committed] = await db
      .select({
        kind: aiAgent.kind,
        runnerScope: aiAgent.runnerScope,
        triggerOnAssign: aiAgent.triggerOnAssign,
      })
      .from(aiAgent)
      .where(eq(aiAgent.id, fixture.agentId));
    expect(committed).toEqual({ kind: 'external', runnerScope: 'team', triggerOnAssign: false });
  });

  it('answers on the default door exactly as before for a caller that passes nothing', async () => {
    // One-argument calls keep compiling and keep the old answers: a missing agent is
    // triggerable, and a project or member that has no trigger answer with nothing.
    expect(await canTriggerAgent(MISSING_AGENT_ID, ACTOR)).toBe(true);
    expect(await getAssignTriggerAgent(fixture.projectId, OTHER, ACTOR)).toBeNull();
    expect(await getFieldTriggerAgent(fixture.projectId, BOT, fixture.fieldId, ACTOR)).toBeNull();
    expect(await getAssignTriggerAgent(2_000_000_001, BOT, ACTOR)).toBeNull();
    // A transaction that writes nothing still answers on the door it was given.
    await rolledBack(async (tx) => {
      expect(await canTriggerAgent(fixture.agentId, ACTOR, tx)).toBe(true);
      expect(await getAssignTriggerAgent(fixture.projectId, BOT, ACTOR, tx)).toBeNull();
    });
  });

  it('leaves no fixture of its own behind once the transactions abort', async () => {
    expect(await countAgents()).toBe(1);
    expect(await countMemberships()).toBe(2);
    expect(await countFieldTriggers()).toBe(0);
    await cleanOwnRows();
    expect(await countAgents()).toBe(0);
    expect(await countMemberships()).toBe(0);
    expect(await countFieldTriggers()).toBe(0);
  });
});
