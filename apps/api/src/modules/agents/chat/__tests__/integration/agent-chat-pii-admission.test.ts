// 8429 row 29, C — the outbound PII admission pair for the chat delivery leaf.
//
// Sibling leaf, not an append to agent-chat.test.ts: that file is already over the
// 400-line module limit, and scripts/module-size-guard.ts refuses any growth of a file
// that is over the limit at HEAD (Root ruling via CT, 2026-11-15). This leaf holds the
// control and the one targeted mutation; agent-chat.test.ts stays byte-identical.
//
// The pair drives the ACTUAL production takeNextMessage. The control: an owned
// PII-bearing queued answer on a lane the rule manifest routes to a cloud execution
// must be refused before its framed prompt leaves the server, and the refusal is
// terminal with the owner's named reason. The one targeted mutation: the actual gate
// call removed from a throwaway copy of the real delivery source; the same claim
// through the mutated copy must hand out the forbidden framed prompt.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { agentChatMessage, db } from '@repo/db';
import {
  checkTrackerRules,
  type TrackerRulesAnswer,
  type TrackerRulesConfig,
} from '@repo/db/tracker-rules';
import { apiKeyApi, authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { createAgent } from '#tests/helpers/agents';
import * as chatService from '../../service';
import { getRunnerAgent } from '../../../runner/service';
import * as piiAdmission from '../../../core/pii-admission';

async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Ext Bot',
    username: 'ext',
    kind: 'external',
  });
  return {
    owner,
    asOwner,
    agent: created.data!.agent,
    asRunner: apiKeyApi(created.data!.apiKey!),
  };
}

function send(api: Api, agentId: number, prompt: string) {
  return api.projects({ projectKey: 'MKT' })['ai-agents']({ agentId }).chat.post({ prompt });
}

describe('outbound PII admission on the claimed chat answer', () => {
  it('refuses a claimed answer before its framed prompt leaves; the severed gate hands it out', async () => {
    const { asOwner, agent } = await setup();
    // One owned, PII-bearing queued answer on the agent's chat feed.
    const sent = await send(asOwner, agent.id, 'Draft the lease renewal for the Smith family property file.');
    expect(sent.status).toBe(200);
    const messageId = sent.data!.messageId;

    const dir = mkdtempSync(join(tmpdir(), 'pii-admission-c-'));
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
    // The synthetic owner answer goes through the helper's landed seam, so the owner
    // python is never executed: a stub stands in the environment the config wants.
    const stubOwner = join(dir, 'owner.py');
    writeFileSync(stubOwner, '# synthetic seam: never executed, the seam replaces the owner\n');
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({
      TRACKER_RULES_PYTHON: '/usr/bin/python3',
      TRACKER_RULES_OWNER: stubOwner,
      TRACKER_RULES_MANIFEST: manifestPath,
    })) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    const ownerMessage = 'unknown-privacy work may not be routed to a cloud lane';
    const seenOps: Record<string, unknown>[] = [];
    const owner = async (
      _config: TrackerRulesConfig,
      op: Record<string, unknown>,
    ): Promise<TrackerRulesAnswer> => {
      seenOps.push(op);
      return { ok: false, code: 'tracker-rules-nonzero-exit', message: ownerMessage };
    };
    piiAdmission.setPiiAdmissionOwner(owner);
    const agentRow = (await getRunnerAgent(agent.userId))!;
    try {
      const control = await chatService.takeNextMessage(agentRow);
      console.log('[control] claim:', JSON.stringify(control), '(refused before framing)');
      expect(control).toBeNull();
      // Terminal, named, no retry: the answer row holds the owner's words and its
      // failed status takes it out of the claim's reach for good.
      const [failed] = await db
        .select({ status: agentChatMessage.status, lastError: agentChatMessage.lastError })
        .from(agentChatMessage)
        .where(and(eq(agentChatMessage.id, messageId)));
      expect(failed).toMatchObject({ status: 'failed', lastError: ownerMessage });
      // The op the owner was given: the state shape on the chat's dispatch context id,
      // no proposed_state, targeting the agent's cloud lane.
      const op = seenOps.at(-1)!;
      expect(op.op).toBe('state');
      expect(op.id).toBe(`chat-${messageId}`);
      expect(op).not.toHaveProperty('proposed_state');
      expect(op.routing_facts).toMatchObject({
        targets: [{ lane: agent.username.toLowerCase(), execution: 'cloud' }],
      });

      // The one targeted mutation: remove the actual gate call from a throwaway copy
      // of the real delivery source and claim the same owned answer through the copy.
      const deliveryPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'delivery.ts');
      const source = readFileSync(deliveryPath, 'utf8');
      const GATE =
        /[ ]{2}\/\/ Outbound PII admission \(8429 row 29, C\):[\s\S]*?[ ]{2}if \(!admission\.ok\) \{\n[ ]{4}await finishMessage\(agent\.id, row\.id, \{ status: 'failed', error: admission\.message \}\);\n[ ]{4}return null;\n[ ]{2}\}\n/;
      expect(source).toMatch(GATE);
      const mutated = source.replace(GATE, '');
      expect(mutated).not.toBe(source);
      const mutantPath = join(dirname(deliveryPath), `delivery.mutant-${process.pid}.ts`);
      writeFileSync(mutantPath, mutated);
      try {
        const mutant = await import(pathToFileURL(mutantPath).href);
        const forbidden = await mutant.takeNextMessage(agentRow);
        console.log(
          '[mutant]  claim prompt handed out:',
          JSON.stringify(forbidden?.prompt?.slice(0, 60)),
          '(actual gate call severed -> forbidden handoff observed)',
        );
        expect(forbidden).not.toBeNull();
        expect(forbidden!.prompt).toContain('The person writes');
        expect(forbidden!.prompt).toContain('Smith family property file');
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
