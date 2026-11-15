// Claimed chat delivery: the runner-facing half of the chat feed (8429 row 29, C).
//
// The member's side (threads, messages, events, the browser stream) stays in service.ts;
// this leaf owns the answer's journey once a runner is about to receive it: the claim
// with its lease and exhaustion, the prompts the claim hands out, and the terminal
// close. Outbound PII admission (8429 row 29, C) sits in claimMessage, the one path
// both delivery modes share, before the framed prompt leaves the server.
//
// WHY the split: the claim-and-handoff lifecycle is cohesive and is where the admission
// gate belongs, while service.ts keeps the member-facing feed. This leaf imports nothing
// from service.ts; service.ts imports liveAnswer and wasCanceled from here and
// re-exports the claimed delivery's public names, so the edge runs one way only.

import { setTimeout as sleep } from 'node:timers/promises';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  agentChatEvent,
  agentChatMessage,
  db,
  getJobSettings,
  type JobSettings,
} from '@repo/db';
import { recordContextUsage, type ContextUsage } from '../chat-usage';
import { admitRunnerDelivery } from '../core/pii-admission';
import { attachmentPreamble, chartPreamble, projectsPreamble } from '../core/prompt/framing';
import { peoplePreamble, type Person } from '../core/prompt/run-context';
import { assertRunnerDrained, touchRunner, type RunnerAgent } from '../runner/service';

type ChatJobs = JobSettings['agentChat'];

// The statuses an answer can still be worked on in: a runner claims either, and only
// these take events, heartbeats and a result.
const LIVE_STATUSES = ['pending', 'streaming'];

export interface ClaimedChat {
  id: number;
  threadId: string;
  prompt: string;
  systemPrompt: string;
  attempts: number;
  sessionId: string | null;
}

// The claim's raw row: the answer plus what the prompts are built from.
interface ClaimedRow {
  id: number;
  threadId: string;
  attempts: number;
  requesterName: string | null;
  requesterUsername: string | null;
  sessionId: string | null;
}

// Fails answers handed out too many times without a result, so a chat whose runner
// keeps dying ends visibly instead of being served forever. Called once per claim, not
// once per look at the feed: a claim waits for work and looks many times.
async function expireExhausted(agentId: number, chat: ChatJobs): Promise<void> {
  await db
    .update(agentChatMessage)
    .set({
      status: 'failed',
      lastError: 'Runner did not report a result',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(agentChatMessage.agentId, agentId),
        inArray(agentChatMessage.status, LIVE_STATUSES),
        sql`${agentChatMessage.attempts} >= ${chat.maxAttempts}`,
        sql`${agentChatMessage.nextAttemptAt} <= now()`,
      ),
    );
}

// Waits for the agent's next answer to produce and hands it over under a lease, or null
// when none turns up in time. Waiting instead of polling is what makes an answer start
// the moment it is sent.
export async function claimNextMessage(agent: RunnerAgent): Promise<ClaimedChat | null> {
  assertRunnerDrained(agent);
  await touchRunner(agent.id);
  const { agentChat: chat } = await getJobSettings();
  await expireExhausted(agent.id, chat);
  const deadline = Date.now() + chat.claimWaitMs;
  for (;;) {
    const message = await claimMessage(agent, chat);
    if (message) return message;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(chat.claimPollMs, Math.max(0, deadline - Date.now())));
  }
}

// The agent's next due answer without waiting for one, for an agent whose answers are
// sent to its invocation URL rather than claimed.
export async function takeNextMessage(agent: RunnerAgent): Promise<ClaimedChat | null> {
  const { agentChat: chat } = await getJobSettings();
  await expireExhausted(agent.id, chat);
  return claimMessage(agent, chat);
}

