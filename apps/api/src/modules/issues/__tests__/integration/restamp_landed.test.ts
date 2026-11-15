// Landing-restamp proofs for sentinel-prod-8428 (A4 items 3-5 and the R2 repair),
// DB-free: the candidate read is served by the recorded fake and the sweep runs
// against a real fixture git checkout built inside this repo. No DB, no DB suite.
// Proofs: checkout defaults, selection as captured from the query builder, exact
// paths and a truthful receipt, a nonzero tool as a failure, contained per-issue
// failure, caps with a resumable cursor, and the post-merge ORIG_HEAD range.
//
// The selection proof asserts what the sweep actually handed the query builder
// (captured by the fake db), not a self-description exported from production.
// The shared tool is the canonical tools/anchor_map.py when installed; while
// sentinel-prod-8427 is unlanded it is not, so those proofs use
// ITSAPLAN_ANCHOR_PROOF_TOOL (the runner points it at the 8427 candidate), and
// print SKIP when neither exists: skipping the prerequisite is not a PASS.

import { describe, expect, it, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  boundaryFile,
  commitRestampCheckpoint,
  pendingFile,
  readBoundary,
  readPending,
  restampIssuesForRange,
  writeBoundary,
  type RestampOptions,
  type RestampReceipt,
} from '../../anchor-restamp';
import { mapRepo, repoRoot, stampIssueAnchors } from '../../anchor-stamp';
import { LOG, resetLog } from './fake_log';

// The stamp proofs run a real Python tool per issue: more than the 5 s default.
setDefaultTimeout(120_000);

// The checkout root from this file's own location: the directory holding both
// apps/api and packages/db (any worktree, no author-local paths).
function checkoutRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'apps', 'api')) && existsSync(path.join(dir, 'packages', 'db')))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the checkout root from ' + from);
}
const ROOT = checkoutRoot(import.meta.dir);
const API = path.join(ROOT, 'apps/api');
const CLI = path.join(ROOT, 'scripts/anchor_map_restamp.ts');
const ENV_KEYS = [
  'ITSAPLAN_ANCHOR_MAP_REPO',
  'ITSAPLAN_ANCHOR_MAP_TOOL',
  'ITSAPLAN_ANCHOR_BOUNDARY_FILE',
  'ITSAPLAN_FAKE_ISSUE_ROWS',
];
type Row = { id: number; body: string; column?: number | null; state?: string | null };
const onBoard = (ids: number[], body: string): Row[] => ids.map((id) => ({ id, body }));

let fixture = ''; // a real git checkout built by this test
let before = ''; // pre-merge tip: git's ORIG_HEAD after the merge
let after = ''; // merged HEAD: the landed range
let proofTool = ''; // the real shared tool, '' when none is available
const savedEnv: Record<string, string | undefined> = {};

function sh(cmd: string[], cwd: string): string {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' }).trim();
}

function useTool(tool: string): void {
  if (tool) process.env.ITSAPLAN_ANCHOR_MAP_TOOL = tool;
  else delete process.env.ITSAPLAN_ANCHOR_MAP_TOOL;
}

function rows(...specs: Row[]): void {
  const f = path.join(fixture, 'rows.json');
  writeFileSync(
    f,
    JSON.stringify(
      specs.map((r) => ({
        id: r.id,
        description: r.body,
        columnId: r.column ?? null,
        stateType: r.state ?? null,
      })),
    ),
  );
  process.env.ITSAPLAN_FAKE_ISSUE_ROWS = f;
}

// Start a proof from a known checkpoint: boundary at `seed` (or absent), no cursor.
async function resetCheckpoint(seed: string | null): Promise<void> {
  rmSync(pendingFile(), { force: true });
  if (seed === null) rmSync(boundaryFile(), { force: true });
  else await writeBoundary(seed);
}

function receipts(): Record<string, unknown>[] {
  return LOG.ops
    .filter((o) => o.op === 'insert.values' && o.table === 'issue_activity')
    .flatMap((o) => (Array.isArray(o.values) ? o.values : [o.values]))
    .filter((r) => JSON.stringify(r).includes('anchor_map_stamped')) as Record<string, unknown>[];
}

function capture(op: string): { table?: string; text?: string } {
  return LOG.ops.filter((o) => o.op === op).slice(-1)[0] ?? {};
}

function skip(msg: string): void {
  console.log(`SKIP ${msg}: shared tool absent (8427 unlanded) and no proof tool set`);
}

