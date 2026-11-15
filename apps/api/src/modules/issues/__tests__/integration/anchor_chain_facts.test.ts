// 8428 slice S2a proofs: the FACTS the anchor chain hands the shared rule, and the native payload
// shape the shared rule reads. Anchor: apps/api/src/modules/issues/anchor-chain-facts.ts.
//
// What is claimed, and what is not:
//   PASS  the reads are bounded and honest - one statement carries the unfinished candidates AND their
//         existing 'blocks' relations, the cap counts distinct issues rather than joined rows, and a
//         candidate set beyond the bound is REPORTED as truncated instead of silently shortened;
//         a project that is absent is unknown, never zero; a status is derived from this checkout's
//         own lifecycle, never invented; a record leaves in the keys `bd show --json` gives.
//   PASS  the payload the adapter sends is the native one: exact paths only, the stamped issue's own
//         record first, and existing 'blocks' relations as native dependency objects.
//   PASS  when ITSAPLAN_ANCHOR_CHAIN_PROOF_TOOL names the real shared chain tool, the shared rule's
//         own answers on those native payloads are proved on the shared implementation: bottom-up
//         order, adjacent pairs only, the sibling bound, present, claimed, cycle and unknown facts.
//   SKIP  those shared round trips when no shared chain tool is installed. A skipped prerequisite is
//         not a PASS, and Bun marks such a case (pass) - so the SKIP line is the claim here.
//
// DB-free: the recorded fake the 8428 proofs already use serves the rows; no live database is touched.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { resetLog } from './fake_log';
import {
  candidateFacts,
  knownProject,
  nativeRecord,
  projectsOf,
  selfRow,
  statusOf,
} from '../../anchor-chain-facts';
import {
  askShared,
  crowdedRows,
  dedupeRows,
  fixtureRows,
  installEnv,
  lastOp,
  modAScope,
  nativeFact,
  NATIVE_KEYS,
  ops,
  proofTool,
  relationsOf,
  twelveSameFileFacts,
  restoreEnv,
  row,
  sourceOf,
  twelveSameFile,
} from './anchor_chain.fixtures';

beforeAll(installEnv);
afterAll(restoreEnv);

