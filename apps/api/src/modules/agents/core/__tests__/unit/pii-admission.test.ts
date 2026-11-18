import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DbExecutor } from '@repo/db';
import {
  checkTrackerRules,
  type TrackerRulesAnswer,
  type TrackerRulesConfig,
} from '@repo/db/tracker-rules';
import * as admission from '../../pii-admission';
import { routingFactsForUsers } from '../../../../issues/lane-routing';
import { commentDeleteOp, routedCommentOp } from '../../../../issues/comment-history';

// 8429 row 29, A: one focused mutation pair against the ACTUAL production helper.
//
// What runs for real: the helper (imported, not re-implemented), routingFactsForUsers,
// buildRoutingFacts, and loadTrackerRulesConfig reading a synthetic manifest through
// the real TRACKER_RULES_* env. The synthetic seam is the owner answer only: the
// pinned owner is a python spawn, so setPiiAdmissionOwner (the helper's house seam,
// cf. setRunAdmission) returns a fixed refusal.
//
// The mutation pair: the control asserts the real helper passes the owner's named
// refusal through. The mutant copy of the helper mutates the refusal guard itself
// into an early {ok:true} (the forbidden outcome), and the same delivery through the
// mutated helper must observe the allow. That is the mutation this test kills;
// nothing more, and production carries no scaffolding for it.

const AGENT_ROW = [{ userId: 'bot-user-1', username: 'Cloud-Lane' }];

// The synthetic executor satisfies routingFactsForUsers' one read of the ai_agent row;
// the function itself runs its real code.
const tx = {
  select: () => ({ from: () => ({ where: () => Promise.resolve(AGENT_ROW) }) }),
} as unknown as DbExecutor;

const HEX64 = 'a'.repeat(64);
const MANIFEST = {
  pythonSha256: HEX64,
  fileSha256: { '/usr/bin/python3': HEX64 },
  routing: {
    lanes: { 'cloud-lane': { execution: 'cloud' }, 'local-lane': { execution: 'local' } },
    grants: [],
  },
};

// The non-allow answer the synthetic owner returns: the transport's own refusal code
// for an owner that refuses (nonzero exit), with the owner's words.
const OWNER_REFUSAL: Extract<TrackerRulesAnswer, { ok: false }> = {
  ok: false,
  code: 'tracker-rules-nonzero-exit',
  message: 'unknown-privacy work may not be routed to a cloud lane',
};

const seenOps: Record<string, unknown>[] = [];
const syntheticOwner = async (
  _config: TrackerRulesConfig,
  op: Record<string, unknown>,
): Promise<TrackerRulesAnswer> => {
  seenOps.push(op);
  return OWNER_REFUSAL;
};

// The exact refusal guard the pair mutates: the mutant turns the guard's refusal
// return into an early {ok:true}, the same forbidden outcome, without altering any
// other production line. If this block moves in the helper, the pair is stale and
// must be re-anchored.
//
// Re-anchored (sentinel-prod-8429, qwen2 2026-11-15): the anchor had drifted to a two-line if-body while the helper on main has
// always carried this guard on one line - line 166 of pii-admission.ts - and one line is also the form prettier holds at
// printWidth 100. The helper's own WHY requires only that every non-allow carries the config's, the owner's or the transport's
// named code and words passed through; nothing in it requires a broken body. So the anchor follows the helper, and the mutation
// is the same forbidden outcome as before: the refusal guard becomes an early allow.
const GUARD = '  if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };';
const MUTATED_GUARD = '  if (!answer.ok) return { ok: true };';

