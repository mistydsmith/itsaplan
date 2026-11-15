// Non-DB tests for the routing facts a gated write hands the rule owner. The facts are built from
// a manifest routing section and lane names, then judged by the real rule owner program, so the
// refusal and the allow are the owner's own answers and not a copy of its rules. No database, no
// HTTP. The owner is read-only: the run uses -B and writes nothing.
// Run from packages/db: bun test --env-file=/dev/null src/__tests__/tracker_routing_facts.test.ts

import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import {
  buildRoutingFacts,
  parseRoutingPolicy,
  routingAppliesToActor,
  routingPolicyProblem,
} from '../tracker-routing-facts';

// Root's immutable composed owner export (Sentinel 07a7bde25b). The working files under
// sentinel-prod/tools can differ from the landed owner, so they are never the owner under test.
const OWNER_CONFIG =
  process.env.TRACKER_ROUTING_TEST_CONFIG ??
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/CONFIG.json';
const { python: PYTHON, owner: OWNER } = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as {
  python: string;
  owner: string;
};
const BEAD = 'sentinel-prod-9001';

const ROUTING = {
  lanes: {
    qwen2: { execution: 'local' },
    codex_prime: { execution: 'cloud' },
    gemini: { execution: 'cloud', client_data_cleared: true },
  },
  grants: [
    {
      bead_id: 'sentinel-prod-8392',
      lane: 'gemini',
      role: 'reviewer' as const,
      scope: 'gemini_8392_review',
      reason: 'Misty 2026-11-13: Gemini reviews the 8392 ranges',
    },
  ],
};
const policy = parseRoutingPolicy(ROUTING);

interface Violation {
  rule: string;
  message: string;
}