// Takes the agent's next due answer, or null when it has none. Claiming clears whatever
// a previous attempt produced: the answer is generated again from the start, and the
// browser would otherwise read the abandoned half twice.
async function claimMessage(agent: RunnerAgent, chat: ChatJobs): Promise<ClaimedChat | null> {
  const rows = await db.transaction(async (tx) => {
    const threads = await tx.execute(sql`
      WITH live_heads AS MATERIALIZED (
        SELECT q.thread_id, min(q.id) AS id FROM agent_chat_message q
        WHERE q.agent_id = ${agent.id}
          AND q.role = 'assistant'
          AND q.status IN ('pending', 'streaming')
        GROUP BY q.thread_id
      ), ready_heads AS MATERIALIZED (
        SELECT h.thread_id FROM live_heads h
        JOIN agent_chat_message head ON head.id = h.id
        WHERE head.next_attempt_at <= now()
          AND head.attempts < ${chat.maxAttempts}
        ORDER BY head.next_attempt_at, head.id
      )
      SELECT t.id FROM ready_heads h
      CROSS JOIN LATERAL (
        SELECT t.id FROM agent_chat_thread t
        WHERE t.id = h.thread_id AND t.agent_id = ${agent.id}
        FOR UPDATE SKIP LOCKED
      ) t
      LIMIT 1
    `);
    const thread = (threads as unknown as { id: string }[])[0];
    if (!thread) return [];
    // Re-read the first unfinished answer after taking the thread lock: a concurrent
    // claim may have committed while the thread selection used an earlier snapshot.
    return tx.execute(sql`
      UPDATE agent_chat_message m
      SET attempts = m.attempts + 1,
          status = 'streaming',
          content = '',
          started_at = coalesce(m.started_at, now()),
          next_attempt_at = now() + make_interval(secs => ${chat.leaseSeconds})
      WHERE m.id = (
        SELECT q.id FROM agent_chat_message q
        WHERE q.thread_id = ${thread.id}
          AND q.role = 'assistant'
          AND q.status IN ('pending', 'streaming')
        ORDER BY q.id
        LIMIT 1
      )
        AND m.status IN ('pending', 'streaming')
        AND m.next_attempt_at <= now()
        AND m.attempts < ${chat.maxAttempts}
      RETURNING
        m.id,
        m.thread_id AS "threadId",
        m.attempts,
        (SELECT u.name FROM agent_chat_thread t JOIN "user" u ON u.id = t.user_id
           WHERE t.id = m.thread_id) AS "requesterName",
        (SELECT u.username FROM agent_chat_thread t JOIN "user" u ON u.id = t.user_id
           WHERE t.id = m.thread_id) AS "requesterUsername",
        (SELECT cli_session_id FROM agent_chat_thread t WHERE t.id = m.thread_id) AS "sessionId"
    `);
  });
  const row = (rows as unknown as ClaimedRow[])[0];
  if (!row) return null;
  await db.delete(agentChatEvent).where(eq(agentChatEvent.messageId, row.id));
  // Outbound PII admission (8429 row 29, C): the chat answer's framed prompt is about
  // to leave the server for an external agent, so the pinned rule owner judges the
  // message's trusted native facts first. Both chat delivery modes share this
  // claimMessage path, so the gate covers the pull claim and the invocation push.
  // Refused before the handoff, and terminal, not retried: the answer was claimed, so
  // it is closed as a failure with the owner's named reason.
  const admission = await admitRunnerDelivery(db, {
    contextId: `chat-${row.id}`,
    rigPrefix: '',
    title: '',
    description: '',
    labels: [],
    columnState: '',
    agentUserId: agent.userId,
  });
  if (!admission.ok) {
    await finishMessage(agent.id, row.id, { status: 'failed', error: admission.message });
    return null;
  }
  // A thread bound to a live session on the runner's machine needs neither the earlier
  // turns nor the system prompt again: that session already holds both, in fuller form
  // than the transcript here keeps them.
  const resumed = row.sessionId !== null;
  const history = await readHistory(row.threadId, row.id, resumed ? 1 : chat.historyMessages);
  const question = history.pop()?.content ?? '';
  return {
    id: row.id,
    threadId: row.threadId,
    prompt: resumed ? question : frameChatPrompt(history, question),
    systemPrompt: resumed
      ? ''
      : buildSystemPrompt(agent, {
          name: row.requesterName ?? 'the member',
          username: row.requesterUsername,
        }),
    attempts: row.attempts,
    sessionId: row.sessionId,
  };
}

