// Non-DB tests for the shared write gate: config from the trusted process environment, the
// existing rule transport, and one refusal type every process can map. The rule owner is a
// synthetic python script in a test-owned temp dir, run by the sanctioned interpreter. No
// database, no HTTP, no provider, and no production owner file is touched.
// Run from packages/db: bun test --env-file=/dev/null src/__tests__/tracker_gate.test.ts

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gateIssueWrite,
  isTrackerGateRefusal,
  loadTrackerRulesConfig,
  TRACKER_GATE_ENV,
  type TrackerGateRefusal,
} from '../tracker-gate';

const PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';
const HEX = '0'.repeat(64);
const J = JSON.stringify;

// The synthetic owner answers the transport protocol by __mode__ and proves every run with an
// environment dump, so "it never spawned" is measured rather than assumed.
const OWNER = `
import json, os, sys, time
op = json.load(sys.stdin)
with open("__ENV__", "w", encoding="utf-8") as f:
    json.dump(sorted(os.environ.items()), f)
mode = op.get("__mode__", "allow")
if mode == "allow":
    print("[]")
elif mode == "violations":
    print(json.dumps([
        {"rule": "size", "message": "needs a size label \\u00e9", "safe_form": "add size-large"},
        {"rule": "id-sequence", "message": "take the next id", "safe_form": "sentinel-prod-1"},
    ]))
elif mode == "nonzero":
    sys.exit(4)
elif mode == "slow":
    time.sleep(float(op.get("__sleep__", 2)))
    with open("__MARKER__", "w", encoding="utf-8") as f:
        f.write("finished")
    print("[]")
elif mode == "big-stdout":
    sys.stdout.write("x" * (1024 * 1024)); sys.stdout.flush()
    print("[]")
`;

let dir: string;
let ownerPath: string;
let helperPath: string;
let envDumpPath: string;
let markerPath: string;
let pythonSha: string;
let ownerSha: string;
let helperSha: string;

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest('hex');
}

function writeRaw(name: string, body: string): string {
  const path = join(dir, `manifest-${name}.json`);
  writeFileSync(path, body, 'utf8');
  return path;
}

// A sound manifest for these fixtures plus any case's overrides. Each case names its own file so
// the once-per-process config cache cannot carry a state from one case into the next.
async function goodManifest(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const body = {
    pythonSha256: pythonSha,
    fileSha256: { [ownerPath]: ownerSha, [helperPath]: helperSha },
    ...overrides,
  };
  return writeRaw(name, JSON.stringify(body));
}

