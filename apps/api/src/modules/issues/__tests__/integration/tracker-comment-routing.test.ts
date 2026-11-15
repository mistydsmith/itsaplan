import { afterEach, describe, expect, it } from 'bun:test';
// Comment routing on a rig-gated card: a comment that names an agent is judged by the owner's lane
// rule on facts built from that agent's stored identity and the pinned manifest. DATABASE HELD:
// the fixtures refuse before any client exists without Root's grant flag. withRoutedOwner is the
// composed owner pin plus a test-owned routing section that lists qwen2 as a local lane.
import { sql } from 'drizzle-orm';
import {
  board,
  cleanUp,
  commentCard,
  commentProject,
  everUsers,
  madeUsers,
  one,
  withRoutedOwner,
  type CommentFixture,
} from './tracker-comment-create-fixtures';

const { createComment, updateComment } = await import('../../activity');

type Refusal = { status: number; message: string; code?: string };
async function refused(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await withRoutedOwner(run);
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('a gated comment was allowed that it should have refused');
}

// An agent in the project whose username is a lane the manifest lists. The lane is read from the
// ai_agent row, so the bot user's own username carries the project id to stay unique.
async function laneAgent(p: CommentFixture, lane: string): Promise<string> {
  const { team_id: team } = await one<{ team_id: number }>(
    sql`SELECT team_id FROM project WHERE id = ${p.projectId}`,
  );
  const id = `zz_qw3_d3cc-${lane}-${p.projectId}`;
  await one(
    sql`INSERT INTO "user" (id, name, username, email, email_verified)
        VALUES (${id}, ${lane}, ${`${lane}lane${p.projectId}`}, ${`${lane}-${p.projectId}@example.com`}, true)`,
  );
  madeUsers.push(id);
  everUsers.push(id);
  await one(
    sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${p.projectId}, ${id}, 'member')`,
  );
  await one(
    sql`INSERT INTO ai_agent (team_id, user_id, username, kind, trigger_on_mention)
        VALUES (${team}, ${id}, ${lane}, 'internal', true)`,
  );
  return id;
}

const plainCard = (p: CommentFixture, title: string) =>
  commentCard(p, title, 'Plain card prose.', false, false);

describe('comment routing on a gated card', () => {
  afterEach(cleanUp);

  it('allows a comment that names an agent whose lane the manifest lists', async () => {
    const p = await commentProject(true);
    const agentId = await laneAgent(p, 'qwen2');
    const card = await plainCard(p, 'Lane mention');
    const before = await board(p.projectId, p.rigId);
    const comment = await withRoutedOwner(() =>
      createComment({ issueId: card.issueId, body: '@qwen2 please look', actorUserId: p.authorId }),
    );
    const after = await board(p.projectId, p.rigId);
    expect(after.activity).toBe(before.activity + 1);
    // The reach the owner judged is the reach the write used: one run queued for that agent.
    const runs = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM agent_run r JOIN ai_agent a ON a.id = r.agent_id
          WHERE r.issue_id = ${card.issueId} AND a.user_id = ${agentId}`,
    );
    expect(runs.n).toBe(1);
    expect(comment.id).toBeGreaterThan(0);
  }, 120_000);

  it("allows a mention of and a reply to the fixture's own agent under a canonical lane name", async () => {
    const p = await commentProject(true);
    const card = await plainCard(p, 'Fixture agent');
    // WHY the rename: the owner accepts only canonical fleet identities, and listing agent<id> in
    // a manifest does not make it one (Root D2, 2026-11-15). The agent that wrote the card's
    // comment takes the lane name qwen2; its bot user keeps the unique username.
    await one(
      sql`UPDATE ai_agent SET username = 'qwen2'
          WHERE username = ${`agent${p.projectId}`}
            AND team_id = (SELECT team_id FROM project WHERE id = ${p.projectId})
          RETURNING id`,
    );
    const before = await board(p.projectId, p.rigId);
    await withRoutedOwner(() =>
      createComment({
        issueId: card.issueId,
        body: 'please review @qwen2',
        actorUserId: p.authorId,
      }),
    );
    await withRoutedOwner(() =>
      createComment({
        issueId: card.issueId,
        body: 'what do you think of the earlier note?',
        actorUserId: p.authorId,
        replyToId: card.agentCommentId,
      }),
    );
    const after = await board(p.projectId, p.rigId);
    expect(after.activity).toBe(before.activity + 2);
    // The reach the owner judged is used: the agent has at least one run queued on this card.
    expect(after.runs).toBeGreaterThan(before.runs);
  }, 120_000);

  it('allows an edit that adds the same mention', async () => {
    const p = await commentProject(true);
    await laneAgent(p, 'qwen2');
    const card = await plainCard(p, 'Lane mention by edit');
    const written = await withRoutedOwner(() =>
      updateComment(card.humanCommentId, 'now for @qwen2', p.authorId, p.projectId),
    );
    expect(written.body).toBe('now for @qwen2');
  }, 120_000);

  it('refuses a fleet lane mention that no agent in the project stands behind', async () => {
    const p = await commentProject(true);
    const card = await plainCard(p, 'Unresolved mention');
    const before = await board(p.projectId, p.rigId);
    const error = await refused(() =>
      createComment({ issueId: card.issueId, body: '@qwen2 please look', actorUserId: p.authorId }),
    );
    expect(error).toMatchObject({ status: 409, code: 'tracker-rules-violation' });
    expect(error.message).toContain('lane-routing');
    expect(error.message).toContain('routing_facts.targets is empty');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('refuses a plain comment on a card whose earlier text names an unresolved fleet lane', async () => {
    const p = await commentProject(true);
    const card = await plainCard(p, 'Old mention');
    // Text stored before the gate judged comments: the owner still reads it on every later write.
    await one(
      sql`UPDATE issue_activity SET body = 'earlier note for @qwen2' WHERE id = ${card.humanCommentId}`,
    );
    const before = await board(p.projectId, p.rigId);
    const error = await refused(() =>
      createComment({ issueId: card.issueId, body: 'plain progress', actorUserId: p.authorId }),
    );
    expect(error).toMatchObject({ status: 409, code: 'tracker-rules-violation' });
    expect(error.message).toContain('routing_facts.targets is empty');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('refuses a listed Qwen lane named on a law-library card', async () => {
    const p = await commentProject(true);
    await laneAgent(p, 'qwen2');
    // The retained block satisfies the law-library rule, so the lane rule is the one that answers.
    const card = await commentCard(p, 'Law library mention', 'Plain card prose.', true, true);
    const before = await board(p.projectId, p.rigId);
    const error = await refused(() =>
      createComment({ issueId: card.issueId, body: '@qwen2 please look', actorUserId: p.authorId }),
    );
    expect(error).toMatchObject({ status: 409, code: 'tracker-rules-violation' });
    expect(error.message).toContain(
      "lane 'qwen2' is refused on law-library or legal-template work",
    );
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);
});
