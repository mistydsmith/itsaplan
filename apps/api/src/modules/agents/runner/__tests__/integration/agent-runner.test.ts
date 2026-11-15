import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, agentRun } from '@repo/db';
import { checkTrackerRules, type TrackerRulesAnswer, type TrackerRulesConfig } from '@repo/db/tracker-rules';
import { and, eq } from 'drizzle-orm';
import * as piiAdmission from '../../../core/pii-admission';
import * as runnerService from '../../service';
import { apiKeyApi, authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createAgent, teamOf } from '#tests/helpers/agents';

// The runner queue: a process on the operator's machine authenticates with the
// external agent's API key, claims one run at a time, and reports the result. Runs
// are queued the normal way — a mention on an issue — since the runner routes only
// drain the queue, they never fill it.

async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const view = await asOwner.projects({ projectKey: 'MKT' }).get();
  const columnId = view.data!.columns[0].id;
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Ext Bot',
    username: 'ext',
    kind: 'external',
    triggerOnMention: true,
  });
  return {
    asOwner,
    columnId,
    agent: created.data!.agent,
    asRunner: apiKeyApi(created.data!.apiKey!),
  };
}

// Queues one run for the agent by mentioning it on a new issue.
async function queueRun(asOwner: Api, columnId: number, username: string) {
  const issue = (
    await asOwner.projects({ projectKey: 'MKT' }).issues.post({ columnId, title: 'Landing page' })
  ).data!;
  await asOwner.issues({ issueId: issue.id }).comments.post({ body: `please review @${username}` });
  return issue;
}

// The ops the synthetic owner was given, across both halves of the mutation pair.
const seenOps: Record<string, unknown>[] = [];

