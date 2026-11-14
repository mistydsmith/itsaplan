// The shared gate a rig-gated issue write runs through: config read from trusted server process
// environment, the existing rule transport, and one refusal type every process can map to its own
// response. Nothing here decides policy, reads the database, imports an API type or trusts a
// value a client sent. An ordinary project never touches the config; a gated project with no
// config refuses instead of running.
//
// The next unit supplies `op`: the writer builds it from the facts it read on its own locked
// transaction. Nothing in this file claims those facts are authenticated.

import {
  checkTrackerRules,
  type TrackerRulesConfig,
  type TrackerRulesLimits,
  type TrackerRulesRefusalCode,
  type TrackerRulesViolation,
} from './tracker-rules';

// Trusted server config only: the sanctioned interpreter, the reviewed owner script, and the
// manifest that pins the interpreter bytes and every file the owner imports.
export const TRACKER_GATE_ENV = {
  python: 'TRACKER_RULES_PYTHON',
  owner: 'TRACKER_RULES_OWNER',
  manifest: 'TRACKER_RULES_MANIFEST',
} as const;

// Gate-level codes. Every other code on a refusal is the transport's own code, so a pin mismatch,
// a timeout or an invalid answer keeps the name the transport gave it.
export const TRACKER_GATE_REFUSAL_CODES = [
  'tracker-rules-unconfigured',
  'tracker-rules-config-incomplete',
  'tracker-rules-config-invalid',
  'tracker-rules-manifest-unreadable',
  'tracker-rules-manifest-invalid',
  'tracker-rules-op-invalid',
  'tracker-rules-violation',
] as const;

export type TrackerGateRefusalCode =
  (typeof TRACKER_GATE_REFUSAL_CODES)[number] | TrackerRulesRefusalCode;

// One error type for both apps. `@repo/db` cannot import the API's HttpError, so each app maps
// this to its own response; `rule` and `safe_form` are the caller-facing half of the refusal.
export class TrackerGateRefusal extends Error {
  readonly code: TrackerGateRefusalCode;
  readonly rule: string;
  readonly safe_form: string;
  readonly violations: TrackerRulesViolation[];

  constructor(
    code: TrackerGateRefusalCode,
    message: string,
    detail: {
      rule?: string;
      safe_form?: string;
      violations?: TrackerRulesViolation[];
    } = {},
  ) {
    super(message);
    this.name = 'TrackerGateRefusal';
    this.code = code;
    this.rule = detail.rule ?? code;
    this.safe_form = detail.safe_form ?? '';
    this.violations = detail.violations ?? [];
  }
}

export function isTrackerGateRefusal(value: unknown): value is TrackerGateRefusal {
  return value instanceof TrackerGateRefusal;
}

export type TrackerGateConfigState =
  | { state: 'unset' }
  | { state: 'refusal'; code: TrackerGateRefusalCode; message: string }
  | { state: 'configured'; config: TrackerRulesConfig };

interface ManifestFile {
  pythonSha256?: unknown;
  fileSha256?: unknown;
  limits?: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function refusal(code: TrackerGateRefusalCode, message: string): TrackerGateConfigState {
  return { state: 'refusal', code, message };
}

// The manifest is the only source of the expected hashes. They are never derived from the bytes
// that happen to be on disk, so a first run cannot adopt an attacker's or a stale checkout's hash.
function manifestProblem(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return 'the manifest must be a json object';
  }
  const { pythonSha256, fileSha256, limits } = manifest as ManifestFile;
  if (typeof pythonSha256 !== 'string' || !HEX64.test(pythonSha256)) {
    return 'the manifest needs a 64 character hex pythonSha256';
  }
  if (typeof fileSha256 !== 'object' || fileSha256 === null || Array.isArray(fileSha256)) {
    return 'the manifest needs a fileSha256 mapping';
  }
  const pins = Object.entries(fileSha256 as Record<string, unknown>);
  if (pins.length === 0) return 'the manifest needs at least one fileSha256 pin';
  for (const [path, sha] of pins) {
    if (!path.startsWith('/')) return `the manifest pins a path that is not absolute: ${path}`;
    if (typeof sha !== 'string' || !HEX64.test(sha))
      return `the manifest pins ${path} with no sha256`;
  }
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      return 'the manifest limits must be a mapping';
    }
    for (const [key, value] of Object.entries(limits as Record<string, unknown>)) {
      if (!isPositiveInt(value)) return `the manifest limit ${key} must be a positive integer`;
    }
  }
  return null;
}

// One parse per process for a given env triple: a hot write path does not re-read and re-parse the
// manifest every call. The transport still re-hashes the pinned bytes on every run, so a stale
// manifest view can only produce a refusal, never an allow.
const configStates = new Map<string, TrackerGateConfigState>();

function envTriple(): [string, string, string] {
  return [
    process.env[TRACKER_GATE_ENV.python] ?? '',
    process.env[TRACKER_GATE_ENV.owner] ?? '',
    process.env[TRACKER_GATE_ENV.manifest] ?? '',
  ];
}

