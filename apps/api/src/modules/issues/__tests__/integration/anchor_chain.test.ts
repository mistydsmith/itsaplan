// 8428 slice S2b proofs: the adapter that asks the shared rule for a plan and does what it says
// (apps/api/src/modules/issues/anchor-chain.ts), plus the stamp tail that runs it.
//
// Claimed, from the shipped source: the stamp tail runs the chain with the ranges its own stamp
// computed, after its own report and before its return; the adapter names the canonical shared tool and
// its published plan mode, and writes only through ItsPlan's existing relation writer with a null actor
// id - it holds no ordering, pair choice, cycle test, second read or second writer of its own.
// Claimed: `appliable` and this read's own completeness are the only writing authorities, and the
// sanctioned auto hook carries the internal system actor `AnchorMap` by itself - no environment
// variable, no configuration step - while any direct call stays plan-only unless a name is configured,
// and no caller can pass an actor because there is no actor option. Claimed: every plan outcome writes
// exactly what the plan authorised, records one truthful entry, and a chain that cannot run never fails
// a good stamp. The shared rule itself is proved in slice S2a; here the fake serves the rows and the
// writer is captured, never executed.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { resetLog } from './fake_log';
import { anchorRanges, stampIssueAnchors } from '../../anchor-stamp';
import {
  CANONICAL_ANCHOR_CHAIN_TOOL,
  INTERNAL_CHAIN_ACTOR,
  anchorChainTool,
  chainActor,
  chainSameFileAnchors,
  chainStampedAnchors,
  stampChainActor,
  type ChainPlan,
} from '../../anchor-chain';
import type { FactsFn } from '../../anchor-chain-facts';
// One namespace import: these proofs use twenty-odd shared fixtures, and naming them one by one would
// push this file past the 400-line cap without dropping a single case.
import * as proof from './anchor_chain.fixtures';

beforeAll(proof.installEnv);
afterAll(proof.restoreEnv);

type Entry = 'auto' | 'direct';
type Fail = (w: proof.Write) => unknown;
const CANONICAL_CHAIN_TOOL = '/Users/misty/sentinel/sentinel-prod/tools/anchor_map_chain.py';
const anchors = (starts: number[]) => [{ file: proof.PROOF_FILE, starts }];
const adjacency = (edges = [proof.edge('102', '101')], appliable = true): ChainPlan =>
  proof.plan([proof.planFile(proof.PROOF_FILE, ['102', '101'], edges)], appliable);

/** Run the adapter against a fixture plan, with the writes captured: `auto` is the sanctioned
 * post-stamp entry point, `direct` is any other caller. */
async function run(
  issueId: number,
  starts: number[],
  opts: { plan?: ChainPlan; facts?: FactsFn; fail?: Fail; entry?: Entry } = {},
) {
  const writes: proof.Write[] = [];
  const entry = opts.entry === 'direct' ? chainSameFileAnchors : chainStampedAnchors;
  const outcome = await entry(issueId, anchors(starts), {
    planner: async () => opts.plan ?? adjacency(),
    linkWriter: proof.captureWriter(writes, opts.fail),
    ...(opts.facts ? { facts: opts.facts } : {}),
  });
  return { writes, outcome };
}

const injectedFacts =
  (truncated = false): FactsFn =>
  async () => ({ issues: proof.proofRowPair(), blockedBy: new Map(), truncated });

