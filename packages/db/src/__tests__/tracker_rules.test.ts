// Bounded process/protocol tests for the tracker-rules transport. Synthetic owner
// fixtures live in a test-owned temp dir; no database, provider, HTTP or server.
// Run from packages/db: bun test --env-file=/dev/null src/__tests__/tracker_rules.test.ts

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTrackerRules,
  type TrackerRulesAnswer,
  type TrackerRulesConfig,
} from '../tracker-rules';

const PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';

// The synthetic owner: dumps the child environment on every run, then answers the
// canned protocol by __mode__ and proves its own liveness with the marker file.
const OWNER_TEMPLATE = `
import json, os, signal, sys, time
import d1_policy_helper

# Root D1 return case: every child ignores SIGTERM, so the transport must
# terminate with a signal that cannot be ignored.
signal.signal(signal.SIGTERM, signal.SIG_IGN)

op = json.load(sys.stdin)
with open("__ENV__", "w", encoding="utf-8") as f:
    json.dump(sorted(os.environ.items()), f)
mode = op.get("__mode__", "allow")
if mode == "allow":
    print("[]")
elif mode == "violations":
    print(json.dumps([
        {"rule": "size", "message": "need a size \\u00e9", "safe_form": "add size-large"},
        {"rule": "id-sequence", "message": "take the next id", "safe_form": "sentinel-prod-1"},
    ]))
elif mode == "malformed-object":
    print(json.dumps({"rule": "size"}))
elif mode == "malformed-scalar":
    print("42")
elif mode == "malformed-null":
    print("null")
elif mode == "malformed-json":
    print("{not json")
elif mode == "malformed-element":
    print(json.dumps([{"rule": "size", "message": "m"}]))
elif mode == "empty-message":
    print(json.dumps([{"rule": "size", "message": "", "safe_form": "s"}]))
elif mode == "nonstring-rule":
    print(json.dumps([{"rule": 7, "message": "m", "safe_form": "s"}]))
elif mode == "nonzero":
    sys.exit(3)
elif mode == "slow":
    time.sleep(float(op.get("__sleep__", 2)))
    with open("__MARKER__", "w", encoding="utf-8") as f:
        f.write("done")
    print("[]")
elif mode == "big-stdout":
    sys.stdout.write("x" * (1024 * 1024)); sys.stdout.flush()
    with open("__MARKER__", "w", encoding="utf-8") as f:
        f.write("done")
    print("[]")
elif mode == "big-stderr":
    sys.stderr.write("y" * (1024 * 1024)); sys.stderr.flush()
    print("[]")
`;

let dir: string;
let ownerPath: string;
let helperPath: string;
let envDumpPath: string;
let markerPath: string;
let pythonSha: string;
let baseConfig: TrackerRulesConfig;

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest('hex');
}

function resetArtifacts(): void {
  rmSync(envDumpPath, { force: true });
  rmSync(markerPath, { force: true });
}

function config(overrides: Partial<TrackerRulesConfig> = {}): TrackerRulesConfig {
  return { ...baseConfig, ...overrides };
}

async function run(
  op: Record<string, unknown>,
  overrides: Partial<TrackerRulesConfig> = {},
): Promise<TrackerRulesAnswer> {
  resetArtifacts();
  return checkTrackerRules(config(overrides), op);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'd1-tracker-rules-'));
  ownerPath = join(dir, 'owner.py');
  helperPath = join(dir, 'd1_policy_helper.py');
  envDumpPath = join(dir, 'child-env.json');
  markerPath = join(dir, 'marker');
  writeFileSync(helperPath, 'MARK = 1\n', 'utf8');
  writeFileSync(
    ownerPath,
    OWNER_TEMPLATE.replaceAll('__ENV__', envDumpPath).replaceAll('__MARKER__', markerPath),
    'utf8',
  );
  pythonSha = await sha256(PYTHON);
  baseConfig = {
    python: PYTHON,
    owner: ownerPath,
    pythonSha256: pythonSha,
    fileSha256: {
      [ownerPath]: await sha256(ownerPath),
      [helperPath]: await sha256(helperPath),
    },
  };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a valid empty answer allows and a valid refusal preserves exact strings', async () => {
  const allow = await run({ op: 'update', notes: 'x' });
  expect(allow).toEqual({ ok: true, violations: [] });
  expect(existsSync(envDumpPath)).toBe(true); // the child really ran

  const refusal = await run({ __mode__: 'violations' });
  expect(refusal).toEqual({
    ok: true,
    violations: [
      { rule: 'size', message: 'need a size é', safe_form: 'add size-large' },
      { rule: 'id-sequence', message: 'take the next id', safe_form: 'sentinel-prod-1' },
    ],
  });
});

test('the transport is async: a fast answer returns while a slow one is still running', async () => {
  const started = performance.now();
  const [fastMs, slowMs] = await Promise.all([
    run({ __mode__: 'allow' }).then((answer) => {
      expect(answer.ok).toBe(true);
      return performance.now() - started;
    }),
    run({ __mode__: 'slow', __sleep__: 0.4 }, { limits: { timeoutMs: 5000 } }).then((answer) => {
      expect(answer.ok).toBe(true);
      return performance.now() - started;
    }),
  ]);
  expect(fastMs).toBeLessThan(400); // spawnSync would wait for the slow one
  expect(slowMs).toBeGreaterThan(fastMs); // the legs resolved independently
});

test('malformed answers refuse, never allow', async () => {
  for (const mode of [
    'malformed-object',
    'malformed-scalar',
    'malformed-null',
    'malformed-json',
    'malformed-element',
    'empty-message',
    'nonstring-rule',
  ]) {
    const answer = await run({ __mode__: mode });
    expect(answer.ok, mode).toBe(false);
    if (!answer.ok) expect(answer.code, mode).toBe('tracker-rules-invalid-answer');
  }
});

