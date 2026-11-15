// The routing facts a gated write hands the rule owner. The lane identity is the caller's own
// database read (ai_agent.username of the bot user a card is assigned or delegated to); where a
// lane runs, and any per-card role or exception, is the routing section of the pinned manifest.
// Nothing here reads the database, decides policy or accepts a value a client sent.
//
// WHY the manifest and not a guess (sentinel-prod-8364 G1): the owner never infers locality from a
// lane name, and the tracker stores no execution fact. The manifest is already the privileged,
// reviewed server config, so the lane's execution is written there once by the operator. A lane
// with no entry refuses here; it is never defaulted to local.

export type TrackerRoutingExecution = 'local' | 'cloud';
export type TrackerRoutingRole = 'author' | 'reviewer' | 'mechanical';

export interface TrackerRoutingGrant {
  bead_id: string;
  lane: string;
  role: TrackerRoutingRole;
  scope: string;
  reason: string;
  required_reviews?: string[];
}

export interface TrackerRoutingPolicy {
  lanes: Record<string, { execution: TrackerRoutingExecution; client_data_cleared?: boolean }>;
  grants: TrackerRoutingGrant[];
}

export interface TrackerRoutingTarget {
  lane: string;
  execution: TrackerRoutingExecution;
  role: TrackerRoutingRole;
  // The per-lane client-data clearance (Misty 2026-11-15), a sibling of execution, never a relabel
  // of it: where a model runs stays the true execution fact, and other rules read that. Strict
  // boolean, set by buildRoutingFacts from the manifest; an absent or non-true value lands false.
  client_data_cleared: boolean;
}

export interface TrackerRoutingFacts {
  bead_id: string;
  targets: TrackerRoutingTarget[];
  pii_class: string | null;
  grants: (Omit<TrackerRoutingGrant, 'required_reviews'> & { authorized: true })[];
  required_reviews?: string[];
}

export type TrackerRoutingFactsResult =
  { ok: true; facts: TrackerRoutingFacts } | { ok: false; message: string };

const EXECUTIONS = ['local', 'cloud'];
const ROLES = ['author', 'reviewer', 'mechanical'];

// The owner compares lane names trimmed and case-folded; the manifest keys and the database
// usernames are normalized the same way, so one spelling difference cannot split an identity.
export function laneToken(value: string): string {
  return value.trim().toLowerCase();
}

// Who a gated write is being judged on: the authenticated writer, read from the database by the
// caller (an ai_agent row is an agent, a user without one is a person, no user is a system write).
export type TrackerActorKind = 'agent' | 'human' | 'system';

