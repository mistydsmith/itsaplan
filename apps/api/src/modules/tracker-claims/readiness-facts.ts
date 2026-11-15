// The readiness facts a gated claim hands the rule owner, mapped from stored rows. Nothing here
// reads the database, decides whether a card is ready or accepts a value a client sent.
//
// WHY every mapping is an exact table (Root 2026-11-15, 8429_READY_NATIVE_FACT_RULINGS_R1): the
// owner refuses a card on these facts, so a guessed status, kind or role would open or close work
// by accident. A value no table names is reported as unproven and the card is left out; it is
// never turned into the nearest known value.

export type ReadinessKind = 'task' | 'epic' | 'slot';
export type ReadinessRole = 'worker' | 'coordinator' | 'operator';

export interface ReadinessFacts {
  id: string;
  status: string;
  kind: ReadinessKind;
  dependencies: { id: string; status: string }[];
  eligibility: boolean;
  operator_owned: boolean;
  actor_role: ReadinessRole;
}

export type ReadinessUnproven =
  'status-unknown' | 'kind-unknown' | 'dependency-without-identity' | 'dependency-status-unknown';

export type ReadinessFactsResult =
  { ok: true; facts: ReadinessFacts } | { ok: false; reason: ReadinessUnproven };

// The column names the import preserved, matched exactly. Blocked and deferred are passed as
// they are: the owner has no such status and refuses the card in its own words.
const COLUMN_STATUS: Record<string, string> = {
  Review: 'review',
  'Needs Human': 'needs-human',
  'Needs-Human': 'needs-human',
  'needs-human': 'needs-human',
  'Human Review': 'human-review',
  'Human-Review': 'human-review',
  'human-review': 'human-review',
  Blocked: 'blocked',
  blocked: 'blocked',
  Deferred: 'deferred',
  deferred: 'deferred',
};

const STATE_STATUS: Record<string, string> = {
  backlog: 'open',
  unstarted: 'open',
  started: 'in_progress',
};

const TYPE_KIND: Record<string, ReadinessKind> = {
  task: 'task',
  bug: 'task',
  feature: 'task',
  chore: 'task',
  decision: 'task',
  spike: 'task',
  event: 'task',
  'merge-request': 'task',
  molecule: 'task',
  epic: 'epic',
  slot: 'slot',
};

// WHY the terminal state type is read first: a card in a completed or canceled column is closed
// whatever the column is called, so a done column named Review cannot reopen a prerequisite.
export function readinessStatus(column: { name: string; stateType: string }): string | null {
  if (column.stateType === 'completed') return 'closed';
  if (column.stateType === 'canceled') return 'canceled';
  if (Object.hasOwn(COLUMN_STATUS, column.name)) return COLUMN_STATUS[column.name];
  return Object.hasOwn(STATE_STATUS, column.stateType) ? STATE_STATUS[column.stateType] : null;
}

export function readinessKind(typeName: string | null): ReadinessKind | null {
  if (typeName === null) return null;
  const name = typeName.trim().toLowerCase();
  return Object.hasOwn(TYPE_KIND, name) ? TYPE_KIND[name] : null;
}

// WHY the label is compared trimmed and lowercased: a different spelling of the marker must not
// make operator work claimable. The assignee and the bead owner are advice and are not read.
export function operatorOwned(labels: string[]): boolean {
  return labels.some((label) => label.trim().toLowerCase() === 'operator-owned');
}

// The project authorization of the authenticated user. memberRole is the project_member row's
// role, or null for a user who reaches the project without a row.
export function actorRole(userRole: string | null, memberRole: string | null): ReadinessRole {
  if (userRole === 'god') return 'operator';
  return memberRole === 'owner' ? 'coordinator' : 'worker';
}

export interface ReadinessInput {
  beadId: string;
  column: { name: string; stateType: string };
  typeName: string | null;
  labels: string[];
  // One entry per stored 'blocks' link that targets the card. beadId is null when the
  // prerequisite carries no bead identity, column when it has no column row.
  prerequisites: {
    beadId: string | null;
    column: { name: string; stateType: string } | null;
  }[];
  userRole: string | null;
  memberRole: string | null;
  // True only when the rule owner allowed the routing check for the requesting user.
  routingAllowed: boolean;
}

export function buildReadinessFacts(input: ReadinessInput): ReadinessFactsResult {
  const status = readinessStatus(input.column);
  if (status === null) return { ok: false, reason: 'status-unknown' };
  const kind = readinessKind(input.typeName);
  if (kind === null) return { ok: false, reason: 'kind-unknown' };
  const dependencies: ReadinessFacts['dependencies'] = [];
  for (const prerequisite of input.prerequisites) {
    if (prerequisite.beadId === null) return { ok: false, reason: 'dependency-without-identity' };
    const dependencyStatus =
      prerequisite.column === null ? null : readinessStatus(prerequisite.column);
    if (dependencyStatus === null) return { ok: false, reason: 'dependency-status-unknown' };
    dependencies.push({ id: prerequisite.beadId, status: dependencyStatus });
  }
  return {
    ok: true,
    facts: {
      id: input.beadId,
      status,
      kind,
      dependencies,
      eligibility: input.routingAllowed,
      operator_owned: operatorOwned(input.labels),
      actor_role: actorRole(input.userRole, input.memberRole),
    },
  };
}
