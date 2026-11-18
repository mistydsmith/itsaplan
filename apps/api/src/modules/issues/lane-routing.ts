import { inArray } from 'drizzle-orm';
import { aiAgent, type DbExecutor } from '@repo/db';
import { loadTrackerRulesConfig, type TrackerGateConfigState } from '@repo/db/tracker-gate';
import {
  buildRoutingFacts,
  laneToken,
  type TrackerActorKind,
  type TrackerRoutingFacts,
} from '@repo/db/tracker-routing-facts';
import { HttpError } from '#shared/lib';
import { parseMentionHandles, resolveMentionHandles } from '#shared/mentions';

// The routing facts for the agents a gated write reaches: the ones it leaves holding the card,
// or the ones a comment or a description names.
//
// WHY nothing here comes from the request (sentinel-prod-8364 G1): a lane is the username of the
// ai_agent row behind a stored user id, read on the caller's locked transaction, and its
// execution and any role grant come from the pinned rule manifest. A user with no ai_agent row
// is a person: no lane, no target. A lane the manifest does not list refuses here, before the
// owner runs, because a guessed locality could send a PII card to a cloud lane. With no usable
// rule config the facts stay null and the gate refuses with its own config code. Every gated
// writer calls this one function, so there is one routing policy and not one per door.
// 8429.8: a page of cards hands the facts it already read for this request so the rule config is
// not re-loaded and the actor kind not re-read per card. Omitting `known` behaves exactly as
// before. buildRoutingFacts and resolveMentionHandles stay per card: they are the card's own
// routing decision, not a user-stable fact.
export async function routingFactsForUsers(
  tx: DbExecutor,
  input: { beadId: string; userIds: string[]; labels: string[]; actorUserId?: string | null },
  known?: { actorKind: TrackerActorKind; config: TrackerGateConfigState },
): Promise<{
  facts: TrackerRoutingFacts | null;
  laneOf: (userId: string | null) => string | null;
}> {
  const userIds = [...new Set(input.userIds)];
  const agents =
    userIds.length === 0
      ? []
      : await tx
          .select({ userId: aiAgent.userId, username: aiAgent.username })
          .from(aiAgent)
          .where(inArray(aiAgent.userId, userIds));
  const laneOf = (userId: string | null): string | null => {
    const agent = agents.find((row) => row.userId === userId);
    return agent ? laneToken(agent.username) : null;
  };
  const config = known?.config ?? (await loadTrackerRulesConfig());
  if (config.state !== 'configured') return { facts: null, laneOf };
  // WHY a person's write carries facts too (sentinel-prod-8364, Root ruling 2026-11-18, msg_3f36ed266b29): 8429 exempted a
  // signed-in person by sending no facts at all, and the published owner reads the routing_facts key by its presence - a key
  // present as null is a malformed mapping to it, not an exemption (tools/tracker_rules.py lane_rule, tools/tracker_rule_routing.py
  // validate_routing). So the two operations 8429 conflated are separated here instead. A person writing her own card with no
  // fleet-routing intent is a write that routes nobody: no stored agent row is left holding the card and no handle is named, the
  // lanes list is empty, and the facts say so - targets [] - which the owner accepts while every other gate still answers. A
  // write that assigns, delegates or names a real fleet lane is the other operation, and it is judged exactly as an agent's
  // write is: the typed lane-unrouted refusal when this manifest cannot route that lane, and the owner's own verdict when it can
  // and the lane is prohibited on that work. Nothing here is taken from the request: the lanes are only the ai_agent rows behind
  // stored user ids read on this transaction, so a caller cannot call itself a person or name a target the server has not read.
  const built = buildRoutingFacts(config.routing, {
    beadId: input.beadId,
    lanes: agents.map((agent) => laneToken(agent.username)),
    labels: input.labels,
  });
  if (!built.ok) throw new HttpError(409, `lane-routing: ${built.message}.`, 'lane-unrouted');
  return { facts: built.facts, laneOf };
}

// The routing facts for a write whose judged text can name agents: a comment, or a description.
//
// WHY the whole judged text and not only the new body (sentinel-prod-8364, Root msg_9c74bb90114a):
// the rule owner reads a lane mention anywhere in the text it is given and refuses a mention with
// no matching target. So every handle in that text is resolved here to the ai_agent row of a
// project member, and those rows become targets next to the agents the write reaches. A handle
// that resolves to no agent adds no target, and the owner refuses it when it names a fleet lane.
// A name in the text is never turned into a lane without a stored identity behind it.
export async function routingFactsForText(
  tx: DbExecutor,
  input: {
    projectId: number;
    beadId: string;
    labels: string[];
    texts: string[];
    userIds: string[];
    actorUserId?: string | null;
  },
  known?: { actorKind: TrackerActorKind; config: TrackerGateConfigState },
): ReturnType<typeof routingFactsForUsers> {
  const handles = new Set(input.texts.flatMap(parseMentionHandles));
  const named = await resolveMentionHandles(input.projectId, [...handles], tx);
  return routingFactsForUsers(
    tx,
    {
      beadId: input.beadId,
      userIds: [...input.userIds, ...named.agentUserIds],
      labels: input.labels,
      actorUserId: input.actorUserId ?? null,
    },
    known,
  );
}

// The routing facts for whoever a gated write leaves holding the card, plus the agents its title and
// description name.
//
// WHY this wrapper lives here and not in the write service (sentinel-prod-8429): who is being named is
// decided only by the states the write leaves in place — the assignee and delegate it sets, and the
// handles in its text — which is the same decision every gated writer makes here. The person doing the
// write is carried as the actor, never as a target of her own write: the lanes she is assigning or
// delegating to are the targets.
export async function routingFactsFor(
  tx: DbExecutor,
  input: {
    beadId: string;
    projectId: number;
    texts: string[];
    assigneeUserId: string | null;
    delegateUserId: string | null;
    labels: string[];
    actorUserId: string | null;
  },
): Promise<{
  facts: TrackerRoutingFacts | null;
  assigneeLane: string | null;
  delegateLane: string | null;
}> {
  const { facts, laneOf } = await routingFactsForText(tx, {
    beadId: input.beadId,
    projectId: input.projectId,
    texts: input.texts,
    userIds: [input.assigneeUserId, input.delegateUserId].filter(
      (userId): userId is string => userId !== null,
    ),
    labels: input.labels,
    actorUserId: input.actorUserId,
  });
  return {
    facts,
    assigneeLane: laneOf(input.assigneeUserId),
    delegateLane: laneOf(input.delegateUserId),
  };
}
