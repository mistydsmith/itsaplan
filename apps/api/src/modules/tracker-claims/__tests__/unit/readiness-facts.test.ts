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
  workflowConfigEdit: false,
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
    // 8365.65: the pinned (user, member) -> worker line is updated DELIBERATELY (Muse review
    // condition 1): the third argument is the caller's effective workflow_config.edit, and
    // every pre-existing case now says it with an explicit false. The mapping itself moved
    // nowhere: god stays operator, owner stays coordinator, everyone else worker.
    expect(actorRole('god', null, false)).toBe('operator');
    expect(actorRole('god', 'member', false)).toBe('operator');
    expect(actorRole('user', 'owner', false)).toBe('coordinator');
    expect(actorRole('user', 'member', false)).toBe('worker');
    expect(actorRole(null, null, false)).toBe('worker');
    expect(actorRole('GOD', 'Owner', false)).toBe('worker');
  });

  test('an effective workflow_config.edit maps the same user to coordinator (orchestrator-epic witness)', () => {
    // 8365.65 (Misty 2026-11-16: "you have full permissions as orchestrators"): the same
    // authenticated user reads coordinator with the grant and worker without it. This is the
    // green arm the red mutant (mapping removed) must fail.
    expect(actorRole('user', 'member', true)).toBe('coordinator');
    // a grant that is false and a grant that is missing both resolve to the same boolean
    // (hasPermission on a missing resource/action is false) and both stay worker
    expect(actorRole('user', 'member', false)).toBe('worker');
    expect(actorRole('god', 'member', true)).toBe('operator'); // god stays operator
    expect(actorRole('user', 'owner', true)).toBe('coordinator'); // owner stays coordinator
    expect(actorRole('user', 'owner', false)).toBe('coordinator');
  });

  test('a workspace-only grant arrives as the same true boolean (workspace-raise witness)', () => {
    // 8365.65 workspace-raise path: the grant arrives only through the workspace grant - the
    // member row carries no project grant of its own. The resolver's raise is the access
    // model's own semantics (Root ruling: a workspace-only effective grant MUST count), so it
    // reaches readiness as the one boolean and maps to coordinator.
    expect(actorRole('user', 'member', true)).toBe('coordinator');
  });

  test('buildReadinessFacts carries the grant through to the actor role fact', () => {
    // End-to-end fact plumbing: the boolean flows ReadinessInput -> facts.actor_role, so the
    // owner sees the coordinator role on the claim op, not just on the pure mapping.
    expect(
      (
        buildReadinessFacts(input({ workflowConfigEdit: true })) as {
          facts: { actor_role: string };
        }
      ).facts.actor_role,
    ).toBe('coordinator');
    expect(
      (
        buildReadinessFacts(input({ workflowConfigEdit: false })) as {
          facts: { actor_role: string };
        }
      ).facts.actor_role,
    ).toBe('worker');
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