async function owner(op: Record<string, unknown>): Promise<Violation[]> {
  const child = Bun.spawn([PYTHON, '-B', OWNER, '--check-op'], {
    stdin: new TextEncoder().encode(JSON.stringify(op)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin' },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // The owner exits 0 with a JSON list, empty or not. Anything else is an owner failure, and it
  // must fail the case instead of reading as "no violations".
  if (code !== 0 || err.trim() !== '')
    throw new Error(`rule owner failed (exit ${code}): ${err.trim() || out.trim()}`);
  const answer: unknown = JSON.parse(out);
  if (!Array.isArray(answer)) throw new Error(`rule owner answered no list: ${out.trim()}`);
  return answer as Violation[];
}

// The update op shape buildUpdateOp sends, with one lane left holding the card.
function updateOp(input: {
  beadId?: string;
  lane: string;
  labels: string[];
  description?: string;
  routing_facts: unknown;
}): Record<string, unknown> {
  const beadId = input.beadId ?? BEAD;
  const state = {
    // The owner's id rule wants the title to begin with the card's own token.
    title: `${beadId.slice('sentinel-prod-'.length)}: routing seam case`,
    description: input.description ?? 'A card for the routing seam.',
    labels: input.labels,
    bead_id: beadId,
    column_state: 'unstarted',
    parent_id: null,
  };
  return {
    op: 'update',
    id: beadId,
    rig_prefix: 'sentinel-prod',
    labels: input.labels,
    previous_state: { ...state, assignee_user_id: null, delegate_user_id: null },
    proposed_state: { ...state, assignee_user_id: null, delegate_user_id: 'user-1' },
    delegate: input.lane,
    routing_facts: input.routing_facts,
  };
}

function routingViolations(violations: Violation[]): Violation[] {
  return violations.filter((v) => v.message.includes('lane') || v.rule.includes('rout'));
}

function facts(lane: string, labels: string[], beadId = BEAD) {
  const built = buildRoutingFacts(policy, { beadId, lanes: [lane], labels });
  if (!built.ok) throw new Error(built.message);
  return built.facts;
}

test('a valid routing section has no problem and a malformed one names it', () => {
  expect(routingPolicyProblem(ROUTING)).toBeNull();
  expect(routingPolicyProblem({ lanes: { Qwen2: { execution: 'local' } } })).toContain('lowercase');
  expect(routingPolicyProblem({ lanes: { qwen2: { execution: 'office' } } })).toContain(
    'local or cloud',
  );
  expect(routingPolicyProblem({ lanes: { qwen2: {} } })).toContain('local or cloud');
  expect(
    routingPolicyProblem({
      lanes: {},
      grants: [{ bead_id: BEAD, lane: 'qwen2', role: 'author', scope: 's', reason: 'r' }],
    }),
  ).toContain('no lanes entry');
  expect(
    routingPolicyProblem({
      lanes: { a: { execution: 'local', client_data_cleared: 'x' } },
    }),
  ).toContain('boolean');
});

test('a lane with no manifest entry refuses and is never defaulted to local', () => {
  const built = buildRoutingFacts(policy, { beadId: BEAD, lanes: ['Ornith'], labels: [] });
  expect(built).toMatchObject({ ok: false });
  if (!built.ok) expect(built.message).toContain('lane ornith has no execution entry');
  expect(
    buildRoutingFacts(undefined, { beadId: BEAD, lanes: ['qwen2'], labels: [] }),
  ).toMatchObject({ ok: false });
});

test('the lane token is case-folded, the default role is author, and a person adds no target', () => {
  expect(facts(' Qwen2 ', ['size-small']).targets).toEqual([
    { lane: 'qwen2', execution: 'local', role: 'author', client_data_cleared: false },
  ]);
  const none = buildRoutingFacts(policy, { beadId: BEAD, lanes: [], labels: ['pii:pii_free'] });
  expect(none).toEqual({
    ok: true,
    facts: { bead_id: BEAD, targets: [], pii_class: 'pii_free', grants: [] },
  });
});

test('one pii label is the class; none or two is no class', () => {
  expect(facts('qwen2', ['size-small', 'PII:Local_Safe']).pii_class).toBe('local_safe');
  expect(facts('qwen2', ['size-small']).pii_class).toBeNull();
  expect(facts('qwen2', ['pii:pii_free', 'pii:local_safe']).pii_class).toBeNull();
});

test('the bare pii_free label from imported cards is the same class as pii:pii_free', () => {
  expect(facts('qwen2', ['size-small', 'pii_free']).pii_class).toBe('pii_free');
  expect(facts('qwen2', ['PII_Free', 'pii:pii_free']).pii_class).toBe('pii_free');
  // Labels that state different classes are no class, whichever form they take.
  expect(facts('qwen2', ['pii_free', 'pii:local_safe']).pii_class).toBeNull();
  expect(facts('qwen2', ['pii_free', 'pii']).pii_class).toBeNull();
  expect(facts('qwen2', ['pii']).pii_class).toBe('pii');
  // Only the two exact bare names are read: a lookalike label states nothing.
  expect(facts('qwen2', ['pii_free_sanitized']).pii_class).toBeNull();
  expect(facts('qwen2', ['not_pii_free', 'pii-free']).pii_class).toBeNull();
});

test('the owner allows a cloud lane on a bare pii_free card and refuses once pii is added', async () => {
  const labels = ['size-small', 'pii_free'];
  const allowed = await owner(
    updateOp({ lane: 'codex_prime', labels, routing_facts: facts('codex_prime', labels) }),
  );
  expect(routingViolations(allowed)).toEqual([]);
  const mixed = [...labels, 'pii'];
  const refused = await owner(
    updateOp({ lane: 'codex_prime', labels: mixed, routing_facts: facts('codex_prime', mixed) }),
  );
  expect(refused.map((v) => v.message).join('\n')).toContain('cloud execution target');
});

test('a grant reaches the owner only for its own card and lane', () => {
  const granted = facts('gemini', [], 'sentinel-prod-8392');
  expect(granted.targets).toEqual([
    { lane: 'gemini', execution: 'cloud', role: 'reviewer', client_data_cleared: true },
  ]);
  expect(granted.grants).toEqual([{ ...ROUTING.grants[0], authorized: true }]);
  const other = facts('gemini', []);
  expect(other.targets[0].role).toBe('author');
  expect(other.grants).toEqual([]);
});

test('the owner refuses a Qwen lane on a legal-template card', async () => {
  const labels = ['size-small', 'legal-template'];
  const violations = await owner(
    updateOp({ lane: 'qwen2', labels, routing_facts: facts('qwen2', labels) }),
  );
  expect(violations.map((v) => v.message).join('\n')).toContain(
    "lane 'qwen2' is refused on law-library or legal-template work",
  );
});

test('the owner allows an eligible lane on the same legal-template card', async () => {
  const labels = ['size-small', 'legal-template', 'pii:pii_free'];
  const violations = await owner(
    updateOp({ lane: 'codex_prime', labels, routing_facts: facts('codex_prime', labels) }),
  );
  expect(routingViolations(violations)).toEqual([]);
});

test('the owner allows a Qwen lane on an ordinary card and refuses missing facts', async () => {
  const labels = ['size-small'];
  const allowed = await owner(
    updateOp({ lane: 'qwen2', labels, routing_facts: facts('qwen2', labels) }),
  );
  expect(allowed).toEqual([]);
  const missing = await owner(updateOp({ lane: 'qwen2', labels, routing_facts: null }));
  expect(missing.map((v) => v.message).join('\n')).toContain('routing needs routing_facts');
});

// The create op shape createIssue sends for a root card, with the facts for the agents it names.
function createOp(input: {
  description: string;
  labels: string[];
  lanes: string[];
  proposedAssignee?: string;
}): Record<string, unknown> {
  const title = '9001: routing seam case';
  return {
    op: 'create',
    id: BEAD,
    rig_prefix: 'sentinel-prod',
    existing_ids: [],
    root_high_water: 9000,
    parent_id: null,
    title,
    description: input.description,
    labels: input.labels,
    existing_titles: {},
    actor_kind: 'human',
    templates_skill_loaded: false,
    law_library_skill_loaded: false,
    ...(input.proposedAssignee ? { proposed_assignee: input.proposedAssignee } : {}),
    routing_facts: (() => {
      const built = buildRoutingFacts(policy, {
        beadId: BEAD,
        lanes: input.lanes,
        labels: input.labels,
      });
      if (!built.ok) throw new Error(built.message);
      return built.facts;
    })(),
    proposed_state: {
      labels: input.labels,
      title,
      description: input.description,
      bead_id: BEAD,
      parent_id: null,
    },
  };
}

test('the owner allows a create that names nobody and one whose named lane is a target', async () => {
  const labels = ['size-small'];
  expect(await owner(createOp({ description: 'Plain card.', labels, lanes: [] }))).toEqual([]);
  expect(
    await owner(createOp({ description: 'For @qwen2 to pick up.', labels, lanes: ['qwen2'] })),
  ).toEqual([]);
  expect(
    await owner(
      createOp({ description: 'Held.', labels, lanes: ['qwen2'], proposedAssignee: 'qwen2' }),
    ),
  ).toEqual([]);
});

test('the owner refuses a create whose mention or holder has no target or breaks a lane rule', async () => {
  const labels = ['size-small'];
  const text = (violations: Violation[]) => violations.map((v) => v.message).join('\n');
  // A named fleet lane with no agent behind it resolves to no target.
  expect(
    text(await owner(createOp({ description: 'For @qwen2 to pick up.', labels, lanes: [] }))),
  ).toContain('routing_facts.targets is empty');
  expect(
    text(await owner(createOp({ description: 'For @qwen2.', labels, lanes: ['gemini'] }))),
  ).toContain('qwen2 but that lane is not in routing_facts.targets');
  // A cloud lane named on a card with no pii class.
  expect(
    text(await owner(createOp({ description: 'For @gemini.', labels, lanes: ['gemini'] }))),
  ).toContain('cloud execution target');
  // A Qwen lane named on a legal-template card.
  const legal = ['size-small', 'legal-template'];
  expect(
    text(await owner(createOp({ description: 'For @qwen2.', labels: legal, lanes: ['qwen2'] }))),
  ).toContain("lane 'qwen2' is refused on law-library or legal-template work");
});

test('the owner refuses a cloud lane on a card with no pii class', async () => {
  const labels = ['size-small'];
  const violations = await owner(
    updateOp({ lane: 'codex_prime', labels, routing_facts: facts('codex_prime', labels) }),
  );
  expect(violations.map((v) => v.message).join('\n')).toContain('cloud execution target');
});

// The label op shape gatedLabelSave sends: the stored title and description on both sides, the
// label lists changed, nobody holding the card.
function labelOp(input: {
  description: string;
  before: string[];
  after: string[];
  lanes?: string[];
}): Record<string, unknown> {
  const title = '9001: routing seam case';
  const state = { title, description: input.description, bead_id: BEAD };
  const op: Record<string, unknown> = {
    op: 'label',
    id: BEAD,
    rig_prefix: 'sentinel-prod',
    title,
    description: input.description,
    labels: input.after,
    previous_state: { ...state, labels: input.before },
    proposed_state: { ...state, labels: input.after },
  };
  if (input.lanes) {
    const built = buildRoutingFacts(policy, {
      beadId: BEAD,
      lanes: input.lanes,
      labels: input.after,
    });
    if (!built.ok) throw new Error(built.message);
    op.routing_facts = built.facts;
  }
  return op;
}

test('the owner judges a label change on an unheld card by the lanes its stored text names', async () => {
  const before = ['size-small'];
  const after = ['size-large'];
  const text = (violations: Violation[]) => violations.map((v) => v.message).join('\n');
  // Nobody holds the card and its text names nobody: empty targets are accepted.
  expect(await owner(labelOp({ description: 'Plain card.', before, after, lanes: [] }))).toEqual(
    [],
  );
  // The stored text names a lane and an agent stands behind it.
  const named = 'Stored note for @qwen2.';
  expect(await owner(labelOp({ description: named, before, after, lanes: ['qwen2'] }))).toEqual([]);
  // The same text with no agent behind the name.
  expect(text(await owner(labelOp({ description: named, before, after, lanes: [] })))).toContain(
    'routing_facts.targets is empty',
  );
  // The change moves the card into a domain that lane is refused on.
  const legal = ['size-small', 'legal-template'];
  const moved = { description: named, before, after: legal };
  expect(text(await owner(labelOp({ ...moved, lanes: ['qwen2'] })))).toContain(
    "lane 'qwen2' is refused on law-library or legal-template work",
  );
  // Without the facts key the owner's legacy answer reads no mention, so the same move raises no
  // lane refusal. This is why gatedLabelSave sends facts on every real change.
  expect(text(await owner(labelOp(moved)))).not.toContain("lane 'qwen2'");
});

test('a label move into law-library with a valid compliance block is answered by the lane rule', async () => {
  // The block satisfies the law-library rule, so the lane refusal is the first and only answer.
  const block = [
    'LAW LIBRARY COMPLIANCE:',
    "(a) SOURCES ARE SETTLED: Misty's source ruling for this card, pasted verbatim.",
    '(b) text source, comment source, act window all verified for the code touched.',
    '(c) no comment rows touched.',
    '(d) byte copy, never retyped.',
  ].join('\n');
  const violations = await owner(
    labelOp({
      description: `${block}\nStored note for @qwen2.`,
      before: ['size-small'],
      after: ['size-small', 'law-library'],
      lanes: ['qwen2'],
    }),
  );
  expect(violations.map((v) => v.rule)).toEqual(['lane-routing']);
  expect(violations[0].message).toContain(
    "lane 'qwen2' is refused on law-library or legal-template work",
  );
});

// 8429 (Misty 2026-11-15): "i guarantee you EVERY block will block me too". Whether the routing policy is applied at all is one
// decision, taken on the actor kind the caller read from the database. A person is not a lane; an agent and a system write are
// judged by the routing policy exactly as before.
test('a person is not routed, so no lane problem is decided against her', () => {
  expect(routingAppliesToActor('human')).toBe(false);
});
test('an agent, a system write and an unread kind all keep the routing policy', () => {
  expect(routingAppliesToActor('agent')).toBe(true);
  expect(routingAppliesToActor('system')).toBe(true);
  expect(routingAppliesToActor(undefined)).toBe(true);
});