describe('adapter: production wiring (shipped source)', () => {
  const stamp = proof.sourceOf('../../anchor-stamp.ts');
  const adapter = proof.sourceOf('../../anchor-chain.ts');

  it('the stamp tail runs the chain with the ranges its own stamp computed', () => {
    expect(stamp).toContain("import { chainStampedAnchors } from './anchor-chain';");
    expect(stamp).toContain('await chainStampedAnchors(issueId, anchorRanges(body));');
    // After the stamp's own entry, so the report the issue already has is never rewritten, and before
    // the return, so a chain outcome cannot be mistaken for a stamp outcome.
    const tail = stamp.slice(stamp.indexOf("action: 'anchor_map_stamped'"));
    expect(tail.indexOf('await chainStampedAnchors')).toBeLessThan(
      tail.indexOf("return { status: 'stamped'"),
    );
  });
  it('the adapter plans with the shared tool and writes only through the existing writer', () => {
    expect(adapter).toContain(CANONICAL_CHAIN_TOOL); // the shipped source names the canonical tool
    expect(CANONICAL_ANCHOR_CHAIN_TOOL).toBe(CANONICAL_CHAIN_TOOL); // and exports exactly that path
    expect(adapter).toContain("export const CHAIN_PLAN_MODE = '--plan-json';"); // A4's spelling
    expect(adapter).toContain('CHAIN_PLAN_MODE]');
    expect(adapter).not.toContain('--issues-plan'); // the draft name the tool never accepted
    expect(adapter).toContain("const { addIssueLink } = await import('./links');");
    expect(adapter).toContain(
      "await linkWriter(Number(e.lower), Number(e.upper), 'blocks', null);",
    );
    expect(adapter).not.toContain('insert(issueLink)');
    expect(adapter).not.toContain('.insert(issueLink');
    expect(adapter).not.toContain('.from(issueLink)'); // no second writer, no second pair table
  });
  it('the adapter holds no rule and reads no facts of its own: slice S2a does', () => {
    expect(adapter).not.toContain('.sort((a, b) => Number(a) - Number(b))'); // the shared rule orders
    expect(adapter).toContain("from './anchor-chain-facts'");
    expect(adapter).not.toContain("from '@repo/db'"); // no query of its own
    expect(adapter).not.toContain('leftJoin');
    expect(adapter).not.toContain('candidateFacts('); // it calls the reader, it does not re-read
    expect(adapter).not.toContain('cycle ='); // no cycle test of its own
  });
  it('the ranges the stamp hands the shared rule group per file, lowest first, symbols with no line', () => {
    const body =
      'Hold tools/mod_a.py:20-24 and tools/mod_a.py:4-6, plus apps/api/src/modules/issues/anchor-stamp.ts::stampIssueAnchors@deadbeefdead.';
    const ranges = anchorRanges(body);
    const byFile = Object.fromEntries(ranges.map((r) => [r.file, r.starts]));
    expect(byFile['tools/mod_a.py']).toEqual([4, 20]);
    expect(byFile['apps/api/src/modules/issues/anchor-stamp.ts']).toEqual([]);
    // The file set is the shared tool's own grammar, so a near name never joins the chain.
    expect(ranges.map((r) => r.file)).not.toContain('tools/mod_a.py.bak');
  });
});

describe('adapter: who may write (Root D2, as clarified)', () => {
  it('the internal actor is the existing named system actor, and no caller can pass one', () => {
    expect(INTERNAL_CHAIN_ACTOR).toBe('AnchorMap');
    expect(proof.sourceOf('../../anchor-chain.ts')).not.toContain('actor?:'); // no actor option exists
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_ACTOR', undefined, async () => {
      expect(chainActor()).toBe(''); // a direct call writes nothing
      expect(stampChainActor()).toBe(INTERNAL_CHAIN_ACTOR); // the auto hook names it itself
    });
  });
  it('the sanctioned auto hook writes with no environment variable and no configuration step', async () => {
    resetLog();
    proof.twoRows();
    const { writes, outcome } = await run(102, [20]); // nothing set in the environment
    expect(outcome.status).toBe('reported');
    expect(outcome.text).toContain(`actor ${INTERNAL_CHAIN_ACTOR}`);
    expect(outcome.text).toContain('plan appliable');
    expect(outcome.applied).toBe(1);
    expect(writes).toEqual([proof.written(102, 101)]);
    expect(proof.chainReports().length).toBe(1);
  });
  it('a direct call with nothing configured is plan-only, and no id is invented', async () => {
    resetLog();
    proof.twoRows();
    const { writes, outcome } = await run(102, [20], { entry: 'direct' });
    expect(writes.length).toBe(0);
    expect(outcome.applied).toBe(0);
    expect(outcome.text).toContain('actor none: plan-only');
    expect(outcome.text).toContain('planned only: no chain actor named');
  });
  it('an explicitly empty actor turns the auto hook off without a code change', async () => {
    resetLog();
    proof.twoRows();
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_ACTOR', '', async () => {
      const { writes, outcome } = await run(102, [20]);
      expect(writes.length).toBe(0);
      expect(outcome.text).toContain('actor none: plan-only');
    });
  });
});