describe('8429 row 29 A: admitRunnerDelivery — control and mutated guard', () => {
  let dir: string;
  const priorEnv: Record<string, string | undefined> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pii-admission-'));
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(MANIFEST));
    for (const key of ['TRACKER_RULES_PYTHON', 'TRACKER_RULES_OWNER', 'TRACKER_RULES_MANIFEST']) {
      priorEnv[key] = process.env[key];
      if (key === 'TRACKER_RULES_PYTHON') process.env[key] = '/usr/bin/python3';
      if (key === 'TRACKER_RULES_OWNER') process.env[key] = join(dir, 'owner.py');
      if (key === 'TRACKER_RULES_MANIFEST') process.env[key] = manifestPath;
    }
    admission.setPiiAdmissionOwner(syntheticOwner);
  });
  afterAll(async () => {
    for (const key of ['TRACKER_RULES_PYTHON', 'TRACKER_RULES_OWNER', 'TRACKER_RULES_MANIFEST']) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
    admission.setPiiAdmissionOwner(checkTrackerRules);
    await rm(dir, { recursive: true, force: true });
  });

  it('the real helper passes the owner refusal through; the mutated guard allows', async () => {
    // Linked work on a cloud lane, labels [] = unknown privacy, never assumed clear.
    const work = {
      contextId: 'MKT-42',
      rigPrefix: 'MKT',
      title: 'Card',
      description: 'Body',
      labels: [],
      columnState: 'todo',
      agentUserId: 'bot-user-1',
    };

    const control = await admission.admitRunnerDelivery(tx, work);
    console.log('[control] answer:', JSON.stringify(control));
    expect(control.ok).toBe(false);
    if (!control.ok) {
      expect(control.code).toBe(OWNER_REFUSAL.code);
      expect(control.message).toBe(OWNER_REFUSAL.message);
    }

    // The op the owner was given: the routingCheckOp state shape with the retained
    // server facts, the real routing facts, and no proposed_state.
    const op = seenOps.at(-1);
    expect(op?.op).toBe('state');
    expect(op?.id).toBe('MKT-42');
    expect(op?.rig_prefix).toBe('MKT');
    expect(op).not.toHaveProperty('proposed_state');
    expect(op?.previous_state).toEqual({
      title: 'Card',
      description: 'Body',
      labels: [],
      bead_id: 'MKT-42',
      column_state: 'todo',
    });
    expect(op?.routing_facts).toMatchObject({
      bead_id: 'MKT-42',
      pii_class: null,
      targets: [{ lane: 'cloud-lane', execution: 'cloud', role: 'author' }],
    });

    // Mutant: turn the refusal guard itself into an early {ok:true} in a throwaway
    // copy of the actual source and run the same delivery through the mutated helper.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, '..', '..', 'pii-admission.ts'), 'utf8');
    expect(source).toContain(GUARD);
    const mutated = source.replace(GUARD, MUTATED_GUARD);
    expect(mutated).not.toBe(source);
    expect(mutated).toContain(MUTATED_GUARD);
    const mutantName = `pii-admission.mutant-${process.pid}.ts`;
    const mutantPath = join(here, mutantName);
    await writeFile(mutantPath, mutated);
    try {
      const mutant = await import(`./${mutantName}`);
      mutant.setPiiAdmissionOwner(syntheticOwner);
      const allow = await mutant.admitRunnerDelivery(tx, work);
      console.log(
        '[mutant]  answer:',
        JSON.stringify(allow),
        '(refusal guard mutated to early allow -> forbidden dispatch observed)',
      );
      expect(allow.ok).toBe(true);
    } finally {
      await rm(mutantPath, { force: true });
    }
  });
});

// 8429 (Misty 2026-11-15): "i guarantee you EVERY block will block me too".
//
// The same routing seam this suite already runs for real, judged now on WHO is writing. Only the ai_agent read is synthetic:
// rows returned make that read say agent, no rows make a signed-in user a person. loadTrackerRulesConfig, buildRoutingFacts,
// laneToken and the refusal are the production ones. The router reads the lanes first and the actor kind second, so the fake
// answers in that order and the case below names the order it depends on.
const LANE_ROWS = [
  { userId: 'bot-user-1', username: 'Cloud-Lane' },
  { userId: 'bot-user-2', username: 'Unlisted-Lane' }, // MANIFEST routing.lanes has no entry for this one
];

function routerTx(actorRows: unknown[]): DbExecutor {
  const chain = (rows: unknown[]) => {
    const result = Promise.resolve(rows) as Promise<unknown> & { limit: () => Promise<unknown> };
    result.limit = () => Promise.resolve(rows.slice(0, 1));
    return result;
  };
  // WHY the read is answered by what was asked for and not by its order: the comment doors read the actor kind before they route,
  // the outbound delivery reads it inside the router, and a seam that answered by order would decide the actor kind by accident.
  // A select of the lane rows asks for a username; actorKindOf asks for an id.
  const read = (shape: unknown) =>
    chain(
      shape != null && typeof shape === 'object' && 'username' in shape ? LANE_ROWS : actorRows,
    );
  return {
    select: (shape: unknown) => ({ from: () => ({ where: () => read(shape) }) }),
  } as unknown as DbExecutor;
}

