// The readiness facts a gated claim hands the rule owner, mapped from stored rows. Nothing above
// reads the database, decides whether a card is ready or accepts a value a client sent; the
// per-page builder at the bottom of this file is the one exception: it reads the user-stable
// facts on the caller's own transaction, once per page (sentinel-prod-8429.8).
//
// WHY every mapping is an exact table (Root 2026-11-15, 8429_READY_NATIVE_FACT_RULINGS_R1): the
// owner refuses a card on these facts, so a guessed status, kind or role would open or close work
// by accident. A value no table names is reported as unproven and the card is left out; it is
// never turned into the nearest known value.
import { loadTrackerRulesConfig, type TrackerGateConfigState } from '@repo/db/tracker-gate';
import { verifyPinnedManifest, type TrackerRulesAnswer } from '@repo/db/tracker-rules';
import { type TrackerActorKind } from '@repo/db/tracker-routing-facts';
import type { DbExecutor } from '@repo/db';
import { actorKindOf, skillFactsFor, type TrackerSkillFacts } from '#modules/issues/skill-facts';

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

// The gate facts one ready page makes once and hands every card it judges (sentinel-prod-8429.8).
//
// WHY once per page and not once per card: the ready page judges 25 cards in one transaction and
// used to read the actor kind twice per card (routing, then skills) and load the rule config and
// re-hash the pinned files twice per card as well. These are user-stable within the page: one
// read, one load, one proof. The proof is a value, never stored: a pinned byte that changes
// between requests still refuses on the next one, which makes its own proof.
//
// WHY null when the config is not configured: with unset or refusal config the page carries no
// facts and every per-card path runs exactly as it does today, where the gate loads the config
// itself and refuses in its own code. A configured page never re-asks: its cards judge on these
// facts and only these facts.
export interface PageGateFacts {
  config: Extract<TrackerGateConfigState, { state: 'configured' }>;
  proof: TrackerRulesAnswer | null;
  actorKind: TrackerActorKind;
  skillFacts: TrackerSkillFacts;
}

export async function pageGateFacts(tx: DbExecutor, userId: string): Promise<PageGateFacts | null> {
  const config = await loadTrackerRulesConfig();
  if (config.state !== 'configured') return null;
  const proof = await verifyPinnedManifest(
    config.config.python,
    config.config.pythonSha256,
    config.config.fileSha256,
  );
  const actorKind = await actorKindOf(tx, userId);
  const skillFacts = await skillFactsFor(tx, userId, { actorKind, config });
  return { config, proof, actorKind, skillFacts };
}