describe('adapter: what a plan may and may not do', () => {
  it('the payload is native: exact paths, the stamped issue own record, native records', async () => {
    resetLog();
    proof.twoRows();
    const seen: unknown[] = [];
    const outcome = await chainStampedAnchors(102, anchors([20]), {
      planner: async (payload) => {
        seen.push(payload);
        return adjacency();
      },
      linkWriter: proof.captureWriter([]),
    });
    const payload = seen[0] as proof.PayloadShape;
    expect(payload.me_id).toBe('102');
    // No range list: the shared rule reads the start lines out of each record's own text.
    expect(payload.files).toEqual([{ path: proof.PROOF_FILE }]);
    expect(payload.issues.map((i) => i.id)).toEqual(['102', '101']); // the stamped issue sends its own
    const rec = payload.issues[1];
    expect(rec).toMatchObject({ id: '101', status: 'open', assignee: null, owner: null });
    expect(rec).toHaveProperty('notes');
    expect(rec).toHaveProperty('created_at');
    expect(rec).toHaveProperty('dependencies');
    expect(outcome.applied).toBe(1);
  });
  it('an existing relation is reported as present and never written twice', async () => {
    resetLog();
    const blockedBy = new Map([['101', ['102']]]);
    const { writes, outcome } = await run(102, [20], {
      plan: adjacency([proof.edge('102', '101', { present: true })]),
      facts: async () => ({ issues: proof.proofRowPair(), blockedBy, truncated: false }),
    });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('edge present');
  });
  it('a plan that is not appliable writes nothing, even for an edge that looks appliable', async () => {
    resetLog();
    proof.twoRows();
    const { writes, outcome } = await run(102, [20], {
      plan: adjacency([proof.edge('102', '101')], false),
    });
    expect(writes.length).toBe(0);
    expect(outcome.applied).toBe(0);
    expect(outcome.text).toContain('planned only: the plan is not appliable');
  });
  it('a candidate read that had to cut the graph withholds permission even over an appliable plan', async () => {
    resetLog();
    proof.twoRows();
    const { writes, outcome } = await run(102, [20], { facts: injectedFacts(true) });
    expect(writes.length).toBe(0);
    expect(outcome.applied).toBe(0);
    expect(outcome.text).toContain('candidate read capped at 11 issues');
    expect(outcome.text).toContain('the graph is incomplete, nothing written');
    expect(outcome.text).toContain('planned only: this read was capped, the graph is incomplete');
    expect(outcome.text).toContain('plan not appliable'); // the head names the withheld permission
    expect(proof.chainReports().length).toBe(1);
  });
  it('a refused plan is reported in the tool own words and writes nothing', async () => {
    resetLog();
    proof.twoRows();
    const refused: ChainPlan = {
      ok: false,
      appliable: false,
      diagnostics: ['no me_id in the input'],
    };
    const { writes, outcome } = await run(102, [20], { plan: refused });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('plan refused');
    expect(outcome.text).toContain('planner: no me_id in the input');
  });
  it('a cycle the shared rule refused is reported and nothing of that file is written', async () => {
    resetLog();
    proof.twoRows();
    const cyclic = [
      proof.edge('102', '101', { cycle: true }),
      proof.edge('101', '102', { cycle: true }),
    ];
    const { writes, outcome } = await run(101, [1], { plan: adjacency(cyclic, false) });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('CYCLE refused');
  });
  it('a claimed blocked issue is reported, never depended', async () => {
    resetLog();
    proof.anchorRows('a', 'b', {}, { assigneeUserId: 'someone' });
    const claimed = adjacency(
      [proof.edge('101', '102', { claimed: true, status: 'in_progress' })],
      false,
    );
    const { writes, outcome } = await run(101, [1], { plan: claimed });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('reported only: the blocked issue is claimed (in_progress)');
  });
  it('unknown facts stay unknown: reported, not overridden', async () => {
    resetLog();
    proof.twoRows();
    const unknown = adjacency(
      [proof.edge('102', '101', { known: false, status: 'in_review' })],
      false,
    );
    const { writes, outcome } = await run(102, [20], { plan: unknown });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('unknown facts, nothing written');
  });
  it('a cross-project overlap is named in the report and never linked', async () => {
    resetLog();
    proof.anchorRows('mine', 'theirs', {}, { projectId: 7 });
    const { writes, outcome } = await run(101, [1], {
      plan: adjacency([proof.edge('101', '102')]),
    });
    expect(writes.length).toBe(0);
    expect(outcome.text).toContain('CROSS-PROJECT, not linked');
    expect(outcome.text).toContain('cross-project overlap on tools/mod_a.py');
  });
  it('an issue whose project is unknown declines instead of guessing a scope', async () => {
    resetLog();
    proof.anchorRows('a', 'b', { projectId: null });
    const { writes, outcome } = await run(101, [1], {
      plan: adjacency([proof.edge('101', '102')]),
    });
    expect(writes.length).toBe(0);
    expect(outcome.status).toBe('no_siblings');
    expect(proof.chainReports().length).toBe(0); // a decline is not a report the issue has to carry
  });
  it('a duplicate the existing writer rejects is the idempotent outcome, not a failure', async () => {
    resetLog();
    proof.twoRows();
    const dup = () => Object.assign(new Error('issue link exists'), { status: 409 });
    const { writes, outcome } = await run(101, [1], {
      plan: adjacency([proof.edge('101', '102')]),
      fail: dup,
    });
    expect(writes.length).toBe(1); // the writer was tried, and its refusal is the answer
    expect(outcome.applied).toBe(0);
    expect(outcome.text).toContain('edge present (rejected as a duplicate)');
  });
  it('an unparseable plan is a reported failure that writes nothing', async () => {
    resetLog();
    proof.twoRows();
    const writes: proof.Write[] = [];
    const outcome = await chainStampedAnchors(101, anchors([1]), {
      planner: async () => {
        throw new Error('plan mode not available');
      },
      linkWriter: proof.captureWriter(writes),
    });
    expect(outcome.status).toBe('failed');
    expect(writes.length).toBe(0);
    expect(proof.chainReports().length).toBe(1);
    expect(JSON.stringify(proof.chainReports()[0])).toContain('plan mode not available');
  });
  it('no anchor and no sibling means the chain does nothing at all', async () => {
    resetLog();
    proof.fixtureRows([proof.row(101, 'no code path here')]);
    let plannerCalled = false;
    const outcome = await chainStampedAnchors(101, [], {
      planner: async () => {
        plannerCalled = true;
        return adjacency([], false);
      },
    });
    expect(outcome.status).toBe('no_siblings');
    expect(plannerCalled).toBe(false);
    expect(proof.chainReports().length).toBe(0);
  });
});

