// scripts/proof-filter.test.ts — sentinel-prod-8428 proof-output wrapper parity (R1).
// WHY: the wrapper must never become a second filter. Every behaviour case below runs the SAME
// fixture command twice — once through the shared owner script, once through
// scripts/proof-filter.sh — and requires identical stdout, stderr and exit status after
// normalising only the UTC timestamp and the temp root. The owner script is never copied into
// the repo: the byte-identical copy under a temp root exists so both runs write their full log
// inside that temp root instead of into a real checkout.
// NO DB, NO PROVIDER, NO NETWORK: fixtures are bash scripts and temp directories.
// Run: bun test ./scripts/proof-filter.test.ts

import { afterAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = join(import.meta.dir, 'proof-filter.sh');
const CANONICAL = '/Users/misty/sentinel/sentinel-prod/tools/proof_filter.sh';
const HOST_FALLBACKS = [
  '/Users/misty/sentinel/sentinel-prod-worktrees/master-landing/tools/proof_filter.sh',
  '/Users/misty/sentinel/sentinel-prod-worktrees/master-sync/tools/proof_filter.sh',
];
const LABEL = 'parity case';

/** The shared owner script, or null when this host has no checkout of it (parity is then skipped). */
const SHARED: string | null = (() => {
  const override = process.env.PROOF_FILTER_SHARED;
  if (override && existsSync(override)) return override;
  for (const candidate of [CANONICAL, ...HOST_FALLBACKS])
    if (existsSync(candidate)) return candidate;
  return null;
})();

const parity = SHARED ? describe : describe.skip;
const TEMP_ROOTS: string[] = [];

afterAll(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

type Result = { code: number; stdout: string; stderr: string };

const FIXTURE_COMMAND = `#!/bin/bash
# Fixture proof command for scripts/proof-filter.test.ts. It decides nothing: it prints what the
# shared owner must count, name or cap, and exits with the status under test.
set -uo pipefail
mode="\${1:-pass}"; shift || true
echo "pwd=$PWD"
for a in "$@"; do printf 'arg=[%s]\\n' "$a"; done
case "$mode" in
  pass)
    echo "collected 3 items"
    echo "tests/test_a.py::test_one PASSED"
    echo "3 passed in 0.12s"
    exit 0 ;;
  tally)
    echo "5 passing (1s)"
    exit 0 ;;
  fail81)
    echo "FAILED tests/test_y.py::test_b - assert 1 == 2"
    echo "E       assert 1 == 2"
    echo "E        +  where 1 = int('1')"
    echo "tests/test_y.py:12: AssertionError"
    echo '  File "/repo/tests/test_y.py", line 12, in test_b'
    exit 81 ;;
  exit7)
    echo "plain failure, exit 7"
    exit 7 ;;
  big)
    i=0; while [ "$i" -lt 300 ]; do printf 'E   assert %0400d == 2\\n' "$i"; i=$((i+1)); done
    i=0; while [ "$i" -lt 40 ]; do echo "FAILED tests/test_big.py::test_$i - assert 1 == 2 for case $i"; i=$((i+1)); done
    exit 1 ;;
  *) echo "unknown fixture mode: $mode" >&2; exit 64 ;;
esac
`;

type Fixture = { root: string; cwd: string; tool: string; command: string; logs: string };

/** A throwaway repo-shaped tree: <root>/tools/proof_filter.sh (a byte copy) + a caller cwd. */
function makeFixture(): Fixture {
  if (!SHARED) throw new Error('makeFixture needs the shared owner script');
  const root = mkdtempSync(join(tmpdir(), 'pf-parity-'));
  TEMP_ROOTS.push(root);
  const tools = join(root, 'tools');
  const cwd = join(root, 'caller cwd');
  mkdirSync(tools, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const tool = join(tools, 'proof_filter.sh');
  writeFileSync(tool, readFileSync(SHARED), { mode: 0o755 });
  const command = join(root, 'proof-command.sh');
  writeFileSync(command, FIXTURE_COMMAND, { mode: 0o755 });
  return { root, cwd, tool, command, logs: join(root, 'Output', 'proof_logs') };
}

function run(command: string[], cwd: string, tool?: string): Result {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.PROOF_FILTER_TOOL;
  if (tool) env.PROOF_FILTER_TOOL = tool;
  const out = Bun.spawnSync({ cmd: command, cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: out.exitCode ?? -1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

/** Only the run clock and the temp root may differ between the two runs. */
function normalise(text: string, root: string): string {
  // The shell reports the real path of its cwd, so /tmp and /private/tmp are the same root here.
  const real = realpathSync(root);
  return text
    .replaceAll(real, '<ROOT>')
    .replaceAll(root, '<ROOT>')
    .replace(/\d{8}T\d{6}Z/g, '<TS>');
}

function directArgs(fixture: Fixture, label: string, mode: string, extra: string[] = []): string[] {
  return [label, '--', 'bash', fixture.command, mode, ...extra];
}

/** Run the same fixture through the owner script and through the adapter, and compare. */
function bothRuns(label: string, mode: string, extra: string[] = []) {
  const direct = makeFixture();
  const adapted = makeFixture();
  const directResult = run(
    ['bash', direct.tool, ...directArgs(direct, label, mode, extra)],
    direct.cwd,
  );
  const adapterResult = run(
    [ADAPTER, ...directArgs(adapted, label, mode, extra)],
    adapted.cwd,
    adapted.tool,
  );
  expect(normalise(adapterResult.stdout, adapted.root)).toBe(
    normalise(directResult.stdout, direct.root),
  );
  expect(normalise(adapterResult.stderr, adapted.root)).toBe(
    normalise(directResult.stderr, direct.root),
  );
  expect(adapterResult.code).toBe(directResult.code);
  return { direct, adapted, directResult, adapterResult };
}

function logFiles(fixture: Fixture): string[] {
  if (!existsSync(fixture.logs)) return [];
  const listed = Bun.spawnSync({ cmd: ['/bin/ls', '-1', fixture.logs], stdout: 'pipe' });
  return listed.stdout
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => join(fixture.logs, line));
}

describe('scripts/proof-filter.sh is a door, not a filter', () => {
  it('execs the shared owner instead of reimplementing it', () => {
    const source = readFileSync(ADAPTER, 'utf8');
    expect(source).toContain('exec bash "$tool" "$@"');
    expect(source).toContain(CANONICAL);
    expect(source).toContain('PROOF_FILTER_TOOL');
    // No copy of the owner's algorithm: the cap, the log location and the tallies are the
    // owner's job, so none of them may appear as code here.
    const code = source
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
      .join('\n');
    for (const smell of ['4000', 'Output/proof_logs', 'grep', 'head -', 'awk', 'FAILED']) {
      expect(code).not.toContain(smell);
    }
  });

  it('is executable', () => {
    expect(statSync(ADAPTER).mode & 0o111).not.toBe(0);
  });

  it('fails visibly, and not as a pass, when the shared owner is missing', () => {
    const result = run(
      [ADAPTER, LABEL, '--', 'true'],
      tmpdir(),
      '/nonexistent/tools/proof_filter.sh',
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('shared tool not found: /nonexistent/tools/proof_filter.sh');
    expect(result.stderr).toContain('PROOF_FILTER_TOOL');
  });
});

parity('proof-filter parity with the shared owner', () => {
  it('runs a byte-identical copy of the owner, never a reimplementation', () => {
    // The fixture copy is the owner's own bytes moved into a temp root so the log lands there;
    // no line of the filter is authored in this repo.
    const fixture = makeFixture();
    expect(readFileSync(fixture.tool).equals(readFileSync(SHARED as string))).toBe(true);
  });

  it('passes a passing run through and keeps the owner count and log path', () => {
    const { adapted, adapterResult } = bothRuns(LABEL, 'pass');
    expect(adapterResult.code).toBe(0);
    expect(normalise(adapterResult.stdout, adapted.root)).toMatch(
      /^PASS label=parity case count=3 passed log=<ROOT>\/Output\/proof_logs\/<TS>_parity_case\.log\n$/,
    );
    const [log] = logFiles(adapted);
    expect(log).toBeDefined();
    const body = readFileSync(log as string, 'utf8');
    expect(body).toContain('collected 3 items');
    expect(body).toContain('tests/test_a.py::test_one PASSED');
  });

  it('reports the owner tally verbatim, quirks included', () => {
    // The owner's first tally pattern matches the "5 pass" inside "5 passing", so its count
    // token is "5 pass". The wrapper's job is to carry that through unchanged, not to improve it.
    const { adapterResult } = bothRuns(LABEL, 'tally');
    expect(adapterResult.code).toBe(0);
    expect(adapterResult.stdout).toContain('PASS label=parity case count=5 pass log=');
  });

  it('preserves a failing exit 81 with the failing name, assertion and frames', () => {
    const { adapterResult } = bothRuns(LABEL, 'fail81');
    expect(adapterResult.code).toBe(81);
    expect(adapterResult.stdout).toContain('FAIL label=parity case rc=81 log=');
    expect(adapterResult.stdout).toContain('tests/test_y.py::test_b');
    expect(adapterResult.stdout).toContain('assert 1 == 2');
    expect(adapterResult.stdout).toContain('tests/test_y.py:12:');
    expect(adapterResult.stdout).toContain('--- first assertion diff');
  });

  it('passes an ordinary non-zero status through untouched', () => {
    const { adapterResult } = bothRuns(LABEL, 'exit7');
    expect(adapterResult.code).toBe(7);
    expect(adapterResult.stdout).toContain('FAIL label=parity case rc=7 log=');
  });

  it('caps the failure report while the full log stays on disk', () => {
    const { adapted, adapterResult } = bothRuns(LABEL, 'big');
    const [log] = logFiles(adapted);
    expect(log).toBeDefined();
    const full = readFileSync(log as string);
    // The owner caps its report near 4000 bytes; the log it points at keeps everything.
    expect(adapterResult.stdout.length).toBeLessThan(6000);
    expect(full.length).toBeGreaterThan(100000);
    expect(full.length).toBeGreaterThan(adapterResult.stdout.length);
    expect(adapterResult.stdout).toContain('FAIL label=parity case rc=1 log=');
    expect(adapterResult.stdout).toContain('tests/test_big.py::test_0');
  });

  it('keeps spaces in the label and quoting in the command arguments', () => {
    const { adapted, adapterResult } = bothRuns('my spaced label', 'pass', ['a b', 'c d']);
    expect(adapterResult.code).toBe(0);
    const [log] = logFiles(adapted);
    expect(log).toBeDefined();
    expect(log as string).toContain('_my_spaced_label.log');
    const body = readFileSync(log as string, 'utf8');
    expect(body).toContain('arg=[a b]');
    expect(body).toContain('arg=[c d]');
    expect(body).toContain(`pwd=${realpathSync(adapted.cwd)}`);
  });

  it('takes usage from the owner: exit 2 with the owner usage line', () => {
    for (const args of [[], [LABEL], [LABEL, 'true']]) {
      const direct = makeFixture();
      const adapted = makeFixture();
      const directResult = run(['bash', direct.tool, ...args], direct.cwd);
      const adapterResult = run([ADAPTER, ...args], adapted.cwd, adapted.tool);
      expect(adapterResult.code).toBe(2);
      expect(directResult.code).toBe(2);
      expect(adapterResult.stderr).toContain('usage: ');
      expect(adapterResult.stderr).toContain('<LABEL> -- <CMD...>');
      expect(normalise(adapterResult.stderr, adapted.root)).toBe(
        normalise(directResult.stderr, direct.root),
      );
      expect(logFiles(adapted)).toEqual([]);
    }
  });
});