describe('chain facts: the reads (anchor-chain-facts.ts)', () => {
  it('the candidate read is one statement carrying the issues and their blocks relations', async () => {
    resetLog();
    fixtureRows([row(101, 'a tools/mod_a.py:1-2'), row(102, 'b tools/mod_a.py:20-24')]);
    await candidateFacts(10, modAScope());
    // One statement for the candidates: the relation rides in on a left join, not a second read.
    expect(ops('select').length).toBe(1);
    const joins = ops('left_join');
    const link = joins.find((j) => (j.text ?? '').includes('target_issue_id'));
    expect(link).toBeTruthy();
    expect(link!.table).toBe('anchor_chain_blocks'); // the relation table, aliased for this read
    expect(link!.text).toContain('issue.id');
    expect(link!.text).toContain('blocks'); // bound to kind 'blocks' inside the join
    // Joined last, so the landing restamp's own last-join/last-where capture stays honest.
    expect(joins.slice(-1)[0].table).toBe('project_column');
    const where = (lastOp('where').text ?? '').replace(/\s+/g, ' ');
    expect(where).toContain('archived_at is null');
    expect(where).toContain('state_type is null'); // null-safe: no column row still selects
    expect(where).toContain('not in');
    expect(where).toContain('completed');
    expect(where).toContain('canceled');
  });

  it('the cap counts distinct issues, not joined rows', async () => {
    resetLog();
    // Two issues, one of them carrying a relation row: joined rows are three, issues are two.
    fixtureRows([
      row(101, 'a tools/mod_a.py:1-2', { blockedBySource: 102 }),
      row(101, 'a tools/mod_a.py:1-2', { blockedBySource: null }),
      row(102, 'b tools/mod_a.py:20-24'),
    ]);
    const facts = await candidateFacts(10, modAScope());
    expect(facts.issues.map((r) => Number(r.id))).toEqual([101, 102]);
    expect(facts.truncated).toBe(false);
  });

  it('a candidate set beyond the bound is reported truncated, not silently shortened', async () => {
    resetLog();
    fixtureRows(twelveSameFile());
    const facts = await candidateFacts(10, modAScope());
    // The stamped issue plus the shared rule's own ten siblings: eleven kept, the twelfth reported.
    expect(facts.issues.length).toBe(11);
    expect(facts.issues.map((r) => Number(r.id))).toEqual(
      Array.from({ length: 11 }, (_, i) => 100 + i),
    );
    expect(facts.truncated).toBe(true);
  });

  it('board rows with no business in this chain cannot consume the bound', async () => {
    resetLog();
    fixtureRows(crowdedRows()); // 13 unfinished rows: 11 on other files, with the LOW ids, then the pair
    const facts = await candidateFacts(10, modAScope());
    const ids = facts.issues.map((r) => Number(r.id));
    expect([ids.slice(0, 2), ids.length]).toEqual([[100, 101], 11]); // pair first, and the bound holds
    expect(facts.truncated).toBe(false); // cutting rows that name none of these paths is not a gap here
    expect((lastOp('where').text ?? '').toLowerCase()).toContain('ilike'); // the read is candidate-bound
    if (!proofTool()) return console.log('SKIP crowded board at shared rule: no chain tool set');
    const planOut = askShared({
      me_id: '100', // the pair the shared rule never saw on Root's board, in the rule own order
      files: [{ path: 'tools/mod_a.py' }],
      issues: facts.issues.map((r) => nativeRecord(r, facts.blockedBy)),
    });
    expect(planOut.files?.[0].order).toEqual(['100', '101']);
  });

  it('relations dedupe, ignore themselves and a null join row, and keep an edge to an issue this read did not keep', async () => {
    resetLog();
    fixtureRows(dedupeRows());
    const facts = await candidateFacts(10, modAScope());
    // The edge to 999 travels: erasing it is what showed the shared rule a graph it never saw.
    expect(facts.blockedBy.get('101')).toEqual(['102', '999']);
    expect(facts.blockedBy.size).toBe(1); // no phantom edge to issue 0 from the null join row
    expect(facts.blockedBy.has('102')).toBe(false);
    expect(facts.truncated).toBe(false); // few rows, every issue kept: this read is complete
    const rec = nativeRecord({ id: 101, description: 'a', createdAt: '' }, facts.blockedBy);
    const blocks = (id: string) => ({ depends_on_id: id, issue_id: '101', type: 'blocks' });
    expect(rec.dependencies).toEqual([blocks('102'), blocks('999')]);
  });

  it('a read that filled its row bound reports itself incomplete, and one row short does not', async () => {
    resetLog();
    // Root's 8428 probe shape: 48 joined rows, only two distinct issues.
    fixtureRows([...relationsOf(101, 47), row(102, 'b tools/mod_a.py:20-24')]); // 48 rows, limit 48
    const filled = await candidateFacts(10, modAScope());
    expect(filled.issues.map((r) => Number(r.id))).toEqual([101, 102]);
    expect(filled.truncated).toBe(true); // nothing proves no further row matched
    fixtureRows([...relationsOf(101, 46), row(102, 'b tools/mod_a.py:20-24')]); // 47 rows, one short
    const short = await candidateFacts(10, modAScope());
    expect(short.truncated).toBe(false); // the report is about the bound, not a blanket refusal
    expect(short.blockedBy.get('101')!.length).toBe(46);
  });

  it('selfRow reads the stamped issue own row, and says null when there is none', async () => {
    resetLog();
    fixtureRows([row(101, 'a tools/mod_a.py:1-2'), row(102, 'b tools/mod_a.py:20-24')]);
    const self = await selfRow(101);
    expect(Number(self!.id)).toBe(101);
    expect(await selfRow(999)).toBeNull();
  });

  it('a project that is absent is unknown, not zero', () => {
    expect(knownProject(null)).toBeNull();
    expect(knownProject(undefined)).toBeNull();
    expect(knownProject('')).toBeNull();
    expect(knownProject('not-a-project')).toBeNull();
    expect(knownProject(7)).toBe(7);
    expect(knownProject('7')).toBe(7);
  });

  it('a status is derived from this checkout own lifecycle, never invented', () => {
    expect(statusOf(row(1, 'x'))).toBe('open');
    const freshColumns = ['backlog', 'unstarted'].map((s) =>
      statusOf(row(1, 'x', { stateType: s })),
    );
    expect(freshColumns).toEqual(['open', 'open']); // fresh work may still be chained
    expect(statusOf(row(1, 'x', { stateType: 'started' }))).toBe('in_progress'); // begun work
    expect(statusOf(row(1, 'x', { archivedAt: '2026-11-02T00:00:00Z' }))).toBe('closed');
    expect(statusOf(row(1, 'x', { stateType: 'completed' }))).toBe('closed');
    expect(statusOf(row(1, 'x', { stateType: 'canceled' }))).toBe('closed');
    expect(statusOf(row(1, 'x', { claimOwner: 'someone' }))).toBe('in_progress');
    expect(statusOf(row(1, 'x', { assigneeUserId: 'someone' }))).toBe('in_progress');
  });

  it('a record leaves in the keys the shared planner reads, with relations as native objects', () => {
    const blockedBy = new Map<string, string[]>([['101', ['102', '103']]]);
    const rec = nativeRecord(row(101, 'a tools/mod_a.py:1-2'), blockedBy);
    expect(Object.keys(rec)).toEqual(NATIVE_KEYS);
    expect(rec.id).toBe('101'); // ids travel as strings, the way bd gives them
    expect(rec.status).toBe('open');
    expect(rec.assignee).toBeNull();
    expect(rec.owner).toBeNull();
    expect(rec.dependencies).toEqual([
      { depends_on_id: '102', issue_id: '101', type: 'blocks' },
      { depends_on_id: '103', issue_id: '101', type: 'blocks' },
    ]);
    const when = new Date('2026-11-03T04:05:06Z');
    const dated = nativeRecord(row(102, 'b tools/mod_a.py:20-24', { createdAt: when }), new Map());
    expect(dated.created_at).toBe('2026-11-03T04:05:06.000Z'); // an instant held as a Date travels as one
    expect(nativeRecord(row(103, 'c'), new Map()).dependencies).toEqual([]);
  });

  it('projects keep an unknown sibling as unknown, so an edge can be named rather than guessed', () => {
    const map = projectsOf(101, 1, [row(102, 'b'), row(103, 'c', { projectId: null })]);
    expect(map.get('101')).toBe(1);
    expect(map.get('102')).toBe(1);
    expect(map.get('103')).toBeNull();
  });

  it('a payload built from the reader alone is the payload the shared rule answers', async () => {
    resetLog();
    fixtureRows([row(101, 'a tools/mod_a.py:1-2'), row(102, 'b tools/mod_a.py:20-24')]);
    const self = await selfRow(102);
    const facts = await candidateFacts(10, modAScope());
    const payload = {
      me_id: '102',
      // Exact normalized paths, no range list: the shared rule reads the start lines out of each
      // record's own text.
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeRecord(self!, facts.blockedBy),
        ...facts.issues
          .filter((r) => Number(r.id) !== 102)
          .map((r) => nativeRecord(r, facts.blockedBy)),
      ],
    };
    expect(payload.issues.map((i) => i.id)).toEqual(['102', '101']); // the stamped issue sends its own record
    expect(payload.issues[1]).toMatchObject({
      id: '101',
      status: 'open',
      assignee: null,
      owner: null,
    });
    for (const record of payload.issues) {
      expect(Object.keys(record)).toEqual([
        'id',
        'status',
        'assignee',
        'owner',
        'description',
        'notes',
        'created_at',
        'dependencies',
      ]);
    }
    if (!proofTool()) return console.log('SKIP shared round trip: no shared chain tool set');
    // The real rule accepts what the reader produced and orders it bottom-up by line start.
    const planOut = askShared(payload);
    expect(planOut.files?.[0].order).toEqual(['102', '101']);
    expect(planOut.files?.[0].edges.map((e) => [e.lower, e.upper])).toEqual([['102', '101']]);
    expect(planOut.appliable).toBe(true);
  });

  it('the fact reader chooses no order and judges nothing: it reads and shapes', () => {
    const src = sourceOf('../../anchor-chain-facts.ts');
    expect(src).toContain(
      'export async function candidateFacts(cap: number, scope: CandidateScope)',
    );
    expect(src).toContain('const rowLimit = (candidateCap + 1) * LINKS_PER_ISSUE;'); // row bound from issue bound
    expect(src).toContain('.limit(rowLimit)');
    expect(src).toContain('rows.length >= rowLimit'); // a filled row bound is an incomplete read
    expect(src).toContain('orderBy(issue.id)'); // a deterministic read, so a cut is reproducible
    expect(src).not.toContain('.sort('); // the shared rule owns the order of landing
    expect(src).not.toContain('execFile'); // the rule is called, never copied here
    expect(src).not.toContain('addIssueLink');
    expect(src).not.toContain('insert('); // a reader that writes is not a reader
    expect(src).not.toContain('process.env'); // facts come from rows, not from the machine running them
  });
});

