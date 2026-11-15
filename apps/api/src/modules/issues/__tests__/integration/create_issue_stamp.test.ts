// createIssue-ingress proofs for the anchor-map stamp (sentinel-prod-8428,
// A4 item 1): the coverage runs through the REAL ingress the product uses —
// apps/api issues/service.ts createIssue (the route's import) with the real
// finishCreate / recordActivity / activity chain and the real shared-tool call
// (anchor-stamp.ts). Only transports are faked: the @repo/db client (recorded
// fake query builder via the anchor_stamp_preload mock) and the gate/identity
// policy packages (stubbed answers). NO LIVE DB anywhere.
//
//   test_ordinary_createIssue_ingress_stamps_once
//       ordinary project: issue writes, exactly one system-actor stamp receipt.
//   test_gated_createIssue_ingress_stamps_once_with_token
//       gated project: identity token prefix, gate sees the proposed write,
//       exactly one stamp receipt.
//   test_gated_refusal_rolls_back_and_stamps_nothing
//       gate refusal: the create (identity, sequence, issue) rolls back, the
//       409 surfaces, and no stamp is ever attempted.
//   test_stamp_failure_leaves_the_issue_committed
//       shared tool unavailable: the issue stands committed; zero receipts.
//   test_shared_tool_contract_on_repo_fixture
//       the shipped shared tool (8427's canonical path) answers the exact
//       document shape this consumer reads; fixture is derived from this repo
//       (apps/api/src/modules/issues/anchor-stamp.ts copied into a temp git
//       repo) — no author-local or cross-lane absolute paths.
//   test_service_ingress_is_the_stamp_call_site
//       static proof: the stamp call sits in createIssue after the commit,
//       fire-and-forget, not in a helper called only by tests.
//   test_landing_hook_wires_the_shipped_cli_in_hook_context
//       lefthook's post-merge step is the shipped CLI run in hook context, and
//       the CLI exits 0 with a truthful receipt when no truthful range exists.
//   test_migration_side_wiring_is_opt_in_and_resolves_the_root
//       the migration side is opt-in, spawns the same CLI, and spawns it from
//       the checkout root (where scripts/ and the git paths are), not packages/.

import { describe, expect, it, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

// The stamp proofs run the real shared tool (a Python AST pass) inside the
// create path; they need more than the 5 s default.
setDefaultTimeout(120_000);
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOG, issueInserts, resetLog, stampedReceipts } from './fake_log';
import {
  CANONICAL_ANCHOR_TOOL,
  SANCTIONED_PYTHON as SANCTIONED_PYTHON_TOOL,
} from '../../anchor-stamp';

process.env.DATABASE_URL ??= 'postgres://fake-db-transport-only/unused';
delete process.env.ITSAPLAN_ANCHOR_MAP_REPO;
delete process.env.ITSAPLAN_ANCHOR_MAP_TOOL;
delete process.env.ITSAPLAN_ANCHOR_MAP_PYTHON;

