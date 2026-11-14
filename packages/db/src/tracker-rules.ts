// One async transport to the Sentinel rule owner; the rule policy itself stays in Python.
//
// The config arrives from trusted server code only. Every run re-verifies the pinned
// bytes, spawns the owner with a minimal child environment, bounds the pipes and
// returns either the exact violations or a stable refusal code. Nothing here decides
// policy, and an invalid answer is never turned into an allow.

const HEX64 = /^[0-9a-f]{64}$/;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

// The child sees only this: no application credentials, PYTHONPATH,
// PLAN_CLAIM_LEDGER or BD_ALLOW_REPLACE_DESCRIPTION can reach it.
const CHILD_ENV = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
} as const;

export const TRACKER_RULES_REFUSAL_CODES = [
  'tracker-rules-config-invalid',
  'tracker-rules-manifest-missing',
  'tracker-rules-manifest-mismatch',
  'tracker-rules-input-too-large',
  'tracker-rules-spawn-failed',
  'tracker-rules-timeout',
  'tracker-rules-overflow',
  'tracker-rules-nonzero-exit',
  'tracker-rules-invalid-answer',
  'tracker-rules-transport-error',
] as const;

export type TrackerRulesRefusalCode = (typeof TRACKER_RULES_REFUSAL_CODES)[number];

export interface TrackerRulesViolation {
  rule: string;
  message: string;
  safe_form: string;
}

export type TrackerRulesAnswer =
  | { ok: true; violations: TrackerRulesViolation[] }
  | { ok: false; code: TrackerRulesRefusalCode; message: string };

export interface TrackerRulesLimits {
  timeoutMs?: number;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface TrackerRulesConfig {
  python: string;
  owner: string;
  pythonSha256: string;
  fileSha256: Record<string, string>;
  limits?: TrackerRulesLimits;
}

interface ResolvedLimits {
  timeoutMs: number;
  maxInputBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

function refuse(code: TrackerRulesRefusalCode, message: string): TrackerRulesAnswer {
  return { ok: false, code, message };
}

// Deterministic bounded termination: SIGKILL cannot be ignored (a TERM-ignoring
// owner must still die), and the reap settles the pipes and the exited promise
// so no timer, reader or child is left behind.
function killChild(child: Bun.Subprocess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}

async function killAndReap(child: Bun.Subprocess): Promise<void> {
  killChild(child);
  try {
    await child.exited;
  } catch {
    // already reaped
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateConfig(config: unknown): TrackerRulesAnswer | ResolvedLimits {
  if (typeof config !== 'object' || config === null) {
    return refuse('tracker-rules-config-invalid', 'config must be a mapping');
  }
  const { python, owner, pythonSha256, fileSha256, limits } = config as Partial<TrackerRulesConfig>;
  const bad = (message: string): TrackerRulesAnswer =>
    refuse('tracker-rules-config-invalid', message);
  if (typeof python !== 'string' || !python.startsWith('/'))
    return bad('config.python must be an absolute path');
  if (typeof owner !== 'string' || !owner.startsWith('/'))
    return bad('config.owner must be an absolute path');
  if (typeof pythonSha256 !== 'string' || !HEX64.test(pythonSha256)) {
    return bad('config.pythonSha256 must be a 64 character hex sha256');
  }
  if (typeof fileSha256 !== 'object' || fileSha256 === null || Array.isArray(fileSha256)) {
    return bad('config.fileSha256 must be a mapping');
  }
  const entries = Object.entries(fileSha256);
  if (entries.length === 0) return bad('config.fileSha256 must pin at least the owner');
  for (const [path, sha] of entries) {
    if (!path.startsWith('/')) return bad('config.fileSha256 paths must be absolute');
    if (typeof sha !== 'string' || !HEX64.test(sha))
      return bad('config.fileSha256 values must be sha256 hex');
  }
  if (!(owner in fileSha256)) return bad('config.fileSha256 must pin the owner script');
  const resolved: ResolvedLimits = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
    maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
  };
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null)
      return bad('config.limits must be a mapping');
    if (limits.timeoutMs !== undefined && !isPositiveInt(limits.timeoutMs)) {
      return bad('config.limits.timeoutMs must be a positive integer');
    }
    if (limits.maxInputBytes !== undefined && !isPositiveInt(limits.maxInputBytes)) {
      return bad('config.limits.maxInputBytes must be a positive integer');
    }
    if (limits.maxStdoutBytes !== undefined && !isPositiveInt(limits.maxStdoutBytes)) {
      return bad('config.limits.maxStdoutBytes must be a positive integer');
    }
    if (limits.maxStderrBytes !== undefined && !isPositiveInt(limits.maxStderrBytes)) {
      return bad('config.limits.maxStderrBytes must be a positive integer');
    }
    if (limits.timeoutMs !== undefined) resolved.timeoutMs = limits.timeoutMs;
    if (limits.maxInputBytes !== undefined) resolved.maxInputBytes = limits.maxInputBytes;
    if (limits.maxStdoutBytes !== undefined) resolved.maxStdoutBytes = limits.maxStdoutBytes;
    if (limits.maxStderrBytes !== undefined) resolved.maxStderrBytes = limits.maxStderrBytes;
  }
  return resolved;
}

async function sha256Hex(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const digest = new Bun.CryptoHasher('sha256');
    digest.update(await file.bytes());
    return digest.digest('hex');
  } catch {
    return undefined; // a directory or an unreadable file is not a pinned byte source
  }
}

