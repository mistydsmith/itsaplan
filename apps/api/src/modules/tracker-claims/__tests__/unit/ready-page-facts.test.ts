// One page of the ready pool must pay the user-stable facts once (sentinel-prod-8429.8): the
// actor kind is read once, the rule config is loaded once, and ONE manifest proof is handed to
// every gate call on the page. No database and no rule owner process: the transaction is a stub
// that answers exactly the queries judgeGatedClaim runs, and the gate is spied so no owner is
// spawned. RED on the pre-8429.8 base, where the actor kind is read twice per card and no proof
// is ever passed to the gate.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as gateReal from '@repo/db/tracker-gate';
import type { TrackerGateConfigState } from '@repo/db/tracker-gate';
import type { ClaimTransaction } from '@repo/db/issue-claim';
import * as rulesReal from '@repo/db/tracker-rules';
import type { TrackerRulesAnswer } from '@repo/db/tracker-rules';

// The pinned rule set one request loads. The config value is fake: no path points at a real
// owner, no sha is a real token, and the spied gate never spawns anything.
const CONFIGURED: TrackerGateConfigState = {
  state: 'configured',
  config: {
    python: '/pinned/rules',
    owner: '/pinned/owner',
    pythonSha256: 'a'.repeat(64),
    fileSha256: {},
    limits: {},
  },
};
const GOOD_PROOF: TrackerRulesAnswer = { ok: true, violations: [] };
const DRIFT_PROOF: TrackerRulesAnswer = {
  ok: false,
  code: 'tracker-rules-manifest-mismatch',
  message: 'a pinned file no longer matches its sha256',
};

type GateCall = { config?: unknown; proof?: unknown };
const gateCalls: GateCall[] = [];
let aiAgentSelects = 0;
let configLoads = 0;
let proofToMake: TrackerRulesAnswer | null = null;

// The stub gate records the call and refuses only on a bad proof, exactly like the transport:
// a proof this request made with the pinned files is the only thing that lets the owner run.
const spyGate = async (input: {
  rigId: number | null;
  op: Record<string, unknown>;
  config?: unknown;
  proof?: unknown;
}): Promise<void> => {
  gateCalls.push({ config: input.config, proof: input.proof });
  const proof = input.proof as TrackerRulesAnswer | null | undefined;
  if (proof !== undefined && proof !== null && proof.ok === false) {
    throw new gateReal.TrackerGateRefusal(
      'tracker-rules-manifest-mismatch',
      'a pinned file no longer matches its sha256',
    );
  }
};

// bun test runs the whole suite in one process (the package's --no-isolate), so the module
// mocks live only while this file's tests run: install them in beforeAll, put the real
// modules back in afterAll, and import the modules under test dynamically so they bind to
// whatever the mock table holds at that moment.
beforeAll(() => {
  mock.module('@repo/db/tracker-gate', () => ({
    ...gateReal,
    gateIssueWrite: spyGate,
    loadTrackerRulesConfig: async (): Promise<TrackerGateConfigState> => {
      configLoads += 1;
      return CONFIGURED;
    },
  }));
  mock.module('@repo/db/tracker-rules', () => ({
    ...rulesReal,
    verifyPinnedManifest: async (): Promise<TrackerRulesAnswer | null> => proofToMake,
  }));
});
afterAll(() => {
  mock.module('@repo/db/tracker-gate', () => ({ ...gateReal }));
  mock.module('@repo/db/tracker-rules', () => ({ ...rulesReal }));
});

// The transaction stub answers the raw queries judgeGatedClaim runs and counts the drizzle
// select the actor-kind read performs. One human user: no ai_agent row, so the skill receipts
// are never read.
const CARD = (id: number) => ({
  project_id: 7,
  title: `card ${id}`,
  description: `card ${id} body`,
  bead_id: `sentinel-prod-${id}`,
  claim_owner: null,
  claim_epoch: 3,
  expires_ms: null,
  column_name: 'In Progress',
  state_type: 'started',
  type_name: 'task',
});
const makeTx = () =>
  ({
    execute: async (query: { queryChunks?: unknown }) => {
      const text = JSON.stringify(query.queryChunks ?? []);
      if (text.includes('claim_owner')) return [CARD(1)];
      if (text.includes('bead_identity')) return [{ prefix: 'sentinel-prod', local_token: 1 }];
      if (text.includes('issue_label')) return [{ name: 'pii-free' }];
      if (text.includes('issue_link')) return [];
      if (text.includes('user_role')) return [{ user_role: null, member_role: 'owner' }];
      if (text.includes('clock_timestamp')) return [{ now_ms: 1000 }];
      return [];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            aiAgentSelects += 1;
            return [];
          },
        }),
      }),
    }),
  }) as unknown as ClaimTransaction;

describe('ready page gate facts (8429.8)', () => {
  test('a page of 25 cards pays the user-stable facts once and one proof for all 50 gates', async () => {
    gateCalls.length = 0;
    aiAgentSelects = 0;
    configLoads = 0;
    proofToMake = GOOD_PROOF;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const page = await pageGateFacts(tx, 'user-1');
    expect(page).not.toBeNull();
    expect(aiAgentSelects).toBe(1); // the actor kind is read once for the whole page
    expect(configLoads).toBe(1); // the rule config is loaded once for the whole page

    for (let id = 1; id <= 25; id += 1) {
      await judgeGatedClaim(
        tx,
        { issueId: id, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
        false,
        page,
      );
    }
    expect(aiAgentSelects).toBe(1); // and not once more, per card
    expect(gateCalls.length).toBe(50); // two gates per card: the state op and the claim op
    expect(gateCalls.every((call) => call.config === page!.config.config)).toBe(true);
    expect(gateCalls.every((call) => call.proof === page!.proof)).toBe(true);
  });

  test('a drift found after the page facts are made still refuses on the next request', async () => {
    gateCalls.length = 0;
    proofToMake = GOOD_PROOF;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();
    const clean = await pageGateFacts(tx, 'user-1');
    expect(clean).not.toBeNull();

    // A pinned byte changed between requests: the next page makes its own proof and the pins
    // no longer match. The page facts carry the bad proof, and the first gate refuses.
    proofToMake = DRIFT_PROOF;
    const drifted = await pageGateFacts(makeTx(), 'user-1');
    expect(drifted?.proof).toBe(DRIFT_PROOF);
    await expect(
      judgeGatedClaim(
        makeTx(),
        { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
        false,
        drifted,
      ),
    ).rejects.toThrow('tracker-rules-manifest-mismatch');
  });

  test('a card judged with the page facts is judged the same as a card judged without them', async () => {
    gateCalls.length = 0;
    proofToMake = GOOD_PROOF;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const withPage = await pageGateFacts(makeTx(), 'user-1');
    const a = await judgeGatedClaim(
      makeTx(),
      { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 3 },
      true,
      withPage,
    );
    const b = await judgeGatedClaim(
      makeTx(),
      { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 3 },
      true,
      null,
    );
    expect(a).toEqual(b);
    expect(a.actorKind).toBe('human');
  });
});