export async function loadTrackerRulesConfig(): Promise<TrackerGateConfigState> {
  const [python, owner, manifestPath] = envTriple();
  const key = `${python}\u0000${owner}\u0000${manifestPath}`;
  const cached = configStates.get(key);
  if (cached !== undefined) return cached;

  let state: TrackerGateConfigState;
  if (python === '' && owner === '' && manifestPath === '') {
    state = { state: 'unset' };
  } else if (python === '' || owner === '' || manifestPath === '') {
    const missing: string[] = [];
    if (python === '') missing.push(TRACKER_GATE_ENV.python);
    if (owner === '') missing.push(TRACKER_GATE_ENV.owner);
    if (manifestPath === '') missing.push(TRACKER_GATE_ENV.manifest);
    state = refusal(
      'tracker-rules-config-incomplete',
      `a gated write needs every rule variable set; missing ${missing.join(', ')}`,
    );
  } else if (!isAbsolute(python)) {
    state = refusal(
      'tracker-rules-config-invalid',
      `${TRACKER_GATE_ENV.python} must name an absolute path`,
    );
  } else if (!isAbsolute(owner)) {
    state = refusal(
      'tracker-rules-config-invalid',
      `${TRACKER_GATE_ENV.owner} must name an absolute path`,
    );
  } else if (!isAbsolute(manifestPath)) {
    state = refusal(
      'tracker-rules-config-invalid',
      `${TRACKER_GATE_ENV.manifest} must name an absolute path`,
    );
  } else {
    let raw: string;
    try {
      raw = await Bun.file(manifestPath).text();
    } catch {
      state = refusal(
        'tracker-rules-manifest-unreadable',
        `the rule manifest could not be read: ${manifestPath}`,
      );
      configStates.set(key, state);
      return state;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(raw);
    } catch {
      state = refusal(
        'tracker-rules-manifest-invalid',
        `the rule manifest is not json: ${manifestPath}`,
      );
      configStates.set(key, state);
      return state;
    }
    const problem = manifestProblem(manifest);
    if (problem !== null) {
      state = refusal('tracker-rules-manifest-invalid', `the rule manifest is invalid: ${problem}`);
      configStates.set(key, state);
      return state;
    }
    const pinned = manifest as ManifestFile;
    const fileSha256 = pinned.fileSha256 as Record<string, string>;
    const config: TrackerRulesConfig = {
      python,
      owner,
      pythonSha256: pinned.pythonSha256 as string,
      fileSha256,
    };
    if (pinned.limits !== undefined) config.limits = pinned.limits as TrackerRulesLimits;
    state = { state: 'configured', config };
  }
  configStates.set(key, state);
  return state;
}

export interface IssueWriteGateInput {
  // The project's rig id, from the caller's own revalidated read: exactly null for an ordinary
  // project. A rig fact the caller never read is a bug, and it must not bypass the config.
  rigId: number | null;
  // The operation the rule owner evaluates. The next unit builds it from transaction facts.
  op: Record<string, unknown>;
}

// The gate a gated issue write calls inside the caller's own locks. It returns on the ordinary
// project path before any config read or spawn, and throws TrackerGateRefusal in every other
// non-allow case, so the caller's transaction rolls back instead of writing.
export async function gateIssueWrite(input: IssueWriteGateInput): Promise<void> {
  if (typeof input !== 'object' || input === null) {
    throw new TrackerGateRefusal(
      'tracker-rules-op-invalid',
      'the gate needs a { rigId, op } input',
    );
  }
  // Only an explicit null means an ordinary project. A missing or undefined rig id is a caller that
  // never read the rig fact, and it must not silently skip the config and the rule owner.
  if (input.rigId === null) return;
  if (typeof input.rigId !== 'number' || !Number.isInteger(input.rigId) || input.rigId <= 0) {
    throw new TrackerGateRefusal(
      'tracker-rules-op-invalid',
      'rigId must be a positive integer id, or exactly null for an ordinary project',
    );
  }
  const { op } = input;
  if (typeof op !== 'object' || op === null || Array.isArray(op)) {
    throw new TrackerGateRefusal(
      'tracker-rules-op-invalid',
      'op must be the mapping of facts the caller read on its own transaction',
    );
  }

  const state = await loadTrackerRulesConfig();
  if (state.state === 'unset') {
    throw new TrackerGateRefusal(
      'tracker-rules-unconfigured',
      `a gated project needs ${TRACKER_GATE_ENV.python}, ${TRACKER_GATE_ENV.owner} and ` +
        `${TRACKER_GATE_ENV.manifest} set`,
    );
  }
  if (state.state === 'refusal') {
    throw new TrackerGateRefusal(state.code, state.message);
  }

  let answer: Awaited<ReturnType<typeof checkTrackerRules>>;
  try {
    answer = await checkTrackerRules(state.config, op);
  } catch {
    // The transport refuses instead of throwing; an unexpected throw is still not an allow.
    throw new TrackerGateRefusal(
      'tracker-rules-transport-error',
      'the rule transport failed unexpectedly',
    );
  }
  if (!answer.ok) {
    throw new TrackerGateRefusal(answer.code, answer.message);
  }
  if (answer.violations.length > 0) {
    // The first violation carries the caller-facing message verbatim; the rest travel with it.
    const first = answer.violations[0];
    throw new TrackerGateRefusal('tracker-rules-violation', first.message, {
      rule: first.rule,
      safe_form: first.safe_form,
      violations: answer.violations,
    });
  }
}