test('a nonzero owner exit refuses with its stable code', async () => {
  const answer = await run({ __mode__: 'nonzero' });
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.code).toBe('tracker-rules-nonzero-exit');
});

test('missing or malformed config refuses before any process starts', async () => {
  for (const bad of [
    { ...config(), python: 'python3' },
    { ...config(), owner: 'relative/owner.py' },
    { ...config(), pythonSha256: 'nope' },
    { ...config(), fileSha256: {} },
    { ...config(), fileSha256: { [ownerPath]: 'nope' } },
  ]) {
    const answer = await run({ __mode__: 'allow' }, bad);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe('tracker-rules-config-invalid');
    expect(existsSync(envDumpPath)).toBe(false);
  }
});

test('a missing pinned file or changed bytes refuses and never spawns', async () => {
  const missing = await run(
    { __mode__: 'allow' },
    { fileSha256: { ...baseConfig.fileSha256, [join(dir, 'absent.py')]: '0'.repeat(64) } },
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe('tracker-rules-manifest-missing');
  expect(existsSync(envDumpPath)).toBe(false);

  // a changed imported helper, not just the owner, must be caught
  writeFileSync(helperPath, 'MARK = 2\n', 'utf8');
  const stale = await run({ __mode__: 'allow' });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe('tracker-rules-manifest-mismatch');
  expect(existsSync(envDumpPath)).toBe(false);
  expect(existsSync(markerPath)).toBe(false);
  writeFileSync(helperPath, 'MARK = 1\n', 'utf8'); // restore the fixture

  const changedOwner = await run(
    { __mode__: 'allow' },
    {
      pythonSha256: pythonSha,
      owner: ownerPath,
      fileSha256: { ...baseConfig.fileSha256, [ownerPath]: 'f'.repeat(64) },
    },
  );
  expect(changedOwner.ok).toBe(false);
  if (!changedOwner.ok) expect(changedOwner.code).toBe('tracker-rules-manifest-mismatch');
});

test('a TERM-ignoring owner still dies at the deadline; the child is reaped and the loop stays healthy', async () => {
  const started = performance.now();
  const answer = await run({ __mode__: 'slow', __sleep__: 1.2 }, { limits: { timeoutMs: 100 } });
  const elapsed = performance.now() - started;
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.code).toBe('tracker-rules-timeout');
  expect(elapsed).toBeLessThan(800); // a TERM-ignoring child would outlive this bound
  expect(existsSync(markerPath)).toBe(false); // the child never finished its sleep

  // no orphan, no pending promise: the very next call answers normally
  expect((await run({ __mode__: 'allow' })).ok).toBe(true);
});

test('an output overflow kills the (TERM-ignoring) child and keeps the loop healthy', async () => {
  const stdoutOverflow = await run(
    { __mode__: 'big-stdout' },
    { limits: { maxStdoutBytes: 64, timeoutMs: 5000 } },
  );
  expect(stdoutOverflow.ok).toBe(false);
  if (!stdoutOverflow.ok) expect(stdoutOverflow.code).toBe('tracker-rules-overflow');
  expect(existsSync(markerPath)).toBe(false);

  const stderrOverflow = await run(
    { __mode__: 'big-stderr' },
    { limits: { maxStderrBytes: 64, maxStdoutBytes: 64 * 1024, timeoutMs: 5000 } },
  );
  expect(stderrOverflow.ok).toBe(false);
  if (!stderrOverflow.ok) expect(stderrOverflow.code).toBe('tracker-rules-overflow');

  expect((await run({ __mode__: 'allow' })).ok).toBe(true);
});

test('the encoded input is bounded before any process starts', async () => {
  const answer = await run(
    { op: 'update', notes: 'x'.repeat(1024) },
    { limits: { maxInputBytes: 16 } },
  );
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.code).toBe('tracker-rules-input-too-large');
  expect(existsSync(envDumpPath)).toBe(false);
});

test("the child environment is exactly the minimal set, never the parent's", async () => {
  process.env.PLAN_CLAIM_LEDGER = '/tmp/should-not-leak.json';
  process.env.BD_ALLOW_REPLACE_DESCRIPTION = '1';
  process.env.PYTHONPATH = '/tmp/should-not-leak';
  process.env.D1_TEST_APP_SECRET = 'hunter2';
  try {
    await run({ __mode__: 'allow' });
    const childEnv = new Map(
      JSON.parse(readFileSync(envDumpPath, 'utf8')) as Array<[string, string]>,
    );
    // none of the parent's marker variables may leak into the child
    for (const key of [
      'PLAN_CLAIM_LEDGER',
      'BD_ALLOW_REPLACE_DESCRIPTION',
      'PYTHONPATH',
      'D1_TEST_APP_SECRET',
      'HOME',
      'USER',
      'SHELL',
    ]) {
      expect(childEnv.has(key), key).toBe(false);
    }
    // the child sees exactly the minimal four keys; the macOS spawn layer may add
    // __CF_USER_TEXT_ENCODING, which is runtime-injected, never inherited
    const minimal = new Set(['PATH', 'LANG', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE']);
    const unexpected = [...childEnv.keys()].filter(
      (key) => !minimal.has(key) && key !== '__CF_USER_TEXT_ENCODING',
    );
    expect(unexpected).toEqual([]);
    expect(childEnv.get('PATH')).toBe('/usr/bin:/bin');
    expect(childEnv.get('LANG')).toBe('C.UTF-8');
  } finally {
    delete process.env.PLAN_CLAIM_LEDGER;
    delete process.env.BD_ALLOW_REPLACE_DESCRIPTION;
    delete process.env.PYTHONPATH;
    delete process.env.D1_TEST_APP_SECRET;
  }
});