describe('adapter: a chain that cannot run never fails the stamp', () => {
  // Stand-ins for the shared MAP tool, so these proofs are about the chain tail and the shipped
  // subprocess path, not about the map tool (8428's create-stamp and restamp proofs cover that).
  const shapeMapTool = proof.writeProofScript(path.join(proof.TMP, 'map_tool_shape.py'), [
    'import json',
    'print(json.dumps({"files": [{"path": "tools/mod_a.py", "blob_sha": "0" * 40, "lines": 40,',
    '"symbols": [{"name": "hold", "line": 4}], "drift": []}], "virtual_targets": []}))',
  ]);
  const refusalTool = proof.writeProofScript(path.join(proof.TMP, 'refusal_chain_tool.py'), [
    'import json, sys',
    'sys.stdin.read()',
    'print(json.dumps({"ok": False, "appliable": False, "diagnostics": ["no me_id in the input"]}))',
    'sys.exit(2)',
  ]);
  const missingTool = path.join(proof.TMP, 'no-such-chain-tool.py');
  const heldRows = () =>
    proof.fixtureRows([
      proof.row(101, 'Hold tools/mod_a.py:4-6.'),
      proof.row(102, 'Later tools/mod_a.py:20-24.'),
    ]);

  it('the shipped tail survives a missing shared chain tool, and the stamp stays stamped', async () => {
    resetLog();
    heldRows();
    process.env.ITSAPLAN_ANCHOR_MAP_REPO = proof.TMP;
    process.env.ITSAPLAN_ANCHOR_MAP_TOOL = shapeMapTool;
    // A chain tool path that does not exist: this exercises the SHIPPED planner subprocess call, not a
    // stand-in, with the sanctioned interpreter.
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_TOOL', missingTool, async () => {
      expect(anchorChainTool()).toContain('no-such-chain-tool.py');
      const outcome = await stampIssueAnchors(101, 'Hold tools/mod_a.py:4-6.');
      expect(outcome.status).toBe('stamped');
      expect(proof.stampedReports().length).toBe(1);
      expect(proof.chainReports().length).toBe(1); // the chain failure is its own truthful entry
      expect(JSON.stringify(proof.chainReports()[0])).toContain('anchor chain');
      // The stamp's own report is unchanged by the chain: it names the map file only.
      expect(JSON.stringify(proof.stampedReports()[0])).not.toContain('anchor chain');
    });
  });
  it('the shipped planner reports the tool own refusal instead of a crash', async () => {
    resetLog();
    proof.twoRows();
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_TOOL', refusalTool, async () => {
      const outcome = await chainStampedAnchors(101, anchors([4]), {
        linkWriter: async () => {
          throw new Error('the writer must not be reached');
        },
      });
      expect(outcome.status).toBe('reported');
      expect(outcome.applied).toBe(0);
      expect(outcome.text).toContain('plan refused');
      expect(outcome.text).toContain('planner: no me_id in the input');
      expect(proof.chainReports().length).toBe(1);
    });
  });
  it('the shipped tail writes no link of its own when the chain tool is missing', async () => {
    resetLog();
    heldRows();
    process.env.ITSAPLAN_ANCHOR_MAP_REPO = proof.TMP;
    process.env.ITSAPLAN_ANCHOR_MAP_TOOL = shapeMapTool;
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_TOOL', missingTool, async () => {
      const outcome = await stampIssueAnchors(102, 'Later tools/mod_a.py:20-24.');
      expect(outcome.status).toBe('stamped');
      // An issue_link insert would be the only write this step could make; there is none.
      expect(proof.ops('insert.values').filter((o) => o.table === 'issue_link').length).toBe(0);
      expect(proof.chainReports().length).toBe(1);
    });
  });
  it('the default tool is the canonical shared tool beside the shared map tool', () => {
    return proof.withEnv('ITSAPLAN_ANCHOR_CHAIN_TOOL', undefined, async () => {
      expect(anchorChainTool()).toBe(CANONICAL_ANCHOR_CHAIN_TOOL);
      expect(path.dirname(CANONICAL_ANCHOR_CHAIN_TOOL)).toBe(
        path.dirname('/Users/misty/sentinel/sentinel-prod/tools/anchor_map.py'), // one shared checkout
      );
    });
  });
});