// Resolve the checkout root from this file's own location: the directory
// holding lefthook.yml (a repo-root file). No author-local paths, and it works
// from any lane worktree or checkout.
function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    try {
      readFileSync(path.join(dir, 'lefthook.yml'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error('could not locate the checkout root from ' + from);
}
const ROOT = findRoot(import.meta.dir);
const API = path.join(ROOT, 'apps/api');
const REPO = ROOT;
// The shared tool the stamp is wired to: the canonical installed path. While
// 8427 is unlanded that path does not exist yet, so a review run points the
// SAME config knob the shipped code reads (ITSAPLAN_ANCHOR_MAP_TOOL) at the
// 8427 candidate; ITSAPLAN_ANCHOR_PROOF_TOOL names it for the proof tests
// only. Nothing here hard-codes another lane's checkout.
const CANON_TOOL = CANONICAL_ANCHOR_TOOL;
const SANCTIONED_PYTHON = SANCTIONED_PYTHON_TOOL;

function toolAvailable(): string | null {
  for (const p of [CANON_TOOL, process.env.ITSAPLAN_ANCHOR_PROOF_TOOL ?? '']) {
    if (!p) continue;
    try {
      readFileSync(p);
      return p;
    } catch {
      /* not there */
    }
  }
  return null;
}

type Service = typeof import('../../service');
let S: Service;
let project: unknown;
let fixtureRepo = '';
const savedEnv: Record<string, string | undefined> = {};

function sh(cmd: string, args: string[], cwd: string = process.cwd()): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

const FIXTURE_REL = 'test/fixtures/anchor_stamp_target.py'; // repo-relative: apps/api/test/fixtures/...
const FIXTURE_REF = 'anchor_target.py:8-9';

async function waitStamp(timeoutMs = 60_000): Promise<Record<string, unknown>[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (stampedReceipts().length) return stampedReceipts();
    await Bun.sleep(150);
  }
  return stampedReceipts();
}

async function createAnchoredIssue(title: string): Promise<Record<string, unknown>> {
  return (await S.createIssue(project as never, {
    columnId: 7,
    title,
    description: `anchor ${FIXTURE_REF} and anchor_target.py::make_thing`,
  })) as unknown as Record<string, unknown>;
}

describe('createIssue anchor stamp (A4: real ingress, no live DB)', () => {
  beforeAll(async () => {
    for (const k of [
      'ITSAPLAN_ANCHOR_MAP_REPO',
      'ITSAPLAN_ANCHOR_MAP_TOOL',
      'ITSAPLAN_ANCHOR_MAP_PYTHON',
    ]) {
      savedEnv[k] = process.env[k];
    }
    // Fixture git repo for the map target: derived from THIS repo's own file
    // (repo-relative), committed in a temp checkout so the shared tool reads
    // it exactly as it reads a landed file.
    fixtureRepo = mkdtempSync(path.join(path.dirname(REPO), 'anchor-stamp-ingress-'));
    sh('git', ['init', '-q', '-b', 'master', fixtureRepo]);
    sh('git', ['-C', fixtureRepo, 'config', 'user.email', 'proof@lane']);
    sh('git', ['-C', fixtureRepo, 'config', 'user.name', 'proof']);
    writeFileSync(
      path.join(fixtureRepo, 'anchor_target.py'),
      readFileSync(path.join(API, FIXTURE_REL)),
    );
    sh('git', ['-C', fixtureRepo, 'add', '-A']);
    sh('git', ['-C', fixtureRepo, 'commit', '-qm', 'fixture: stamp target under test']);
    process.env.ITSAPLAN_ANCHOR_MAP_REPO = fixtureRepo;
    process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = path.join(
      fixtureRepo,
      'Output',
      'anchor_maps',
      '.last_landed',
    );
    // If the shared tool is not installed on the canonical path yet (8427 is
    // unlanded), the stamp proofs run against the candidate named through the
    // same config knob the shipped code reads. Without either, the two stamp
    // proofs report the skip rather than pretend a map was written.
    const tool = toolAvailable();
    if (tool) process.env.ITSAPLAN_ANCHOR_MAP_TOOL = tool;
    else
      console.log(
        'SKIP stamp proofs: shared tool not installed (8427 unlanded) and no ITSAPLAN_ANCHOR_PROOF_TOOL configured',
      );
    S = await import('../../service');
    project = {
      id: 1,
      teamId: 1,
      teamName: 'T',
      teamRef: 't',
      key: 'TST',
      ref: 't.TST',
      name: 'Test Project',
      description: '',
      mcpEnabled: false,
      teamMcpEnabled: false,
      initiativesEnabled: false,
      dashboardsEnabled: false,
      documentsEnabled: false,
      notesEnabled: false,
      cyclesEnabled: false,
      subtasksEnabled: false,
      checklistsEnabled: false,
      issueStatsEnabled: false,
      pointsEstimateEnabled: false,
      timeEstimateEnabled: false,
      timeLoggingEnabled: false,
      availableFeatures: [],
      archivedAt: null,
    };
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fixtureRepo, { recursive: true, force: true });
  });

  it('test_ordinary_createIssue_ingress_stamps_once', async () => {
    resetLog('ordinary');
    if (!toolAvailable()) return; // skip truthfully while 8427 is unlanded
    const row = await createAnchoredIssue('anchored card');
    expect(row.id).toBe(42);
    expect(row.title).toBe('anchored card'); // ordinary: no identity prefix
    const receipts = await waitStamp();
    expect(receipts.length).toBe(1);
    const rec = receipts[0] as {
      action: string;
      kind: string;
      actorUserId: unknown;
      issueId: number;
    };
    expect(rec.action).toBe('anchor_map_stamped');
    expect(rec.kind).toBe('activity');
    expect(rec.actorUserId ?? null).toBeNull(); // system actor: never a user, never a mention
    expect(rec.issueId).toBe(42);
    expect(issueInserts().length).toBe(1); // the issue write stands on its own
    const dir = path.join(fixtureRepo, 'Output', 'anchor_maps', 'issue-42');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const doc = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(doc.files[0].path).toBe('anchor_target.py');
    expect(doc.files[0].blob_sha).toHaveLength(40);
  });

  it('test_gated_createIssue_ingress_stamps_once_with_token', async () => {
    resetLog('gated');
    if (!toolAvailable()) return; // skip truthfully while 8427 is unlanded
    const row = await createAnchoredIssue('anchored card');
    expect(row.title).toBe('TST-7: anchored card'); // gated: the token the identity holds
    const receipts = await waitStamp();
    expect(receipts.length).toBe(1);
    expect(receipts[0].action).toBe('anchor_map_stamped');
    expect(issueInserts().length).toBe(1);
    expect(LOG.rolledBack).toBe(false);
  });

  it('test_gated_refusal_rolls_back_and_stamps_nothing', async () => {
    resetLog('gated');
    const { gateStub } = (await import('./anchor_stamp_preload')) as {
      gateStub: { refusal: unknown };
    };
    gateStub.refusal = { message: 'proposed write names a locked fact' };
    try {
      await expect(createAnchoredIssue('refused card')).rejects.toThrow();
      expect(LOG.rolledBack).toBe(true);
      expect(issueInserts().length).toBe(0); // the identity, sequence and issue rolled back
      await Bun.sleep(800); // the fire-and-forget window: a rolled-back create stamps NOTHING
      expect(stampedReceipts().length).toBe(0);
    } finally {
      gateStub.refusal = null;
    }
  });

  it('test_stamp_failure_leaves_the_issue_committed', async () => {
    resetLog('ordinary');
    process.env.ITSAPLAN_ANCHOR_MAP_TOOL = path.join(
      REPO,
      'scripts',
      'definitely-not-the-anchor-tool.py',
    );
    const row = await createAnchoredIssue('card with a broken stamp');
    expect(row.id).toBe(42);
    expect(issueInserts().length).toBe(1); // the issue write stands
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      if (stampedReceipts().length) break;
      await Bun.sleep(150);
    }
    expect(stampedReceipts().length).toBe(0); // null stamp: no receipt, no failure surfaced
    expect(LOG.rolledBack).toBe(false);
    delete process.env.ITSAPLAN_ANCHOR_MAP_TOOL;
  });

  it('test_shared_tool_contract_on_repo_fixture', () => {
    const tool = toolAvailable();
    if (!tool) {
      console.log(
        'SKIP shared-tool contract: canonical 8427 tool not installed yet (8427 not landed)',
      );
      return;
    }
    const out = execFileSync(
      SANCTIONED_PYTHON,
      ['-B', tool, '--repo', fixtureRepo, '--anchor', FIXTURE_REF],
      { encoding: 'utf8', timeout: 90_000 },
    );
    const doc = JSON.parse(out) as {
      tool: string;
      version: number;
      files: {
        path: string;
        blob_sha: string;
        lines: number;
        symbols: unknown[];
        drift: unknown[];
      }[];
      virtual_targets: unknown[];
    };
    // The exact contract this consumer reads (AnchorMapDoc in anchor-stamp.ts).
    expect(doc.files.length).toBeGreaterThan(0);
    const f = doc.files[0];
    expect(f.path).toBe('anchor_target.py');
    expect(f.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isInteger(f.lines)).toBe(true);
    expect(Array.isArray(f.symbols)).toBe(true);
    expect(Array.isArray(f.drift)).toBe(true);
    expect(Array.isArray(doc.virtual_targets)).toBe(true);
  });

  it('test_service_ingress_is_the_stamp_call_site', () => {
    const src = readFileSync(path.join(API, 'src/modules/issues/service.ts'), 'utf8');
    expect(src).toContain("import { stampIssueAnchors } from './anchor-stamp'");
    const createBody = src.slice(
      src.indexOf('export async function createIssue('),
      src.indexOf('// The creation side effects'),
    );
    expect(createBody).toContain(
      'void stampIssueAnchors(issueId, row.description).catch(() => {})',
    );
    // fire-and-forget AFTER the transaction and finishCreate, not inside them
    expect(createBody.indexOf('void stampIssueAnchors')).toBeGreaterThan(
      createBody.indexOf('.catch((error) =>'),
    );
  });

  it('test_landing_hook_wires_the_shipped_cli_in_hook_context', () => {
    const cfg = readFileSync(path.join(ROOT, 'lefthook.yml'), 'utf8');
    const run = /run:\s*(bun run scripts\/anchor_map_restamp\.ts\s+--post-merge)/.exec(
      cfg.slice(cfg.indexOf('post-merge:')),
    );
    expect(run).not.toBeNull(); // the hook runs the shipped file, in hook context
    const hook = readFileSync(path.join(ROOT, 'scripts/anchor_map_restamp.ts'), 'utf8');
    const sweepSrc = readFileSync(path.join(API, 'src/modules/issues/anchor-restamp.ts'), 'utf8');
    expect(hook).toContain("'post-merge'");
    expect(sweepSrc).toContain('ORIG_HEAD'); // git's own record, not a reflog guess
    expect(sweepSrc).not.toContain('HEAD@{1}');
    // One runner and one stamp helper: the old shell hook is gone, and the sweep
    // carries no second copy of the tool invocation.
    expect(() => readFileSync(path.join(ROOT, 'scripts/anchor_map_postlanding.sh'))).toThrow();
    expect(sweepSrc).toContain('import { fileRefs, mapStoreDir, stampIssueAnchors');
    expect(sweepSrc).not.toContain('execFile(');
    // Child legs, run as the hook runs them. execFileSync throws on a nonzero
    // exit, so reaching the assertions proves exit 0 with a truthful receipt.
    const outside = mkdtempSync(path.join(tmpdir(), 'anchor-restamp-nogit-'));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const seeded = path.join(outside, 'boundary');
    try {
      const unknown = execFileSync(
        'bun',
        [
          'run',
          'scripts/anchor_map_restamp.ts',
          '--post-merge',
          '--repo',
          outside,
          '--boundary',
          path.join(outside, 'none'),
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
      );
      expect(unknown).toContain('SKIP');
      expect(unknown).toContain('nothing stamped');
      writeFileSync(seeded, `${head}\n`); // boundary already at HEAD: empty range
      const atHead = execFileSync(
        'bun',
        [
          'run',
          'scripts/anchor_map_restamp.ts',
          '--post-merge',
          '--repo',
          REPO,
          '--boundary',
          seeded,
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
      );
      expect(atHead).toContain('no truthful landed range');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('test_migration_side_wiring_is_opt_in_and_resolves_the_root', () => {
    const migrate = readFileSync(path.join(ROOT, 'packages/db/src/migrate.ts'), 'utf8');
    expect(migrate).toContain("ITSAPLAN_ANCHOR_RESTAMP_AFTER_MIGRATION === '1'"); // opt-in
    expect(migrate).toContain("Bun.spawn(['bun', 'run', 'scripts/anchor_map_restamp.ts']");
    expect(migrate).toContain("new URL('../../..', import.meta.url).pathname");
    expect(migrate).toContain('anchor restamp after migration skipped'); // never fails the migration
    // packages/db/src -> the checkout root, where scripts/ and the git paths are.
    const cwd = new URL('../../..', `file://${path.join(ROOT, 'packages/db/src/migrate.ts')}`)
      .pathname;
    expect(cwd.replace(/\/$/, '')).toBe(ROOT);
    expect(existsSync(path.join(cwd, 'scripts/anchor_map_restamp.ts'))).toBe(true);
  });
});
