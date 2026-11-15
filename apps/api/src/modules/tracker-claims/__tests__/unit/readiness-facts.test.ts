import { describe, expect, test } from 'bun:test';
import {
  actorRole,
  buildReadinessFacts,
  operatorOwned,
  readinessKind,
  readinessStatus,
  type ReadinessInput,
} from '../../readiness-facts';

const column = (name: string, stateType: string) => ({ name, stateType });

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  beadId: 'sentinel-prod-1',
  column: column('Todo', 'unstarted'),
  typeName: 'Task',
  labels: [],
  prerequisites: [],
  userRole: 'user',
  memberRole: 'member',
  routingAllowed: true,
  ...over,
});

describe('readinessStatus', () => {
  test('maps the state type of an ordinary column', () => {
    expect(readinessStatus(column('Backlog', 'backlog'))).toBe('open');
    expect(readinessStatus(column('Todo', 'unstarted'))).toBe('open');
    expect(readinessStatus(column('Doing', 'started'))).toBe('in_progress');
    expect(readinessStatus(column('Done', 'completed'))).toBe('closed');
    expect(readinessStatus(column('Dropped', 'canceled'))).toBe('canceled');
  });

  test('a preserved column name overrides the state type', () => {
    expect(readinessStatus(column('Review', 'started'))).toBe('review');
    expect(readinessStatus(column('Needs Human', 'started'))).toBe('needs-human');
    expect(readinessStatus(column('Human-Review', 'unstarted'))).toBe('human-review');
    expect(readinessStatus(column('Blocked', 'unstarted'))).toBe('blocked');
    expect(readinessStatus(column('Deferred', 'backlog'))).toBe('deferred');
  });

  test('a terminal state type wins over a preserved name', () => {
    expect(readinessStatus(column('Review', 'completed'))).toBe('closed');
    expect(readinessStatus(column('Blocked', 'canceled'))).toBe('canceled');
  });

  test('a near-miss name is not a preserved name', () => {
    expect(readinessStatus(column('review', 'started'))).toBe('in_progress');
    expect(readinessStatus(column('In Review', 'started'))).toBe('in_progress');
    expect(readinessStatus(column('Needs human', 'started'))).toBe('in_progress');
  });

  test('an unknown state type is no status', () => {
    expect(readinessStatus(column('Todo', 'triage'))).toBeNull();
    expect(readinessStatus(column('constructor', 'toString'))).toBeNull();
  });
});

describe('readinessKind', () => {
  test('maps the named types, ignoring case and outer spaces', () => {
    for (const name of ['Task', 'bug', 'Feature', 'chore', 'decision', 'spike', 'event'])
      expect(readinessKind(name)).toBe('task');
    expect(readinessKind('merge-request')).toBe('task');
    expect(readinessKind('molecule')).toBe('task');
    expect(readinessKind(' Epic ')).toBe('epic');
    expect(readinessKind('SLOT')).toBe('slot');
  });

  test('no type, or a type no table names, is no kind', () => {
    expect(readinessKind(null)).toBeNull();
    expect(readinessKind('')).toBeNull();
    expect(readinessKind('Story')).toBeNull();
    expect(readinessKind('constructor')).toBeNull();
  });
});

describe('operatorOwned and actorRole', () => {
  test('only the stored marker label makes a card operator owned', () => {
    expect(operatorOwned(['pii_free', 'operator-owned'])).toBe(true);
    expect(operatorOwned([' Operator-Owned '])).toBe(true);
    expect(operatorOwned(['operator', 'owner:misty', 'operator-owned-not'])).toBe(false);
    expect(operatorOwned([])).toBe(false);
  });

  test('the role is the project authorization of the user', () => {
    expect(actorRole('god', null)).toBe('operator');
    expect(actorRole('god', 'member')).toBe('operator');
    expect(actorRole('user', 'owner')).toBe('coordinator');
    expect(actorRole('user', 'member')).toBe('worker');
    expect(actorRole(null, null)).toBe('worker');
    expect(actorRole('GOD', 'Owner')).toBe('worker');
  });
});

describe('buildReadinessFacts', () => {
  test('builds the seven facts of a ready task', () => {
    const built = buildReadinessFacts(
      input({
        prerequisites: [
          { beadId: 'sentinel-prod-2', column: column('Done', 'completed') },
          { beadId: 'other-rig-7', column: column('Review', 'started') },
        ],
      }),
    );
    expect(built).toEqual({
      ok: true,
      facts: {
        id: 'sentinel-prod-1',
        status: 'open',
        kind: 'task',
        dependencies: [
          { id: 'sentinel-prod-2', status: 'closed' },
          { id: 'other-rig-7', status: 'review' },
        ],
        eligibility: true,
        operator_owned: false,
        actor_role: 'worker',
      },
    });
  });

  test('eligibility is the routing answer, never a constant', () => {
    const built = buildReadinessFacts(input({ routingAllowed: false }));
    expect(built.ok && built.facts.eligibility).toBe(false);
  });

  test('blocked, epic and operator-owned cards keep their true facts', () => {
    const built = buildReadinessFacts(
      input({
        column: column('Blocked', 'unstarted'),
        typeName: 'Epic',
        labels: ['operator-owned'],
      }),
    );
    expect(built.ok && built.facts).toMatchObject({
      status: 'blocked',
      kind: 'epic',
      operator_owned: true,
    });
  });

  test('a card with an unproven fact is reported, not defaulted', () => {
    const reason = (over: Partial<ReadinessInput>) => {
      const built = buildReadinessFacts(input(over));
      return built.ok ? 'built' : built.reason;
    };
    expect(reason({ column: column('Todo', 'triage') })).toBe('status-unknown');
    expect(reason({ typeName: null })).toBe('kind-unknown');
    expect(reason({ typeName: 'Story' })).toBe('kind-unknown');
    expect(reason({ prerequisites: [{ beadId: null, column: column('Done', 'completed') }] })).toBe(
      'dependency-without-identity',
    );
    expect(
      reason({ prerequisites: [{ beadId: 'sentinel-prod-2', column: column('X', 'triage') }] }),
    ).toBe('dependency-status-unknown');
    expect(reason({ prerequisites: [{ beadId: 'sentinel-prod-2', column: null }] })).toBe(
      'dependency-status-unknown',
    );
  });
});
