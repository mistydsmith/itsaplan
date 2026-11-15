// The op a gated link or unlink hands the rule owner. No database: only the pure builder.
import { describe, expect, test } from 'bun:test';
import {
  linkOp,
  linkRole,
  routingCheckOp,
  type GatedCard,
  type LinkOpInput,
} from '../../gated-claim';

const card = (token: string): GatedCard => ({
  beadId: `sentinel-prod-${token}`,
  rigPrefix: 'sentinel-prod',
  title: `sentinel-prod-${token}: tidy a helper`,
  description: 'Plain work.',
  labels: ['pii_free'],
  columnState: 'unstarted',
});
const source = card('9001');
const target = card('9002');
const facts = {
  routing_facts: { bead_id: source.beadId, targets: [], pii_class: 'pii_free', grants: [] },
  actor_kind: 'agent',
  templates_skill_loaded: false,
  law_library_skill_loaded: false,
};
const held = (expected: number | null) => ({
  owner: 'user-1',
  epoch: 4,
  expires_at_ms: 1_700_000_060_000,
  now_ms: 1_700_000_000_000,
  actor: 'user-1',
  expected_epoch: expected,
});
const input = (over: Partial<LinkOpInput>): LinkOpInput => ({
  op: 'link',
  source,
  target,
  facts,
  role: 'worker',
  authorized: true,
  claims: { source: held(4), target: held(4) },
  ...over,
});

describe('linkOp', () => {
  test('a worker link is the source routing op with the link facts and both claim rows', () => {
    expect(linkOp(input({}))).toEqual({
      ...routingCheckOp(source, facts),
      op: 'link',
      link_target_id: 'sentinel-prod-9002',
      link_facts: {
        id: 'sentinel-prod-9001',
        target_id: 'sentinel-prod-9002',
        actor_role: 'worker',
        authorized: true,
      },
      claim_facts: held(4),
      target_claim_facts: held(4),
    });
  });

  test('the link fact ids are the op id and the op link target id', () => {
    const op = linkOp(input({ op: 'unlink' }));
    expect(op.op).toBe('unlink');
    expect(op.link_facts.id).toBe(op.id);
    expect(op.link_facts.target_id).toBe(op.link_target_id);
  });

  test.each(['coordinator', 'operator'] as const)('a %s op carries no claim rows', (role) => {
    const op = linkOp(input({ role })) as Record<string, unknown>;
    expect(Object.hasOwn(op, 'claim_facts')).toBe(false);
    expect(Object.hasOwn(op, 'target_claim_facts')).toBe(false);
    expect(op.link_facts).toMatchObject({ actor_role: role });
  });

  test('an epoch the worker did not send stays null, so the owner refuses it', () => {
    const op = linkOp(input({ claims: { source: held(null), target: held(4) } })) as {
      claim_facts: { expected_epoch: number | null };
    };
    expect(op.claim_facts.expected_epoch).toBeNull();
  });

  test('an authorization the server did not prove is passed as false', () => {
    expect(linkOp(input({ authorized: false })).link_facts.authorized).toBe(false);
  });

  test('it carries no proposed state and no caller field', () => {
    const op = linkOp(input({})) as Record<string, unknown>;
    for (const key of ['proposed_state', 'actor', 'claim_lane', 'link_target_claim_lane']) {
      expect(Object.hasOwn(op, key)).toBe(false);
    }
  });
});

describe('linkRole', () => {
  test('one project keeps its role', () => {
    expect(linkRole(['coordinator'])).toBe('coordinator');
    expect(linkRole(['worker'])).toBe('worker');
  });

  test('two projects keep a role only when it is the same in both', () => {
    expect(linkRole(['coordinator', 'coordinator'])).toBe('coordinator');
    expect(linkRole(['operator', 'operator'])).toBe('operator');
  });

  test('an owner of one project only is a worker', () => {
    expect(linkRole(['coordinator', 'worker'])).toBe('worker');
    expect(linkRole(['worker', 'coordinator'])).toBe('worker');
  });
});
