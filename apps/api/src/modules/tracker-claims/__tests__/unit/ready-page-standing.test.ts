// One ready page resolves the project standing ONCE for the whole page (sentinel-prod-9924):
// pageGateFacts runs getProjectAccess once, and every card on the page judges on that one read;
// the independent claim path (no page) keeps one getProjectAccess per card. Mocks only:
// #shared/access.getProjectAccess is spied to count calls and return a configurable access, the
// transaction is a stub that answers judgeGatedClaim, and the gate is spied so no owner spawns.
// RED on a base where judgeGatedClaim re-reads getProjectAccess once per card.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as gateReal from '@repo/db/tracker-gate';
import type { TrackerGateConfigState } from '@repo/db/tracker-gate';
import type { ClaimTransaction } from '@repo/db/issue-claim';
import * as rulesReal from '@repo/db/tracker-rules';
import type { TrackerRulesAnswer } from '@repo/db/tracker-rules';
import { emptyPermissions, fullPermissions } from '@repo/db';
import * as accessReal from '#shared/access';
import type { ProjectAccess } from '#shared/access';

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

// The access one standing lookup returns. CONFIGURE per test: full permissions makes the caller a
// coordinator (the effective workflow_config.edit), empty makes a worker, null makes a worker.
// No real member, workspace or grant is read.
const MEMBER_COORDINATOR: ProjectAccess = {
  role: 'member',
  permissions: fullPermissions(),
  via: 'member',
};
const MEMBER_WORKER: ProjectAccess = {
  role: 'member',
  permissions: emptyPermissions(),
  via: 'member',
};

let accessCalls = 0;
let standingToReturn: ProjectAccess | null = MEMBER_COORDINATOR;

const spyAccess = async (): Promise<ProjectAccess | null> => {
  accessCalls += 1;
  return standingToReturn;
};

// The spy gate records the effective role each claim op carries, so the page and the claim path
// can be shown to judge on the same verdict. No owner is spawned. Only the claim op carries
// readiness_facts; the routing op does not.
type ClaimOp = { op: 'claim'; readiness_facts?: { actor_role: string } };
const claimActorRoles: string[] = [];
const spyGate = async (input: { rigId: number; op: Record<string, unknown> }): Promise<void> => {
  const op = input.op as ClaimOp;
  if (op.op === 'claim' && op.readiness_facts) {
    claimActorRoles.push((op.readiness_facts as { actor_role: string }).actor_role);
  }
};

beforeAll(() => {
  mock.module('#shared/access', () => ({ getProjectAccess: spyAccess }));
  mock.module('@repo/db/tracker-gate', () => ({
    ...gateReal,
    gateIssueWrite: spyGate,
    loadTrackerRulesConfig: async (): Promise<TrackerGateConfigState> => CONFIGURED,
  }));
  mock.module('@repo/db/tracker-rules', () => ({
    ...rulesReal,
    verifyPinnedManifest: async (): Promise<TrackerRulesAnswer | null> => GOOD_PROOF,
  }));
});
afterAll(() => {
  // WHY 9924 witness: restore the real #shared/access namespace (51 modules import it; an empty
  // module would leak into any test file bun loads later in the same process). Matches the sibling
  // ready-page-facts.test.ts, which restores the real tracker-gate and tracker-rules namespaces.
  mock.module('#shared/access', () => accessReal);
  mock.module('@repo/db/tracker-gate', () => ({ ...gateReal }));
  mock.module('@repo/db/tracker-rules', () => ({ ...rulesReal }));
});

// One human member user (member_role 'member', user_role null): the effective standing — not the
// membership row — decides the role. The stub answers exactly the queries judgeGatedClaim runs.
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
      if (text.includes('user_role')) return [{ user_role: null, member_role: 'member' }];
      if (text.includes('clock_timestamp')) return [{ now_ms: 1000 }];
      return [];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  }) as unknown as ClaimTransaction;

describe('9924 one standing lookup per ready page', () => {
  test('a page of cards resolves the project standing once, not once per card', async () => {
    accessCalls = 0;
    claimActorRoles.length = 0;
    standingToReturn = MEMBER_COORDINATOR;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const page = await pageGateFacts(tx, 7, 'user-1');
    expect(page).not.toBeNull();
    expect(accessCalls).toBe(1); // once for the whole page, at page start

    const N = 5;
    for (let id = 1; id <= N; id += 1) {
      await judgeGatedClaim(
        tx,
        { issueId: id, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
        false,
        page,
      );
    }
    expect(accessCalls).toBe(1); // still once, not once per card
    expect(claimActorRoles).toHaveLength(N); // one claim op per card
    expect(claimActorRoles.every((role) => role === 'coordinator')).toBe(true);
  });

  test('the independent claim path reads the standing once per card', async () => {
    accessCalls = 0;
    claimActorRoles.length = 0;
    standingToReturn = MEMBER_COORDINATOR;
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const N = 5;
    for (let id = 1; id <= N; id += 1) {
      await judgeGatedClaim(
        tx,
        { issueId: id, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
        false,
        null,
      );
    }
    expect(accessCalls).toBe(N); // once per card, exactly as before 9924
    expect(claimActorRoles).toHaveLength(N);
    expect(claimActorRoles.every((role) => role === 'coordinator')).toBe(true);
  });

  test('a card judged with the page facts judges the same effective role as without them', async () => {
    accessCalls = 0;
    claimActorRoles.length = 0;
    standingToReturn = MEMBER_COORDINATOR;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const page = await pageGateFacts(tx, 7, 'user-1');
    await judgeGatedClaim(
      tx,
      { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 3 },
      true,
      page,
    );
    const withPage = [...claimActorRoles];
    claimActorRoles.length = 0;
    await judgeGatedClaim(
      tx,
      { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 3 },
      true,
      null,
    );
    const withoutPage = [...claimActorRoles];

    expect(withPage).toEqual(withoutPage); // same effective-role verdict, page or not
    expect(withoutPage.every((role) => role === 'coordinator')).toBe(true);
  });

  test('a null standing resolves to a worker and is still read once per page', async () => {
    accessCalls = 0;
    claimActorRoles.length = 0;
    standingToReturn = null;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const page = await pageGateFacts(tx, 7, 'user-1');
    expect(page?.standing).toBeNull();
    const N = 3;
    for (let id = 1; id <= N; id += 1) {
      await judgeGatedClaim(
        tx,
        { issueId: id, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
        false,
        page,
      );
    }
    expect(accessCalls).toBe(1); // read once for the page even when null
    expect(claimActorRoles).toHaveLength(N);
    expect(claimActorRoles.every((role) => role === 'worker')).toBe(true); // null access -> worker
  });

  test('a member without effective workflow_config.edit stays a worker on the page', async () => {
    accessCalls = 0;
    claimActorRoles.length = 0;
    standingToReturn = MEMBER_WORKER;
    const { pageGateFacts } = await import('../../readiness-facts');
    const { judgeGatedClaim } = await import('../../gated-claim');
    const tx = makeTx();

    const page = await pageGateFacts(tx, 7, 'user-1');
    expect(page?.standing).toBe(MEMBER_WORKER);
    await judgeGatedClaim(
      tx,
      { issueId: 1, rigId: 9, userId: 'user-1', expectedEpoch: 'locked' },
      false,
      page,
    );
    expect(accessCalls).toBe(1);
    expect(claimActorRoles.at(-1)).toBe('worker');
  });
});