// A real tool that exits 3 with a message on stderr.
function brokenTool(): string {
  const f = path.join(fixture, 'broken_tool.py');
  writeFileSync(f, 'import sys\nsys.stderr.write("anchor map tool cannot run\\n")\nsys.exit(3)\n');
  return f;
}

// A real tool that takes 4 s per issue, longer than the configured budget.
function slowTool(): string {
  const f = path.join(fixture, 'slow_tool.py');
  writeFileSync(
    f,
    'import json,sys,time\ntime.sleep(4)\njson.dump({"files": [], "virtual_targets": []}, sys.stdout)\n',
  );
  return f;
}

async function sweep(options: RestampOptions = {}): Promise<RestampReceipt> {
  return restampIssuesForRange(before, after, fixture, options);
}

// Run the shipped CLI's own main() with the argv the git hook passes, where the
// fake serves the board: real range resolution, sweep, checkpoint writes, receipt.
async function runCli(...argv: string[]): Promise<string> {
  const savedArgv = process.argv;
  const savedLog = console.log;
  const out: string[] = [];
  process.argv = ['bun', CLI, ...argv];
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  try {
    const cli = (await import(CLI)) as { main: () => Promise<number> };
    expect(await cli.main()).toBe(0); // a hook body never fails the merge
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
  }
  return out.join('\n');
}

