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
const GUARD =
  '  if (!answer.ok)\n' + '    return { ok: false, code: answer.code, message: answer.message };';
const MUTATED_GUARD = '  if (!answer.ok)\n    return { ok: true };';

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