// The last `limit` turns before the claimed answer, oldest first. The last of them is the
// message being answered; a thread whose session already remembers everything before it
// takes just that one.
async function readHistory(
  threadId: string,
  beforeMessageId: number,
  limit: number,
): Promise<{ role: string; content: string }[]> {
  const rows = await db
    .select({ role: agentChatMessage.role, content: agentChatMessage.content })
    .from(agentChatMessage)
    .where(
      and(
        eq(agentChatMessage.threadId, threadId),
        sql`${agentChatMessage.id} < ${beforeMessageId}`,
        sql`length(${agentChatMessage.content}) > 0`,
      ),
    )
    .orderBy(desc(agentChatMessage.id))
    .limit(limit);
  return rows.reverse();
}

// What the agent is told before the task: the projects it works in, that a person is
// waiting in a chat, who that person is, and last the operator's own instructions,
// which therefore win over the generic parts. A chat is held with the agent rather
// than inside a project, so every project it reaches is named.
function buildSystemPrompt(agent: RunnerAgent, requester: Person): string {
  const instructions = agent.instructions?.trim();
  return (
    projectsPreamble(agent.projects) +
    chatModePreamble() +
    chartPreamble() +
    attachmentPreamble() +
    peoplePreamble({ requester }) +
    (instructions ? `## Instructions\n${instructions}\n` : '')
  );
}

// The counterpart of runModePreamble for a chat: here a human is present, so the
// autonomous-run rule about never asking questions does not apply.
function chatModePreamble(): string {
  return [
    '## Run mode',
    'You are in a chat with a person who is waiting for your reply in the app. What you',
    'print is what they read, so answer them directly and keep it short. Ask a clarifying',
    'question when you genuinely need one — unlike an autonomous run, someone is there to',
    'answer it.',
    '',
    '',
  ].join('\n');
}

function frameChatPrompt(history: { role: string; content: string }[], prompt: string): string {
  const lines: string[] = [];
  if (history.length > 0) {
    lines.push('Earlier in this conversation:', '');
    for (const m of history) {
      lines.push(`${m.role === 'user' ? 'Person' : 'You'}: ${m.content}`, '');
    }
  }
  lines.push('The person writes:', '', prompt);
  return lines.join('\n');
}

// The answer a runner call addresses: this agent's, and not finished yet.
export function liveAnswer(agentId: number, messageId: number) {
  return and(
    eq(agentChatMessage.id, messageId),
    eq(agentChatMessage.agentId, agentId),
    inArray(agentChatMessage.status, LIVE_STATUSES),
  );
}

// Whether the answer a runner call addressed was stopped from the chat, as opposed to
// not being this agent's or having ended some other way.
export async function wasCanceled(agentId: number, messageId: number): Promise<boolean> {
  const rows = await db
    .select({ status: agentChatMessage.status })
    .from(agentChatMessage)
    .where(and(eq(agentChatMessage.id, messageId), eq(agentChatMessage.agentId, agentId)))
    .limit(1);
  return rows[0]?.status === 'canceled';
}

// Closes the answer. A failure is terminal: the runner ran the command and it failed,
// so serving the same answer again would only repeat it.
export async function finishMessage(
  agentId: number,
  messageId: number,
  result: {
    status: 'success' | 'failed';
    error?: string | null;
    usage?: ContextUsage | null;
  },
): Promise<boolean> {
  await touchRunner(agentId);
  const rows = await db
    .update(agentChatMessage)
    .set({
      status: result.status,
      lastError:
        result.status === 'failed' ? (result.error?.slice(0, 500) ?? 'Answer failed') : null,
      finishedAt: new Date(),
    })
    .where(liveAnswer(agentId, messageId))
    .returning({ id: agentChatMessage.id, threadId: agentChatMessage.threadId });
  if (rows.length > 0) {
    // Undefined is a runner that said nothing about the context — an older one, or a
    // command that reports no counts at all — and the thread keeps the number it has.
    if (result.usage !== undefined) {
      await recordContextUsage(rows[0].threadId, agentId, result.usage);
    }
    return true;
  }
  // Stopped from the chat while the command was ending: the answer is already closed,
  // so there is nothing to record and nothing wrong.
  return wasCanceled(agentId, messageId);
}