describe('landing restamp (R2: defaults, wiring, checkpoint, failures, caps)', () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    fixture = mkdtempSync(path.join(ROOT, 'anchor-restamp-'));
    sh(['git', 'init', '-q', '-b', 'master'], fixture);
    sh(['git', 'config', 'user.email', 'proof@lane'], fixture);
    sh(['git', 'config', 'user.name', 'proof'], fixture);
    mkdirSync(path.join(fixture, 'tools'), { recursive: true });
    // Pre-merge state: tools/mod_a.py with def a() at 1-2, plus tools/gone.py,
    // which the landing removes.
    writeFileSync(path.join(fixture, 'tools/mod_a.py'), 'def a():\n    return 1\n');
    writeFileSync(path.join(fixture, 'tools/gone.py'), 'def helper():\n    return 1\n');
    sh(['git', 'add', '-A'], fixture);
    sh(['git', 'commit', '-qm', 'pre-merge state'], fixture);
    before = sh(['git', 'rev-parse', 'HEAD'], fixture);
    // The landing arrives on a branch and lands through a merge commit: git
    // writes ORIG_HEAD (the pre-merge tip) before the post-merge hook runs.
    sh(['git', 'checkout', '-q', '-b', 'landing'], fixture);
    writeFileSync(path.join(fixture, 'tools/mod_a.py'), 'import os\n\n\ndef a():\n    return 1\n');
    rmSync(path.join(fixture, 'tools/gone.py'), { force: true });
    writeFileSync(path.join(fixture, 'migrations_add_col.py'), 'def upgrade():\n    pass\n');
    sh(['git', 'add', '-A'], fixture);
    sh(['git', 'commit', '-qm', 'landed change'], fixture);
    sh(['git', 'checkout', '-q', 'master'], fixture);
    sh(['git', 'merge', '-q', '--no-ff', 'landing', '-m', 'landing merge'], fixture);
    after = sh(['git', 'rev-parse', 'HEAD'], fixture);
    process.env.ITSAPLAN_ANCHOR_MAP_REPO = fixture;
    process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = path.join(
      fixture,
      'Output/anchor_maps/.last_landed',
    );
    const canonical = path.join(ROOT, 'tools/anchor_map.py');
    proofTool = existsSync(canonical)
      ? canonical
      : (process.env.ITSAPLAN_ANCHOR_PROOF_TOOL ?? '').trim();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it('test_defaults_resolve_to_the_checkout_without_overrides', () => {
    const saved = [process.env.ITSAPLAN_ANCHOR_MAP_REPO, process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE];
    delete process.env.ITSAPLAN_ANCHOR_MAP_REPO;
    delete process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE;
    try {
      expect(repoRoot()).toBe(ROOT);
      expect(mapRepo()).toBe(ROOT); // not apps/api/src, not packages/db
      // Everything derived from the default lands inside the same checkout.
      expect(path.join(mapRepo(), 'scripts/anchor_map_restamp.ts')).toBe(CLI);
      expect(path.dirname(boundaryFile())).toBe(path.join(mapRepo(), 'Output', 'anchor_maps'));
      expect(path.join(API, 'src/modules/issues/anchor-stamp.ts').startsWith(mapRepo())).toBe(true);
    } finally {
      if (saved[0] !== undefined) process.env.ITSAPLAN_ANCHOR_MAP_REPO = saved[0];
      if (saved[1] !== undefined) process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = saved[1];
    }
  });

  it('test_selection_runs_a_left_join_with_the_null_safe_terminal_filter', async () => {
    if (!proofTool) return skip('selection proof');
    resetLog('ordinary');
    useTool(proofTool);
    rows(
      { id: 101, body: 'anchor tools/mod_a.py:1-2', column: 7, state: 'started' },
      { id: 102, body: 'anchor tools/mod_a.py:4-5', column: null, state: null }, // off any column row
    );
    await sweep();
    const join = capture('left_join');
    expect(join.table).toBe('project_column');
    expect(join.text).toContain('project_column.id'); // the join the sweep built
    expect(join.text).toContain('issue.column_id');
    const where = (capture('where').text ?? '').replace(/\s+/g, ' ');
    expect(where).toContain('archived_at is null');
    expect(where).toContain('state_type is null'); // null-safe: no column row still matches
    expect(where).toContain('not in');
    expect(where).toContain('completed'); // the terminal pair actually bound
    expect(where).toContain('canceled');
    expect(receipts().length).toBe(2);
  });

  it('test_exact_path_matching_and_truthful_receipt_on_a_landed_range', async () => {
    if (!proofTool) return skip('exact-path proof');
    resetLog('ordinary');
    useTool(proofTool);
    rows(
      { id: 101, body: 'anchor tools/mod_a.py:1-2', column: 7, state: 'started' },
      {
        id: 102,
        body: 'anchor tools/mod_a.py:4-5 and tools/mod_a.py::a',
        column: null,
        state: null,
      },
      { id: 103, body: 'anchor tools/mod_a.py.bak:1-2', column: 7, state: 'started' },
      { id: 104, body: 'anchor tests/tools/mod_a.py:1-2', column: 7, state: 'started' },
      { id: 105, body: 'anchor mod_a.pyx:1-2', column: 7, state: 'started' },
      { id: 202, body: 'anchor tools/gone.py:1-2', column: 7, state: 'unstarted' }, // exact changed path resolving to nothing
    );
    const receipt = await sweep();
    expect(receipt.changed_files).toBe(3); // changed, removed, migration-shaped
    expect(receipt.candidates).toBe(3); // exact paths only: 101, 102 and the removed file
    expect(receipt.stamped).toBe(2);
    expect(receipt.noop).toBe(1); // a stamp that resolved nothing is never a success
    expect(receipt.failed).toBe(0);
    expect(new Set(receipts().map((r) => r.issueId))).toEqual(new Set([101, 102]));
    const maps = readdirSync(path.join(fixture, 'Output/anchor_maps/issue-101'));
    const doc = JSON.parse(
      readFileSync(path.join(fixture, 'Output/anchor_maps/issue-101', maps[0]), 'utf8'),
    ) as { files: { path: string; drift: { anchor: string; new?: string }[] }[] };
    expect(doc.files[0].path).toBe('tools/mod_a.py');
    expect(doc.files[0].drift[0].anchor).toBe('tools/mod_a.py:1-2');
    expect(String(doc.files[0].drift[0].new)).toContain('4'); // the symbol that moved
    expect(await commitRestampCheckpoint(receipt)).toBe('advanced');
    expect(readBoundary()).toBe(after);
  });

  it('test_a_nonzero_shared_tool_is_a_failure_not_a_noop', async () => {
    resetLog('ordinary');
    await resetCheckpoint(before);
    useTool(brokenTool());
    rows(...onBoard([301, 302], 'anchor tools/mod_a.py:4-5'));
    const receipt = await sweep();
    useTool(proofTool);
    expect(receipt.attempted).toBe(2);
    expect(receipt.stamped).toBe(0);
    expect(receipt.noop).toBe(0); // an unavailable tool is not a noop
    expect(receipt.failed).toBe(2);
    expect(receipt.failed_reason).toContain('broken_tool.py');
    expect(receipts().length).toBe(0);
    expect(await commitRestampCheckpoint(receipt)).toBe('retained'); // no false checkpoint
    expect(readBoundary()).toBe(before); // the range stays pending, nothing skipped
    expect(await readPending()).toBeNull();
  });

  it('test_per_issue_failure_is_contained', async () => {
    if (!proofTool) return skip('containment proof');
    resetLog('ordinary');
    useTool(proofTool);
    rows(...onBoard([311, 312, 313], 'anchor tools/mod_a.py:4-5'));
    const receipt = await sweep({
      stamp: async (id, body) => {
        if (id === 312) throw new Error('synthetic stamp call failure');
        return stampIssueAnchors(id, body);
      },
    });
    expect(receipt.attempted).toBe(3);
    expect(receipt.failed).toBe(1);
    expect(receipt.stamped).toBe(2);
    expect(receipt.failed_reason).toContain('synthetic stamp call failure');
    const ids = receipts().map((r) => r.issueId);
    expect(ids).not.toContain(312);
    expect(ids).toContain(311);
    expect(ids).toContain(313);
  });

  it('test_caps_stop_the_work_and_leave_the_pending_range_resumable', async () => {
    resetLog('ordinary');
    await resetCheckpoint(before);
    // A short wall clock really bounds a slow tool, and keeps the range pending.
    useTool(slowTool());
    rows(...onBoard([501, 502, 503], 'anchor tools/mod_a.py:4-5'));
    const start = Date.now();
    const slow = await sweep({ capSeconds: 1 });
    const elapsed = Date.now() - start;
    useTool(proofTool);
    expect(elapsed).toBeLessThan(20_000); // the budget actually stopped the work
    expect(slow.capped).toBe(true);
    expect(slow.cap_reason).toContain('wall clock 1s');
    expect(slow.stamped).toBe(0);
    expect(slow.failed).toBeGreaterThan(0); // a killed tool call is a failure
    expect(await commitRestampCheckpoint(slow)).toBe('retained');
    expect(readBoundary()).toBe(before); // the boundary is kept
    // WHY null: a cursor written past a failed issue would skip it next time, so a failed sweep
    // leaves whatever cursor existed - here none - exactly as it was.
    expect(await readPending()).toBeNull();

    if (!proofTool) return skip('issue-cap leg');
    // An issue cap reports itself, leaves a cursor, and the next run resumes
    // after it: the same first N are not retried while the rest wait forever.
    await resetCheckpoint(before);
    rows(...onBoard([403, 401, 405, 402, 404], 'anchor tools/mod_a.py:4-5'));
    const first = await sweep({ capIssues: 3 });
    expect(first.candidates).toBe(5); // the whole hit set is still reported
    expect(first.attempted).toBe(3);
    expect(first.capped).toBe(true);
    expect(first.cap_reason).toContain('issue cap 3');
    expect(first.stamped).toBe(3);
    expect(await commitRestampCheckpoint(first)).toBe('retained');
    expect(readBoundary()).toBe(before);
    expect((await readPending())?.last_issue_id).toBe(403);
    const second = await sweep();
    expect(second.resumed_after).toBe(403);
    expect(second.candidates).toBe(5);
    expect(second.attempted).toBe(2);
    expect(second.stamped).toBe(2);
    expect(second.capped).toBe(false);
    expect(await commitRestampCheckpoint(second)).toBe('advanced');
    expect(readBoundary()).toBe(after);
    expect(await readPending()).toBeNull();
    expect(receipts().length).toBe(5); // every candidate got its stamp
  });

  it('test_virgin_post_merge_run_stamps_from_orig_head_and_seeds_the_boundary', async () => {
    if (!proofTool) return skip('post-merge proof');
    resetLog('ordinary');
    useTool(proofTool);
    rows(
      { id: 511, body: 'anchor tools/mod_a.py:1-2', column: 7, state: 'started' },
      { id: 512, body: 'anchor tools/gone.py:1-2', column: 7, state: 'started' },
      { id: 513, body: 'anchor tools/mod_a.pyx:1-2', column: 7, state: 'started' },
    );
    await resetCheckpoint(null); // a checkout that has never stamped
    expect(readBoundary()).toBeNull();
    const out = await runCli('--post-merge', '--repo', fixture);
    expect(out).toContain('source=orig_head'); // git's own pre-merge tip, not a guess
    expect(out).toContain('checkpoint=advanced');
    expect(out).toContain('changed=3');
    expect(out).toContain('stamped=1');
    expect(out).toContain('noop=1');
    expect(out).toContain('failed=0');
    expect(readBoundary()).toBe(after); // seeded for the next landing
    // The same CLI without hook context and with no boundary will not invent one,
    // and a checkout it cannot read is reported, not guessed.
    await resetCheckpoint(null);
    expect(await runCli('--repo', fixture)).toContain('nothing stamped');
    const savedBoundary = process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE;
    process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = path.join(fixture, 'unreadable_boundary');
    try {
      const out = await runCli('--post-merge', '--repo', path.join(fixture, 'no_such_dir'));
      expect(out).toContain('SKIP');
      expect(out).toContain('nothing stamped');
    } finally {
      process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = savedBoundary;
    }
  });
});