// Whether the routing policy is applied to a write at all.
//
// WHY 8429 (Misty 2026-11-15): "i guarantee you EVERY block will block me too". A person is not a lane, so a routing policy
// problem in some agent's lane is not a reason to refuse the card a person is trying to close, delegate or edit for herself.
// A person's write is judged by the rule owner with no routing facts, which is the same judgment an ungated card gets, and
// every agent and system write keeps the routing policy exactly as it is.
export function routingAppliesToActor(actorKind: TrackerActorKind | undefined): boolean {
  return actorKind !== 'human';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// Shape only. Whether a scope may open a card is the owner's decision, so an unknown scope is
// passed through and refused there in the owner's own words.
export function routingPolicyProblem(routing: unknown): string | null {
  if (!isRecord(routing)) return 'the manifest routing section must be a mapping';
  const { lanes, grants } = routing;
  if (!isRecord(lanes)) return 'the manifest routing section needs a lanes mapping';
  for (const [lane, entry] of Object.entries(lanes)) {
    if (lane === '' || lane !== laneToken(lane))
      return `the manifest routing lane ${JSON.stringify(lane)} must be a trimmed lowercase token`;
    if (!isRecord(entry) || !EXECUTIONS.includes(entry.execution as string))
      return `the manifest routing lane ${lane} needs execution local or cloud`;
    // Fail loudly at load: a present but non-boolean clearance is a config typo, and it must not
    // silently leave a lane uncleared (Misty 2026-11-15). Absent is fine (not cleared).
    if (entry.client_data_cleared !== undefined && typeof entry.client_data_cleared !== 'boolean')
      return (
        `the manifest routing lane ${lane} client_data_cleared must be a boolean when present, ` +
        `not ${JSON.stringify(entry.client_data_cleared)}`
      );
  }
  if (grants === undefined) return null;
  if (!Array.isArray(grants)) return 'the manifest routing grants must be a list';
  for (const grant of grants) {
    if (!isRecord(grant)) return 'a manifest routing grant must be a mapping';
    const { bead_id, lane, role, scope, reason, required_reviews } = grant;
    if (!isText(bead_id) || !isText(scope) || !isText(reason))
      return 'a manifest routing grant needs a bead_id, a scope and a reason';
    if (!isText(lane) || lane !== laneToken(lane) || !Object.hasOwn(lanes, lane))
      return `a manifest routing grant names a lane with no lanes entry: ${String(lane)}`;
    if (!ROLES.includes(role as string))
      return `the manifest routing grant for ${lane} needs role author, reviewer or mechanical`;
    if (
      required_reviews !== undefined &&
      (!Array.isArray(required_reviews) || !required_reviews.every(isText))
    )
      return `the manifest routing grant for ${lane} required_reviews must be a list of lane names`;
  }
  return null;
}

export function parseRoutingPolicy(routing: unknown): TrackerRoutingPolicy {
  const section = routing as {
    lanes: TrackerRoutingPolicy['lanes'];
    grants?: TrackerRoutingGrant[];
  };
  return { lanes: section.lanes, grants: section.grants ?? [] };
}

// The card's class is the one class its labels state. A `pii:<class>` label states <class>.
// The bare labels `pii_free` and `pii` state themselves.
//
// WHY the bare `pii_free` label counts (Root 2026-11-14): the cards imported from Beads carry
// that label, and the legacy cloud rule (Sentinel tools/lane_idle_watcher.py) reads exactly it.
// Reading only `pii:pii_free` would turn every imported shared-pool card into an unknown class
// and refuse it for every cloud lane. `pii_free` and `pii:pii_free` are the same class. No
// label, or labels that state different classes, is no class: the owner then treats the card
// as unknown and refuses a cloud target. An unlabelled card is never treated as clear.
const BARE_PII_LABELS = ['pii_free', 'pii'];

function piiClass(labels: string[]): string | null {
  const classes = new Set<string>();
  for (const label of labels) {
    const name = label.trim().toLowerCase();
    if (name.startsWith('pii:')) classes.add(name.slice(4).trim());
    else if (BARE_PII_LABELS.includes(name)) classes.add(name);
  }
  return classes.size === 1 ? [...classes][0] : null;
}

// `lanes` are the agent usernames the write leaves holding the card, read by the caller on its
// locked transaction. A person holding the card is not a lane and is not passed.
export function buildRoutingFacts(
  policy: TrackerRoutingPolicy | undefined,
  input: { beadId: string; lanes: string[]; labels: string[] },
): TrackerRoutingFactsResult {
  const facts: TrackerRoutingFacts = {
    bead_id: input.beadId,
    targets: [],
    pii_class: piiClass(input.labels),
    grants: [],
  };
  for (const lane of [...new Set(input.lanes.map(laneToken))]) {
    const entry = policy && Object.hasOwn(policy.lanes, lane) ? policy.lanes[lane] : undefined;
    if (entry === undefined) {
      return {
        ok: false,
        message:
          `lane ${lane} has no execution entry in the rule manifest routing section, ` +
          'so this write cannot be routed to it',
      };
    }
    // The default role is author. Another role exists only as a manifest grant for this exact
    // card and lane, which is then handed to the owner to bound.
    const grant = policy?.grants.find((g) => g.bead_id === input.beadId && g.lane === lane);
    facts.targets.push({
      lane,
      execution: entry.execution,
      role: grant?.role ?? 'author',
      // The cleared fact as a strict boolean: only an exact manifest true clears the lane for
      // client data. Absent or false lands false; a malformed value was already refused at load.
      client_data_cleared: entry.client_data_cleared === true,
    });
    if (grant) {
      const { required_reviews, ...rest } = grant;
      facts.grants.push({ ...rest, authorized: true });
      if (required_reviews !== undefined) facts.required_reviews = required_reviews;
    }
  }
  return { ok: true, facts };
}
