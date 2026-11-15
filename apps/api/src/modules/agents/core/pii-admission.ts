import { type DbExecutor } from '@repo/db';
import { loadTrackerRulesConfig, type TrackerGateConfigState } from '@repo/db/tracker-gate';
import {
  checkTrackerRules,
  type TrackerRulesAnswer,
  type TrackerRulesConfig,
} from '@repo/db/tracker-rules';
import { routingFactsForUsers } from '#modules/issues/lane-routing';
import { HttpError } from '#shared/lib';

// Outbound PII admission for one runner delivery (8429 row 29, A).
//
// A queued run's framed prompt and a chat message's bytes leave the server the moment
// they are handed to an external agent. This helper is asked before that moment. It
// assembles the routing-decision op from the server's own rows and asks the pinned rule
// owner; it never decides policy itself. The owner returns the privacy/domain decision
// and this file passes the answer through.
//
// WHY the sanctioned transport and not a local verdict (Root R2): the owner is the
// single privacy authority. `pii_class` is a stated class as a string, and `null` means
// UNKNOWN, which the owner refuses for a cloud target. A local comparison of class or
// locality would be a second routing policy, and it inverts exactly that distinction.
//
// WHY ordinary and unlinked deliveries are still asked: outbound delivery is not a
// gated issue write, so the write's `rigId === null` bypass does not exist here. A
// missing config is a named refusal, never a silent allow.
//
// WHY nothing the runner or a client sent reaches the op: the lane is the authenticated
// agent's own ai_agent row read on the caller's transaction, the facts are server rows,
// and the manifest is pinned server config. A client-supplied local flag has no input
// path into this function at all.

export interface PiiAdmissionWork {
  // Linked work: the issue's actual bead/native identifier. Unlinked work: the stable
  // server-owned dispatch context id (`run-<agent_run.id>` or
  // `chat-<agent_chat_message.id>`), never a minted bead or ledger identity.
  contextId: string;
  // Linked: the project's rig prefix from the server row. Unlinked: no fabricated
  // prefix; '' only because the transport op shape carries the field.
  rigPrefix: string;
  // Retained title and description read from the server row. '' for unlinked work.
  title: string;
  description: string;
  // The issue's labels read from the server row. [] for unlinked work: no class is
  // stated, the privacy is unknown, and it is never assumed clear.
  labels: readonly string[];
  // The issue's column state from the server row. '' for unlinked work.
  columnState: string;
  // The authenticated agent's bot user. routingFactsForUsers reads that agent's own
  // ai_agent row on this transaction; a user with no ai_agent row is a person.
  agentUserId: string;
}

export type PiiAdmissionAnswer =
  | { ok: true }
  // Every non-allow carries the config's, owner's, or transport's own named code and
  // words, passed through.
  | { ok: false; code: string; message: string };

// The sanctioned owner invocation. Production always uses the pinned transport; only a
// unit test swaps in a synthetic owner answer (the house seam pattern, cf.
// run-admission's setRunAdmission).
type Owner = (
  config: TrackerRulesConfig,
  op: Record<string, unknown>,
) => Promise<TrackerRulesAnswer>;

let owner: Owner = checkTrackerRules;

export function setPiiAdmissionOwner(next: Owner): void {
  owner = next;
}

export async function admitRunnerDelivery(
  tx: DbExecutor,
  work: PiiAdmissionWork,
): Promise<PiiAdmissionAnswer> {
  const labels = [...work.labels];

  // The one routing policy: the lane's execution and any grant come from the pinned
  // manifest, and a lane the manifest does not list refuses here, before the owner
  // runs, because a guessed locality could send a PII card to a cloud lane.
  let routed: Awaited<ReturnType<typeof routingFactsForUsers>>;
  try {
    routed = await routingFactsForUsers(tx, {
      beadId: work.contextId,
      userIds: [work.agentUserId],
      labels,
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'lane-unrouted')
      return { ok: false, code: 'lane-unrouted', message: error.message };
    throw error;
  }

  if (routed.facts === null) {
    // No usable rule config: the config state's own named refusal, for every project
    // kind. Ordinary and unlinked deliveries never bypass outbound admission.
    const state = await loadTrackerRulesConfig();
    if (state.state === 'refusal') return { ok: false, code: state.code, message: state.message };
    return {
      ok: false,
      code: 'tracker-rules-unconfigured',
      message:
        'outbound delivery needs TRACKER_RULES_PYTHON, TRACKER_RULES_OWNER and ' +
        'TRACKER_RULES_MANIFEST set',
    };
  }

  // The delivery's identity must resolve to the agent's own ai_agent row and to exactly
  // one intended target. A missing row is not a person, not "no target", and not an
  // allow.
  const lane = routed.laneOf(work.agentUserId);
  const [target] = routed.facts.targets;
  if (lane === null || routed.facts.targets.length !== 1 || target?.lane !== lane) {
    return {
      ok: false,
      code: 'pii-admission-no-lane',
      message:
        'the delivery resolves to no single ai_agent lane: a missing lane row is not a ' +
        'no-target allow',
    };
  }

  const state: TrackerGateConfigState = await loadTrackerRulesConfig();
  if (state.state !== 'configured') {
    // The facts only build from a configured state; a refusal here is still a refusal:
    // the config's own named code, never an allow.
    if (state.state === 'refusal') return { ok: false, code: state.code, message: state.message };
    return {
      ok: false,
      code: 'tracker-rules-unconfigured',
      message: 'the rule config is not set',
    };
  }

  // The routing-decision op: the routingCheckOp state shape, with previous_state and no
  // proposed_state, so the owner's identity rule judges exactly what the write writers
  // hand it. The transport never rewrites the caller's op.
  const op: Record<string, unknown> = {
    op: 'state',
    id: work.contextId,
    rig_prefix: work.rigPrefix,
    labels,
    previous_state: {
      title: work.title,
      description: work.description,
      labels,
      bead_id: work.contextId,
      column_state: work.columnState,
    },
    routing_facts: routed.facts,
  };

  let answer: TrackerRulesAnswer;
  try {
    answer = await owner(state.config, op);
  } catch {
    // A transport that throws has not allowed anything.
    return {
      ok: false,
      code: 'tracker-rules-transport-error',
      message: 'the rule transport failed unexpectedly',
    };
  }
  if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };
  if (answer.violations.length > 0) {
    const first = answer.violations[0];
    const safe = first.safe_form ? ` Compliant form: ${first.safe_form}.` : '';
    return {
      ok: false,
      code: 'tracker-rules-violation',
      message: `${first.rule}: ${first.message}.${safe}`,
    };
  }
  return { ok: true };
}