describe('8429: the routing seam judged on the actor behind the write', () => {
  const unrouted = {
    beadId: 'MKT-42',
    userIds: ['bot-user-1', 'bot-user-2'],
    labels: [] as string[],
  };
  let dir: string;
  const priorEnv: Record<string, string | undefined> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pii-admission-routing-'));
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(MANIFEST));
    for (const key of ['TRACKER_RULES_PYTHON', 'TRACKER_RULES_OWNER', 'TRACKER_RULES_MANIFEST']) {
      priorEnv[key] = process.env[key];
      if (key === 'TRACKER_RULES_PYTHON') process.env[key] = '/usr/bin/python3';
      if (key === 'TRACKER_RULES_OWNER') process.env[key] = join(dir, 'owner.py');
      if (key === 'TRACKER_RULES_MANIFEST') process.env[key] = manifestPath;
    }
  });
  afterAll(async () => {
    for (const key of ['TRACKER_RULES_PYTHON', 'TRACKER_RULES_OWNER', 'TRACKER_RULES_MANIFEST']) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('a person whose write names nobody and holds nobody routes nobody, and the facts say so', async () => {
    const { facts, laneOf } = await routingFactsForUsers(routerTx([]), {
      beadId: 'MKT-42',
      userIds: [],
      labels: [],
      actorUserId: 'person-1',
    });
    // 8429's guarantee stands for this write (Misty 2026-11-15, "i guarantee you EVERY block will block me too"): a signed-in
    // person is not refused by a lane she never routed. It is carried by facts the server built - empty targets, no lane, no
    // grant - because the published owner reads a routing_facts key that is present as null as a malformed mapping (sentinel-prod-8364).
    expect(facts).not.toBeNull();
    expect(facts?.targets).toEqual([]);
    expect(laneOf('person-1')).toBeNull();
  });

  it('a person is not exempted from the typed refusal when her write hands the card to an unroutable lane', async () => {
    const codes: (string | undefined)[] = [];
    for (const actorUserId of ['person-1', 'bot-user-1', null]) {
      try {
        await routingFactsForUsers(routerTx([]), { ...unrouted, actorUserId });
        codes.push(undefined);
      } catch (error) {
        codes.push((error as { code?: string }).code);
      }
    }
    // The lanes are read the same way for every actor, so the manifest that cannot route Unlisted-Lane refuses a person's write
    // with the same named refusal it gives an agent's: a named target is never hidden by who typed it.
    expect(codes).toEqual(['lane-unrouted', 'lane-unrouted', 'lane-unrouted']);
  });

  it('an agent writer and a write with no user keep the lane-unrouted refusal unchanged', async () => {
    const codes: (string | undefined)[] = [];
    for (const actorUserId of ['bot-user-1', null]) {
      try {
        await routingFactsForUsers(routerTx([{ id: 1 }]), { ...unrouted, actorUserId });
        codes.push(undefined);
      } catch (error) {
        codes.push((error as { code?: string }).code);
      }
    }
    expect(codes).toEqual(['lane-unrouted', 'lane-unrouted']);
  });

  // The comment doors carry the same database-derived actor kind the issue write carries (sentinel-prod-8429).
  const commentFacts = {
    beadId: 'MKT-42',
    rigPrefix: 'MKT',
    title: 'a card whose named lane the manifest cannot route',
    description: 'this text names no handle',
    labels: [] as string[],
  };
  const commentInput = (actorUserId: string | null) => ({
    opName: 'comment_create' as const,
    facts: commentFacts,
    versions: [],
    liveBefore: [],
    superseded: [],
    editBody: 'progress: the card moved',
    actorUserId,
  });

  it('a person commenting on a card that routes nobody carries facts that route nobody', async () => {
    const op = await routedCommentOp(routerTx([]), 7, [], commentInput('person-1'));
    expect(op.actor_kind).toBe('human');
    expect(op.routing_facts).toMatchObject({ targets: [] });
  });

  it('a person commenting is refused by a named lane the manifest cannot route, the same refusal an agent gets', async () => {
    let code: string | undefined;
    try {
      await routedCommentOp(routerTx([]), 7, ['bot-user-2'], commentInput('person-1'));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('lane-unrouted');
  });

  it('an agent comment and a comment with no user keep the lane-unrouted refusal unchanged', async () => {
    const codes: (string | undefined)[] = [];
    for (const actorUserId of ['bot-user-1', null]) {
      try {
        await routedCommentOp(routerTx([{ id: 1 }]), 7, ['bot-user-2'], commentInput(actorUserId));
        codes.push(undefined);
      } catch (error) {
        codes.push((error as { code?: string }).code);
      }
    }
    expect(codes).toEqual(['lane-unrouted', 'lane-unrouted']);
  });

  it('a delete carries the actor kind of the user who deleted it and still routes nobody', async () => {
    const kinds: unknown[] = [];
    for (const actorUserId of ['person-1', 'bot-user-1', null]) {
      const op = await commentDeleteOp(routerTx(actorUserId === 'bot-user-1' ? [{ id: 1 }] : []), {
        ...commentInput(actorUserId),
        opName: 'comment_delete',
        omitIds: [41],
      });
      kinds.push(op.actor_kind);
      // A delete has never carried routing facts, and it still carries none, whatever the actor is.
      expect(op.routing_facts).toBeUndefined();
    }
    expect(kinds).toEqual(['human', 'agent', 'system']);
  });
});
