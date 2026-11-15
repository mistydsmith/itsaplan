// The two ops a gated claim hands the rule owner. No database: only the pure builders.
import { describe, expect, test } from 'bun:test';
import { claimOp, routingCheckOp, type GatedCard } from '../../gated-claim';
import type { ReadinessFacts } from '../../readiness-facts';

const card: GatedCard = {
  beadId: 'sentinel-prod-9001',
  rigPrefix: 'sentinel-prod',
  title: 'sentinel-prod-9001: tidy a helper',
  description: 'Plain work.',
  labels: ['pii_free'],
  columnState: 'unstarted',
};
const facts = {
  routing_facts: { bead_id: card.beadId, targets: [], pii_class: 'pii_free', grants: [] },
  actor_kind: 'agent',
  templates_skill_loaded: false,
  law_library_skill_loaded: false,
};
const claim = {
  owner: null,
  epoch: 0,
  expires_at_ms: null,
  now_ms: 1_700_000_000_000,
  actor: 'user-1',
  expected_epoch: 0,
};
const readiness: ReadinessFacts = {
  id: card.beadId,
  status: 'open',
  kind: 'task',
  dependencies: [],
  eligibility: true,
  operator_owned: false,
  actor_role: 'worker',
};

describe('routingCheckOp', () => {
  test('is a state op on the stored card with the routing and skill facts', () => {
    expect(routingCheckOp(card, facts)).toEqual({
      op: 'state',
      id: 'sentinel-prod-9001',
      rig_prefix: 'sentinel-prod',
      labels: ['pii_free'],
      previous_state: {
        title: 'sentinel-prod-9001: tidy a helper',
        description: 'Plain work.',
        labels: ['pii_free'],
        bead_id: 'sentinel-prod-9001',
        column_state: 'unstarted',
      },
      ...facts,
    });
  });

  test('carries no proposed state, no claim facts and no readiness facts', () => {
    const op = routingCheckOp(card, facts) as Record<string, unknown>;
    expect(Object.hasOwn(op, 'proposed_state')).toBe(false);
    expect(Object.hasOwn(op, 'claim_facts')).toBe(false);
    expect(Object.hasOwn(op, 'readiness_facts')).toBe(false);
  });

  test('a routing fact of null stays present, so the owner refuses it', () => {
    const op = routingCheckOp(card, { ...facts, routing_facts: null }) as Record<string, unknown>;
    expect(Object.hasOwn(op, 'routing_facts')).toBe(true);
    expect(op.routing_facts).toBeNull();
  });
});

describe('claimOp', () => {
  test('is the routing op as a claim, with the claim and readiness facts', () => {
    expect(claimOp(card, facts, claim, readiness)).toEqual({
      ...routingCheckOp(card, facts),
      op: 'claim',
      claim_facts: claim,
      readiness_facts: readiness,
    });
  });

  test('the readiness id is the op id', () => {
    const op = claimOp(card, facts, claim, readiness);
    expect(op.readiness_facts.id).toBe(op.id);
  });
});