// Each variable's own prior value is restored, so no case leaks a rule config into the next one and
// no case can erase a config the server process genuinely had.
async function withEnv<T>(
  python: string,
  owner: string,
  manifest: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior: Array<[string, string | undefined]> = [
    [TRACKER_GATE_ENV.python, process.env[TRACKER_GATE_ENV.python]],
    [TRACKER_GATE_ENV.owner, process.env[TRACKER_GATE_ENV.owner]],
    [TRACKER_GATE_ENV.manifest, process.env[TRACKER_GATE_ENV.manifest]],
  ];
  process.env[TRACKER_GATE_ENV.python] = python;
  process.env[TRACKER_GATE_ENV.owner] = owner;
  process.env[TRACKER_GATE_ENV.manifest] = manifest;
  try {
    return await run();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// The explicit empty triple every "no config at all" case needs: it is measured against an empty
// triple, not against whatever the process running the suite happened to have inherited.
function emptyTriple<T>(run: () => Promise<T>): Promise<T> {
  return withEnv('', '', '', run);
}

function resetArtifacts(): void {
  rmSync(envDumpPath, { force: true });
  rmSync(markerPath, { force: true });
}

// Runs the gate with any value, so a case can hand it a shape the gate should refuse.
async function gateRaw(input: unknown): Promise<TrackerGateRefusal | null> {
  try {
    await gateIssueWrite(input as { rigId: number | null; op: Record<string, unknown> });
  } catch (error) {
    if (isTrackerGateRefusal(error)) return error;
    throw error;
  }
  return null;
}

async function refusalOnGatedWrite(op: Record<string, unknown>): Promise<TrackerGateRefusal> {
  const refusal = await gateRaw({ rigId: 7, op });
  if (refusal === null) throw new Error('the gate allowed a write it should have refused');
  return refusal;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'd3-tracker-gate-'));
  ownerPath = join(dir, 'owner.py');
  helperPath = join(dir, 'gate_helper.py');
  envDumpPath = join(dir, 'child-env.json');
  markerPath = join(dir, 'marker');
  writeFileSync(helperPath, 'MARK = 1\n', 'utf8');
  writeFileSync(
    ownerPath,
    OWNER.replaceAll('__ENV__', envDumpPath).replaceAll('__MARKER__', markerPath),
    'utf8',
  );
  pythonSha = await sha256(PYTHON);
  ownerSha = await sha256(ownerPath);
  helperSha = await sha256(helperPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('an ordinary project returns before any config read or spawn, even with a broken config', async () => {
  resetArtifacts();
  await emptyTriple(async () => {
    expect(await gateRaw({ rigId: null, op: { op: 'create' } })).toBeNull();
    expect(await gateRaw({ rigId: null, op: { op: 'update' } })).toBeNull();
  });
  // The rig decision comes first: a manifest that could not be read is never opened here.
  await withEnv(PYTHON, ownerPath, join(dir, 'manifest-never-written.json'), async () => {
    expect(await gateRaw({ rigId: null, op: { op: 'create' } })).toBeNull();
  });
  expect(existsSync(envDumpPath)).toBe(false);
});

test('a gated project with no rule config refuses and never spawns', async () => {
  resetArtifacts();
  const refusal = await emptyTriple(() => refusalOnGatedWrite({ op: 'create' }));
  expect(refusal.code).toBe('tracker-rules-unconfigured');
  expect(refusal.violations).toEqual([]);
  expect(existsSync(envDumpPath)).toBe(false);
});

test('a partial rule config refuses and names the variable that is missing', async () => {
  resetArtifacts();
  const good = await goodManifest('partial');
  for (const [python, owner, manifest] of [
    [PYTHON, '', ''],
    [PYTHON, ownerPath, ''],
    ['', ownerPath, good],
  ]) {
    const refusal = await withEnv(python, owner, manifest, () =>
      refusalOnGatedWrite({ op: 'create' }),
    );
    expect(refusal.code, `${python}|${owner}|${manifest}`).toBe('tracker-rules-config-incomplete');
    expect(refusal.message.includes('missing'), refusal.message).toBe(true);
  }
  expect(existsSync(envDumpPath)).toBe(false);
});

test('a rule path that is not absolute refuses before any file is opened', async () => {
  resetArtifacts();
  const good = await goodManifest('paths');
  for (const [python, owner, manifest] of [
    ['python3', ownerPath, good],
    [PYTHON, 'owner.py', good],
    [PYTHON, ownerPath, 'manifest-paths.json'],
  ]) {
    const refusal = await withEnv(python, owner, manifest, () =>
      refusalOnGatedWrite({ op: 'create' }),
    );
    expect(refusal.code, `${python}|${owner}|${manifest}`).toBe('tracker-rules-config-invalid');
  }
  expect(existsSync(envDumpPath)).toBe(false);
});

test('an unreadable manifest refuses, and no expected hash is invented for it', async () => {
  resetArtifacts();
  const refusal = await withEnv(PYTHON, ownerPath, join(dir, 'manifest-absent.json'), () =>
    refusalOnGatedWrite({ op: 'create' }),
  );
  expect(refusal.code).toBe('tracker-rules-manifest-unreadable');
  expect(existsSync(envDumpPath)).toBe(false);
});

test('a malformed manifest refuses with one stable code for every shape', async () => {
  resetArtifacts();
  const pins = J({ [ownerPath]: ownerSha, [helperPath]: helperSha });
  const sha = J(pythonSha);
  const bad: Array<[string, string]> = [
    ['not-json', 'this is not json'],
    ['array', `[${sha}]`],
    ['sha-missing', `{"fileSha256":${pins}}`],
    ['sha-short', `{"pythonSha256":"abc123","fileSha256":${pins}}`],
    ['sha-not-string', `{"pythonSha256":7,"fileSha256":${pins}}`],
    ['no-pins', `{"pythonSha256":${sha},"fileSha256":{}}`],
    ['pins-not-mapping', `{"pythonSha256":${sha},"fileSha256":[1]}`],
    ['relative-pin', `{"pythonSha256":${sha},"fileSha256":{"o.py":${J(HEX)}}}`],
    ['pin-not-hex', `{"pythonSha256":${sha},"fileSha256":{${J(ownerPath)}:1}}`],
    ['bad-limit', `{"pythonSha256":${sha},"fileSha256":${pins},"limits":{"timeoutMs":0}}`],
    ['limits-not-mapping', `{"pythonSha256":${sha},"fileSha256":${pins},"limits":[1,2]}`],
  ];
  for (const [name, body] of bad) {
    const path = writeRaw(name, body);
    const refusal = await withEnv(PYTHON, ownerPath, path, () =>
      refusalOnGatedWrite({ op: 'create' }),
    );
    expect(refusal.code, name).toBe('tracker-rules-manifest-invalid');
  }
  expect(existsSync(envDumpPath)).toBe(false);
});

test('pins are taken as written: a wrong pin on a real file refuses instead of re-deriving', async () => {
  resetArtifacts();
  const stale = await goodManifest('stale-pin', { fileSha256: { [ownerPath]: 'f'.repeat(64) } });
  const refusal = await withEnv(PYTHON, ownerPath, stale, () =>
    refusalOnGatedWrite({ op: 'create' }),
  );
  expect(refusal.code).toBe('tracker-rules-manifest-mismatch');
  expect(refusal.message.includes(ownerPath), refusal.message).toBe(true);
  expect(existsSync(envDumpPath)).toBe(false); // refused on the pin before spawning
});

test('a policy violation surfaces the exact rule, message and safe_form with every violation', async () => {
  const manifest = await goodManifest('violation');
  resetArtifacts();
  const refusal = await withEnv(PYTHON, ownerPath, manifest, () =>
    refusalOnGatedWrite({ __mode__: 'violations', op: 'update', id: 'sentinel-prod-1' }),
  );
  expect(refusal.code).toBe('tracker-rules-violation');
  expect(refusal.rule).toBe('size');
  expect(refusal.message).toBe('needs a size label é');
  expect(refusal.safe_form).toBe('add size-large');
  expect(refusal.violations).toEqual([
    { rule: 'size', message: 'needs a size label é', safe_form: 'add size-large' },
    { rule: 'id-sequence', message: 'take the next id', safe_form: 'sentinel-prod-1' },
  ]);
  expect(existsSync(envDumpPath)).toBe(true); // the owner really evaluated this op
});

test('a real allow returns and the owner ran with only the minimal child environment', async () => {
  const manifest = await goodManifest('allow');
  resetArtifacts();
  const refusal = await withEnv(PYTHON, ownerPath, manifest, () =>
    gateRaw({ rigId: 7, op: { op: 'create', id: 'sentinel-prod-2' } }),
  );
  expect(refusal).toBeNull();
  const childEnv = new Map(
    JSON.parse(await Bun.file(envDumpPath).text()) as Array<[string, string]>,
  );
  expect(childEnv.get('PATH')).toBe('/usr/bin:/bin');
  expect([...childEnv.keys()].filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([
    'LANG',
    'PATH',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONNOUSERSITE',
  ]);
});

test('manifest limits reach the transport: a slow owner times out and a loud one overflows', async () => {
  resetArtifacts();
  const slowManifest = await goodManifest('limits-slow', { limits: { timeoutMs: 120 } });
  const slow = await withEnv(PYTHON, ownerPath, slowManifest, () =>
    refusalOnGatedWrite({ __mode__: 'slow', __sleep__: 1.5 }),
  );
  expect(slow.code).toBe('tracker-rules-timeout');
  expect(existsSync(markerPath)).toBe(false); // the child never reached its own marker
  const loudManifest = await goodManifest('limits-loud', { limits: { maxStdoutBytes: 64 } });
  const loud = await withEnv(PYTHON, ownerPath, loudManifest, () =>
    refusalOnGatedWrite({ __mode__: 'big-stdout' }),
  );
  expect(loud.code).toBe('tracker-rules-overflow');
});

test("a bridge answer that is not an allow refuses with the transport's own code", async () => {
  const manifest = await goodManifest('nonzero');
  resetArtifacts();
  const refusal = await withEnv(PYTHON, ownerPath, manifest, () =>
    refusalOnGatedWrite({ __mode__: 'nonzero' }),
  );
  expect(refusal.code).toBe('tracker-rules-nonzero-exit');
  expect(refusal.rule).toBe('tracker-rules-nonzero-exit'); // no violation to name, so the code
  expect(refusal.safe_form).toBe('');
  expect(refusal.violations).toEqual([]);
});

test('a rig id or op the caller could not have read from its own transaction refuses', async () => {
  const manifest = await goodManifest('inputs');
  resetArtifacts();
  for (const input of [
    { rigId: 7, op: null },
    { rigId: 7, op: 'create' },
    { rigId: 7, op: [1, 2] },
    { rigId: 0, op: { op: 'create' } },
    { rigId: -3, op: { op: 'create' } },
    { rigId: 1.5, op: { op: 'create' } },
    { rigId: 'seven', op: { op: 'create' } },
    // A rig fact the caller never read: omitted entirely, or present as undefined. Neither is an
    // ordinary project, and neither may reach the config or the rule owner.
    { op: { op: 'create' } },
    { rigId: undefined, op: { op: 'create' } },
    null,
  ]) {
    const refusal = await withEnv(PYTHON, ownerPath, manifest, () => gateRaw(input));
    expect(refusal === null, JSON.stringify(input)).toBe(false);
    if (refusal !== null) expect(refusal.code).toBe('tracker-rules-op-invalid');
  }
  expect(existsSync(envDumpPath)).toBe(false);
});

test('one env triple is parsed once, and the variables a case sets come back exactly as they were', async () => {
  const manifest = await goodManifest('cache');
  const state = await withEnv(PYTHON, ownerPath, manifest, loadTrackerRulesConfig);
  expect(state.state).toBe('configured');
  if (state.state === 'configured') {
    expect(state.config.python).toBe(PYTHON);
    expect(state.config.owner).toBe(ownerPath);
    expect(Object.keys(state.config.fileSha256)).toEqual([ownerPath, helperPath]);
  }
  expect(await withEnv(PYTHON, ownerPath, manifest, loadTrackerRulesConfig)).toBe(state);
  // A prior value a process genuinely had is put back, not deleted, by a case that ran inside it.
  // The /kept triple is installed through the same helper, so even it is restored to whatever the
  // process really started with.
  const inherited: Array<string | undefined> = [
    process.env[TRACKER_GATE_ENV.python],
    process.env[TRACKER_GATE_ENV.owner],
    process.env[TRACKER_GATE_ENV.manifest],
  ];
  await withEnv('/kept/interpreter', '/kept/owner.py', '/kept/manifest.json', async () => {
    await withEnv(PYTHON, ownerPath, manifest, async () => {
      expect(process.env[TRACKER_GATE_ENV.python]).toBe(PYTHON);
    });
    expect(process.env[TRACKER_GATE_ENV.python]).toBe('/kept/interpreter');
    expect(process.env[TRACKER_GATE_ENV.owner]).toBe('/kept/owner.py');
    expect(process.env[TRACKER_GATE_ENV.manifest]).toBe('/kept/manifest.json');
  });
  const unset = await emptyTriple(loadTrackerRulesConfig);
  expect(unset.state).toBe('unset');
  expect(await emptyTriple(loadTrackerRulesConfig)).toBe(unset);
  expect([
    process.env[TRACKER_GATE_ENV.python],
    process.env[TRACKER_GATE_ENV.owner],
    process.env[TRACKER_GATE_ENV.manifest],
  ]).toEqual(inherited);
});

test('every file this suite writes belongs to its own temp dir', async () => {
  const manifest = await goodManifest('owned');
  resetArtifacts();
  const refusal = await withEnv(PYTHON, ownerPath, manifest, () =>
    gateRaw({ rigId: 7, op: { op: 'create' } }),
  );
  expect(refusal).toBeNull();
  for (const path of [ownerPath, helperPath, envDumpPath, markerPath, manifest]) {
    expect(path.startsWith(dir), path).toBe(true);
  }
  expect(existsSync(envDumpPath)).toBe(true);
});