describe('chain facts: the shared rule, answered for real when a shared tool is installed', () => {
  const skip = () => console.log('SKIP shared round trip: no shared chain tool set');

  it('the shared rule orders bottom-up and emits adjacent pairs only', () => {
    if (!proofTool()) return skip();
    const planOut = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeFact('101', 'a tools/mod_a.py:1-2'),
        nativeFact('102', 'b tools/mod_a.py:20-24'),
        nativeFact('103', 'c tools/mod_a.py:9-11'),
      ],
    });
    const file = planOut.files?.[0];
    expect(file).toBeTruthy();
    // Bottom-up by line start: the deepest anchor lands first, so it can never be shifted by a
    // shallower landing. Three members give two edges, never a star.
    expect(file!.order).toEqual(['102', '103', '101']);
    expect(file!.edges.map((e) => [e.lower, e.upper])).toEqual([
      ['102', '103'],
      ['103', '101'],
    ]);
    expect(planOut.appliable).toBe(true);
    for (const e of file!.edges) {
      expect(typeof e.known).toBe('boolean');
      expect(typeof e.present).toBe('boolean');
      expect(typeof e.claimed).toBe('boolean');
      expect(typeof e.cycle).toBe('boolean');
    }
  });

  it('the shared rule bounds the siblings and calls the graph incomplete', () => {
    if (!proofTool()) return skip();
    // Twelve same-file candidates exceed the shared rule's own bound of ten siblings, so the rule says
    // the graph is incomplete rather than plan a chain over facts it did not see.
    const planOut = askShared({
      me_id: '100',
      files: [{ path: 'tools/mod_a.py' }],
      issues: twelveSameFileFacts(),
    });
    expect(planOut.appliable).toBe(false);
    expect(planOut.diagnostics?.some((n) => n.includes('siblings bounded to 10'))).toBe(true);
    expect(planOut.diagnostics?.some((n) => n.includes('the graph is incomplete'))).toBe(true);
  });

  it('the shared rule calls a pair present, a claimed upper unappliable, and a closing edge a cycle', () => {
    if (!proofTool()) return skip();
    const present = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeFact('101', 'a tools/mod_a.py:1-2', {
          dependencies: [{ depends_on_id: '102', issue_id: '101', type: 'blocks' }],
        }),
        nativeFact('102', 'b tools/mod_a.py:20-24'),
      ],
    });
    expect(present.files?.[0].edges[0].present).toBe(true);
    expect(present.appliable).toBe(true); // nothing to write, and nothing refused

    const claimed = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeFact('101', 'a tools/mod_a.py:1-2', { assignee: 'someone' }),
        nativeFact('102', 'b tools/mod_a.py:20-24'),
      ],
    });
    expect(claimed.files?.[0].edges[0].claimed).toBe(true);
    expect(claimed.appliable).toBe(false); // the adapter may not write on a refused permission
    expect(claimed.diagnostics).toContain('claimed: 101');

    const fresh = nativeRecord(
      row(101, 'a tools/mod_a.py:1-2', { stateType: 'started' }),
      new Map(),
    );
    expect(fresh.status).toBe('in_progress'); // a started column is begun work, named as what it is
    const startedUpper = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [fresh, nativeFact('102', 'b tools/mod_a.py:20-24')],
    });
    expect(startedUpper.files?.[0].edges[0].claimed).toBe(true);
    expect(startedUpper.appliable).toBe(false); // the refusal is the rule's, not a flag set here

    const cyclic = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeFact('101', 'a tools/mod_a.py:1-2'),
        nativeFact('102', 'b tools/mod_a.py:20-24', {
          dependencies: [{ depends_on_id: '101', issue_id: '102', type: 'blocks' }],
        }),
      ],
    });
    expect(cyclic.files?.[0].edges[0].cycle).toBe(true);
    expect(cyclic.files?.[0].conflict).toBe(true);
    expect(cyclic.appliable).toBe(false);
  });

  it('a preserved edge to an issue outside the kept set is what makes the shared rule refuse', async () => {
    if (!proofTool()) return skip();
    resetLog();
    fixtureRows([
      row(101, 'a tools/mod_a.py:1-2'),
      row(102, 'b tools/mod_a.py:20-24', { blockedBySource: 999 }), // 999 is closed, or beyond the bound
    ]);
    const facts = await candidateFacts(10, modAScope());
    const issues = facts.issues.map((r) => nativeRecord(r, facts.blockedBy));
    expect(facts.truncated).toBe(false); // the read was complete; the far end simply is not a candidate
    const kept = askShared({ me_id: '102', files: [{ path: 'tools/mod_a.py' }], issues });
    expect(kept.appliable).toBe(false); // the rule's own unknown-fact test, not a flag set here
    expect((kept.diagnostics ?? []).join(' ')).toContain('999');
    // The control: the same two issues with the relation erased is the payload the rule called
    // appliable, so the refusal is the kept fact doing its work.
    const erased = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: issues.map((r) => ({ ...r, dependencies: [] })),
    });
    expect(erased.appliable).toBe(true);
  });

  it('an unknown fact is an unknown, not a maybe', () => {
    if (!proofTool()) return skip();
    const planOut = askShared({
      me_id: '102',
      files: [{ path: 'tools/mod_a.py' }],
      issues: [
        nativeFact('101', 'a tools/mod_a.py:1-2', { status: 'in_review' }),
        nativeFact('102', 'b tools/mod_a.py:20-24'),
      ],
    });
    expect(planOut.files?.[0].edges[0].known).toBe(false);
    expect(planOut.appliable).toBe(false);
  });
});