describe('agent runner queue', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('claims a queued run with its issue and prompt', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const issue = await queueRun(asOwner, columnId, agent.username);

    const res = await asRunner['agent-runs'].claim.post();
    expect(res.status).toBe(200);
    expect(res.data!.run).toMatchObject({
      trigger: 'mention',
      issueId: issue.id,
      attempts: 1,
    });
    expect(res.data!.run!.issueIdentifier).toBe(`MKT-${issue.sequenceNumber}`);
    // The prompt is framed the way an internal agent's is: what happened, what to do
    // about it, and the trigger text itself.
    expect(res.data!.run!.prompt).toContain('You were mentioned');
    expect(res.data!.run!.prompt).toContain('please review');
    expect(res.data!.run!.systemPrompt).toContain('Run mode');
  });

  it('logs on the issue that the agent picked the run up and how it ended', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const issue = await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'failed',
      error: 'claude exited with 1',
    });

    const feed = await asOwner.issues({ issueId: issue.id }).feed.get({ query: {} });
    expect(feed.data!.items).toContainEqual(
      expect.objectContaining({ action: 'agent_started', actorUserId: agent.userId }),
    );
    expect(feed.data!.items).toContainEqual(
      expect.objectContaining({
        action: 'agent_finished',
        payload: { subject: { value: 'failed' } },
        actorUserId: agent.userId,
      }),
    );
  });

  it("mixes the agent's own instructions into the system prompt", async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await asOwner
      .teams({ teamId: await teamOf(asOwner, 'MKT') })
      ['ai-agents']({ agentId: agent.id })
      .patch({ instructions: 'Always answer in German.' });
    await queueRun(asOwner, columnId, agent.username);

    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    expect(run.systemPrompt).toContain('Always answer in German.');
    expect(run.systemPrompt).toContain('Marketing');
  });

  it('returns null when the queue is empty', async () => {
    const { asRunner } = await setup();
    const res = await asRunner['agent-runs'].claim.post();
    expect(res.status).toBe(200);
    expect(res.data!.run).toBeNull();
  });

  it('hands a claimed run to no one else until its lease expires', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);

    expect((await asRunner['agent-runs'].claim.post()).data!.run).not.toBeNull();
    expect((await asRunner['agent-runs'].claim.post()).data!.run).toBeNull();
  });

  it('records a success and shows it in the run history', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    const res = await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'success',
      output: 'Opened PR #12',
    });
    expect(res.status).toBe(204);

    const history = await asOwner
      .teams({ teamId: await teamOf(asOwner, 'MKT') })
      ['ai-agents']({ agentId: agent.id })
      .runs.get({ query: {} });
    expect(history.data!.items[0]).toMatchObject({
      id: run.id,
      status: 'success',
      output: 'Opened PR #12',
    });
  });

  it('records a failure with its error', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'failed',
      error: 'claude exited with 1',
    });

    const history = await asOwner
      .teams({ teamId: await teamOf(asOwner, 'MKT') })
      ['ai-agents']({ agentId: agent.id })
      .runs.get({ query: {} });
    expect(history.data!.items[0]).toMatchObject({
      status: 'failed',
      lastError: 'claude exited with 1',
    });
  });

  it('rejects a result for a run that is already finished', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    await asRunner['agent-runs']({ runId: run.id }).result.post({ status: 'success' });

    const res = await asRunner['agent-runs']({ runId: run.id }).result.post({ status: 'success' });
    expect(res.status).toBe(404);
  });

  it("rejects another agent's run", async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    const other = await createAgent(asOwner, 'MKT', {
      name: 'Other Bot',
      username: 'other',
      kind: 'external',
    });
    const asOtherRunner = apiKeyApi(other.data!.apiKey!);

    expect(
      (await asOtherRunner['agent-runs']({ runId: run.id }).result.post({ status: 'success' }))
        .status,
    ).toBe(404);
    expect((await asOtherRunner['agent-runs']({ runId: run.id }).heartbeat.post()).status).toBe(
      404,
    );
  });

  it('keeps a claimed run leased through a heartbeat', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    expect((await asRunner['agent-runs']({ runId: run.id }).heartbeat.post()).status).toBe(204);
    expect((await asRunner['agent-runs']({ runId: run.id }).heartbeat.post()).status).toBe(204);
  });

  it('records presence on the agent when its runner polls', async () => {
    const { asOwner, asRunner, agent } = await setup();
    expect(
      (
        await asOwner
          .teams({ teamId: await teamOf(asOwner, 'MKT') })
          ['ai-agents']({ agentId: agent.id })
          .get()
      ).data!.lastSeenAt,
    ).toBeNull();

    await asRunner['agent-runs'].claim.post();

    const after = await asOwner
      .teams({ teamId: await teamOf(asOwner, 'MKT') })
      ['ai-agents']({ agentId: agent.id })
      .get();
    expect(after.data!.lastSeenAt).not.toBeNull();
  });

  it('refuses a caller that is not an agent', async () => {
    const { asOwner } = await setup();
    expect((await asOwner['agent-runs'].claim.post()).status).toBe(403);
  });

  it('hands a scheduled run to the runner with the task as its prompt', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const schedule = await asOwner.projects({ projectKey: 'MKT' })['agent-schedules'].post({
      agentId: agent.id,
      name: 'Nightly triage',
      prompt: 'Triage the new issues.',
      cron: '0 9 * * *',
    });
    expect(schedule.status).toBe(201);
    await asOwner
      .projects({ projectKey: 'MKT' })
      ['agent-schedules']({ scheduleId: schedule.data!.id })
      .run.post();

    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    expect(run).toMatchObject({ trigger: 'manual', issueId: null, issueIdentifier: null });
    expect(run.prompt).toContain('Triage the new issues.');
  });

  // Outbound PII admission (8429 row 29, B): the gate inside takeNextRun runs before the
  // framed prompt leaves the server. The control drives the ACTUAL production claim: a
  // run the (synthetic) rule owner refuses must fail permanently with the owner's named
  // reason, and no framed prompt is handed out. The one targeted mutation removes the
  // actual admitRunnerDelivery call from a throwaway copy of the real service source;
  // the same claim through the mutated copy must observe the forbidden framed prompt.
  // Synthetic data and transport only: the owner answer and the rule manifest; the
  // production seam is the imported service, not a re-implementation of it.
  it('refuses the run before the framed prompt leaves; the severed call hands it out', async () => {
    const { asOwner, agent, columnId } = await setup();
    await queueRun(asOwner, columnId, agent.username);
    await queueRun(asOwner, columnId, agent.username);

    const dir = mkdtempSync(join(tmpdir(), 'pii-admission-b-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pythonSha256: 'a'.repeat(64),
        fileSha256: { '/usr/bin/python3': 'a'.repeat(64) },
        routing: {
          lanes: {
            [agent.username.toLowerCase()]: { execution: 'cloud' },
            'local-lane': { execution: 'local' },
          },
          grants: [],
        },
      }),
    );
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({
      TRACKER_RULES_PYTHON: '/usr/bin/python3',
      TRACKER_RULES_OWNER: join(dir, 'owner.py'),
      TRACKER_RULES_MANIFEST: manifestPath,
    })) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    const ownerMessage = 'unknown-privacy work may not be routed to a cloud lane';
    const owner = async (
      _config: TrackerRulesConfig,
      op: Record<string, unknown>,
    ): Promise<TrackerRulesAnswer> => {
      seenOps.push(op);
      return { ok: false, code: 'tracker-rules-nonzero-exit', message: ownerMessage };
    };
    piiAdmission.setPiiAdmissionOwner(owner);
    const agentRow = (await runnerService.getRunnerAgent(agent.userId))!;
    try {
      const control = await runnerService.takeNextRun(agentRow);
      console.log('[control] claim:', JSON.stringify(control), '(refused before framing)');
      expect(control).toBeNull();
      // Permanent, named, no retry: the run row holds the owner's words, not a retry.
      const [failed] = await db
        .select()
        .from(agentRun)
        .where(and(eq(agentRun.agentId, agentRow.id), eq(agentRun.status, 'failed')))
        .limit(1);
      expect(failed).toMatchObject({ status: 'failed', lastError: ownerMessage });
      // The op the owner was given: the routing-decision state shape on the run's
      // trusted native facts, with the dispatch context id for a bead-less issue.
      const op = seenOps.at(-1)!;
      expect(op.op).toBe('state');
      expect(op.id).toBe(`run-${failed.id}`);
      expect(op).not.toHaveProperty('proposed_state');
      expect(op.routing_facts).toMatchObject({
        targets: [{ lane: agent.username.toLowerCase(), execution: 'cloud' }],
      });

      // The one targeted mutation: remove the actual gate call from a throwaway copy
      // of the real service source and run the same claim through the mutated copy.
      const servicePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'service.ts');
      const source = readFileSync(servicePath, 'utf8');
      const GATE =
        /[ ]{2}\/\/ Outbound PII admission \(8429 row 29, B\):[\s\S]*?[ ]{2}if \(!admission\.ok\) \{\n[ ]{4}await markRunFailed\(row\.id, admission\.message\);\n[ ]{4}return null;\n[ ]{2}\}\n/;
      expect(source).toMatch(GATE);
      const mutated = source.replace(GATE, '');
      expect(mutated).not.toBe(source);
      const mutantPath = join(dirname(servicePath), `service.mutant-${process.pid}.ts`);
      writeFileSync(mutantPath, mutated);
      try {
        const mutant = await import(pathToFileURL(mutantPath).href);
        // The mutated copy imports the same landed helper module, so the synthetic
        // owner is already its seam; the copy only lacks the actual gate call.
        const forbidden = await mutant.takeNextRun(agentRow);
        console.log(
          '[mutant]  claim prompt handed out:',
          JSON.stringify(forbidden?.prompt?.slice(0, 60)),
          '(actual gate call severed -> forbidden dispatch observed)',
        );
        expect(forbidden).not.toBeNull();
        expect(forbidden!.prompt).toContain('You were mentioned');
        expect(forbidden!.prompt).toContain('please review');
      } finally {
        rmSync(mutantPath, { force: true });
      }
    } finally {
      piiAdmission.setPiiAdmissionOwner(checkTrackerRules);
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