// Re-read and re-hash on every run: a positive check from an earlier byte state
// must never be reused.
async function verifyManifest(
  python: string,
  pythonSha256: string,
  fileSha256: Record<string, string>,
): Promise<TrackerRulesAnswer | null> {
  const expected: Array<[string, string]> = [[python, pythonSha256], ...Object.entries(fileSha256)];
  for (const [path, want] of expected) {
    const have = await sha256Hex(path);
    if (have === undefined) {
      return refuse('tracker-rules-manifest-missing', `pinned file is missing: ${path}`);
    }
    if (have !== want) {
      return refuse('tracker-rules-manifest-mismatch', `pinned bytes changed: ${path}`);
    }
  }
  return null;
}

interface Drained {
  bytes: Uint8Array;
  overflow: boolean;
}

// Reads a pipe until it ends or the byte budget is exceeded; on overflow the child
// is killed so the stream ends and no read is left pending.
async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  kill: () => void,
): Promise<Drained> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        kill();
        // release the reader so no read is left pending on the killed pipe
        await reader.cancel().catch(() => {});
        return { bytes: new Uint8Array(0), overflow: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow: false };
}

function parseViolations(text: string): TrackerRulesAnswer {
  if (text.length === 0) {
    return refuse('tracker-rules-invalid-answer', 'the owner answered with empty output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('tracker-rules-invalid-answer', 'the owner answered with malformed json');
  }
  if (!Array.isArray(parsed)) {
    return refuse('tracker-rules-invalid-answer', 'the owner answer must be a json array');
  }
  const violations: TrackerRulesViolation[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      return refuse('tracker-rules-invalid-answer', 'every violation must be an object');
    }
    const violation = item as Record<string, unknown>;
    for (const key of ['rule', 'message', 'safe_form'] as const) {
      const value = violation[key];
      if (typeof value !== 'string' || value.length === 0) {
        return refuse(
          'tracker-rules-invalid-answer',
          `every violation needs a nonempty string ${key}`,
        );
      }
    }
    // the loop above proved all three are nonempty strings
    violations.push({
      rule: violation.rule as string,
      message: violation.message as string,
      safe_form: violation.safe_form as string,
    });
  }
  return { ok: true, violations };
}

export async function checkTrackerRules(
  config: TrackerRulesConfig,
  op: Record<string, unknown>,
): Promise<TrackerRulesAnswer> {
  const validated = validateConfig(config);
  if (typeof validated === 'object' && 'ok' in validated) return validated;
  const limits = validated;

  const manifestBad = await verifyManifest(config.python, config.pythonSha256, config.fileSha256);
  if (manifestBad) return manifestBad;

  const input = new TextEncoder().encode(JSON.stringify(op)); // the caller's op is never rewritten
  if (input.byteLength > limits.maxInputBytes) {
    return refuse('tracker-rules-input-too-large', 'the encoded operation exceeds the input limit');
  }

  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([config.python, '-B', config.owner, '--check-op'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: CHILD_ENV,
    });
  } catch {
    return refuse('tracker-rules-spawn-failed', 'the owner process could not be started');
  }
  if (
    child.stdin == null ||
    typeof child.stdin === 'number' ||
    child.stdout == null ||
    typeof child.stdout === 'number' ||
    child.stderr == null ||
    typeof child.stderr === 'number'
  ) {
    // a live child was already spawned; it must not be left behind
    await killAndReap(child);
    return refuse('tracker-rules-spawn-failed', 'the piped channels were not set up');
  }
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  try {
    // a killed child closes its stdin; the refusal path owns the answer
    child.stdin.write(input);
    child.stdin.end();
  } catch {
    // already dead; the refusal path owns the answer
  }

  const timedOut = { value: false };
  const timer = setTimeout(() => {
    timedOut.value = true;
    // SIGKILL: an owner that ignores TERM must still die at the deadline
    killChild(child);
  }, limits.timeoutMs);
  let stdout: Drained;
  let stderr: Drained;
  try {
    [stdout, stderr] = await Promise.all([
      drainBounded(stdoutStream, limits.maxStdoutBytes, () => killChild(child)),
      drainBounded(stderrStream, limits.maxStderrBytes, () => killChild(child)),
    ]);
    await child.exited;
  } catch {
    // an unexpected pipe error must still leave no orphan: reap, then the
    // timeout state (if any) decides the refusal code
    clearTimeout(timer);
    await killAndReap(child);
    if (timedOut.value) {
      return refuse('tracker-rules-timeout', 'the owner timed out and was killed');
    }
    return refuse('tracker-rules-transport-error', 'the owner pipe failed');
  }
  clearTimeout(timer);

  if (timedOut.value) {
    return refuse('tracker-rules-timeout', 'the owner timed out and was killed');
  }
  if (stdout.overflow || stderr.overflow) {
    await killAndReap(child);
    return refuse(
      'tracker-rules-overflow',
      'the owner output exceeded its byte limit and was killed',
    );
  }
  if (child.exitCode !== 0) {
    return refuse(
      'tracker-rules-nonzero-exit',
      `the owner exited with code ${child.exitCode ?? 'unknown'}`,
    );
  }
  return parseViolations(new TextDecoder('utf-8').decode(stdout.bytes));
}
