// 8429 G2 — server-observed close facts (read-only observer).
//
// WHY: a bead closes only on VERIFIED facts, and the single substantive close policy stays
// tools/tracker_rule_close.py at Sentinel master (the real owner). This observer only
// COLLECTS the facts that owner evaluates: it reads the actual Git object database and the
// actual artifact bytes and emits the owner's exact code/report/cancel fields. It never
// rewrites the decision: a partial marker, a wrong bead subject or a non-target commit is
// observed truthfully and refused BY THE OWNER — no compatibility or subject-only bypass.
//
// Provenance: every input comes from the privileged server manifest (configured absolute
// repository root, target branch/ref, DB-derived canonical bead id, candidate full SHA,
// close reason, approved artifact roots) — never from a request body. Git runs use
// execFile with an argv list (no shell), bounded timeout and buffer, cwd = the configured
// root, and are strictly read-only (rev-parse/log/diff-tree/merge-base, reads); it writes,
// deletes, moves nothing and makes no close decision.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// Bounded by default; the manifest may narrow, never widen past the hard caps.
const TIMEOUT = { def: 5000, max: 10_000 };
const BUFFER = { def: 1024 * 1024, max: 4 * 1024 * 1024 };
const FULL_SHA = /^[0-9a-f]{40}$/;

// Refusal: inputs do not hold together, or the observation is a truthful "no" (data/config,
// never policy — the owner refuses the close itself from the fields it is handed).
export const CLOSE_FACTS_REFUSAL_CODES = [
  'invalid-config',
  'target-ref-unresolvable',
  'artifact-missing',
  'artifact-outside-root',
  'artifact-not-file',
  'artifact-empty',
] as const;

// Unavailable: the observation could not be performed (git/OS I/O) — not a refusal, not an allow.
export const CLOSE_FACTS_UNAVAILABLE_CODES = [
  'repo-unavailable',
  'git-unavailable',
  'fs-error',
] as const;

export type CloseFactsRefusalCode = (typeof CLOSE_FACTS_REFUSAL_CODES)[number];
export type CloseFactsUnavailableCode = (typeof CLOSE_FACTS_UNAVAILABLE_CODES)[number];

// The owner's exact code-close fields (tools/tracker_rule_close.py _check_code). The caller
// attaches op.configured_repo / op.configured_branch from the SAME privileged config; the
// owner compares repo/branch against them byte for byte.
export interface CodeCloseFacts {
  verified: boolean;
  bead_id: string;
  kind: 'code';
  reason: string;
  repo: string;
  branch: string;
  sha: string;
  changed_paths: string[];
  subject: string;
  commit_exists: boolean;
  on_target_branch: boolean;
}

// The owner's exact report/cancel-close fields (_check_artifact + the cancel disposition).
export interface ArtifactCloseFacts {
  verified: boolean;
  bead_id: string;
  kind: 'report' | 'cancel';
  reason: string;
  artifact: string;
  artifact_verified: boolean;
  artifact_bytes: number;
  artifact_sha256: string;
  disposition?: string;
}

export type CloseFactsResult<T> =
  | { status: 'ok'; facts: T }
  | { status: 'refused'; code: CloseFactsRefusalCode; reason: string }
  | { status: 'unavailable'; code: CloseFactsUnavailableCode; reason: string };

type CodeResult = CloseFactsResult<CodeCloseFacts>;
type ArtifactResult = CloseFactsResult<ArtifactCloseFacts>;

// Every field of CodeFactsConfig comes from the privileged server manifest, never the body.
export interface CodeFactsConfig {
  repoRoot: string;
  targetRef: string;
  beadId: string;
  candidateSha: string;
  reason: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

// The approved roots are configured (manifest); requestedPath must resolve INSIDE one.
export interface ArtifactFactsConfig {
  approvedRoots: string[];
  requestedPath: string;
  beadId: string;
  reason: string;
  kind: 'report' | 'cancel';
  // Cancel closes carry where the work goes; report closes do not.
  disposition?: string;
}

// ok = exit 0; otherwise the exit code (1 = the meaningful "no") or an I/O failure reason.
interface GitOutcome {
  ok: boolean;
  stdout: string;
  unavailable?: string;
}

// The error shape execFile surfaces: an exit code, a timeout kill, or an errno such as ENOENT.
interface GitExecError {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  message?: unknown;
}

function bounded(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, cap);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.trim() !== '';
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// One bounded git argv run in the configured repository. No shell, no env changes.
// Exit 0 is success; exit 1 is the meaningful "no" (unknown revision, not an ancestor);
// any other code, a missing git, a timeout kill or a buffer overflow is an I/O failure.
async function git(
  repoRoot: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer,
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as GitExecError;
    if (e.code === 0) return { ok: true, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
    if (e.code === 1) return { ok: false, stdout: '' }; // unknown revision / not an ancestor
    const why =
      typeof e.code === 'number'
        ? `exited ${e.code}`
        : e.killed === true
          ? 'timed out'
          : String(e.code ?? e.message ?? 'failed');
    return { ok: false, stdout: '', unavailable: `git ${args[0]} ${why}` };
  }
}

function gitUnavailable(reason: string) {
  return {
    status: 'unavailable' as const,
    code: 'git-unavailable' as const,
    reason,
  };
}

// A config/semantics refusal (invalid-config) in one line.
const cfgRefusal = (message: string) => ({
  status: 'refused' as const,
  code: 'invalid-config' as const,
  reason: message,
});

function validateCodeConfig(config: CodeFactsConfig): string | null {
  if (!isAbsolutePath(config.repoRoot))
    return 'repoRoot must be a nonempty absolute POSIX path from the server manifest.';
  if (!isNonemptyString(config.targetRef))
    return 'targetRef must be a nonempty configured branch/ref name.';
  if (!isNonemptyString(config.beadId))
    return 'beadId must be the nonempty canonical bead id derived from the DB.';
  if ([...config.beadId].some((ch) => /\s/.test(ch)))
    return 'beadId must be a canonical bead id carrying no whitespace.';
  if (!FULL_SHA.test(config.candidateSha))
    return 'candidateSha must be the full 40-hex commit SHA; abbreviations are not observed.';
  if (!isNonemptyString(config.reason))
    return 'reason must be the nonempty close reason from the server manifest.';
  return null;
}

// Observe the code-close facts for a candidate commit. Every returned field is what the
// object database actually holds; the owner decides the close from them.
export async function observeCodeFacts(config: CodeFactsConfig): Promise<CodeResult> {
  const refusal = validateCodeConfig(config);
  if (refusal) return { status: 'refused', code: 'invalid-config', reason: refusal };
  const timeoutMs = bounded(config.timeoutMs, TIMEOUT.def, TIMEOUT.max);
  const maxBuffer = bounded(config.maxBuffer, BUFFER.def, BUFFER.max);
  const { repoRoot, targetRef, beadId, candidateSha, reason } = config;

  // One owner-shaped fact set; only the observed fields vary per outcome.
  const codeFacts = (
    sha: string,
    changedPaths: string[],
    subject: string,
    exists: boolean,
    onTarget: boolean,
  ): CodeCloseFacts => ({
    verified: true,
    bead_id: beadId,
    kind: 'code',
    reason,
    repo: repoRoot,
    branch: targetRef,
    sha,
    changed_paths: changedPaths,
    subject,
    commit_exists: exists,
    on_target_branch: onTarget,
  });

  // The configured root must actually be a Git repository before any fact can be observed.
  const repoProbe = await git(repoRoot, ['rev-parse', '--git-dir'], timeoutMs, maxBuffer);
  if (!repoProbe.ok) {
    const notRepo = `the configured repository root ${repoRoot} is not a readable Git repository.`;
    return {
      status: 'unavailable',
      code: 'repo-unavailable',
      reason: repoProbe.unavailable ?? notRepo,
    };
  }

  const targetArgs = ['rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`];
  const targetProbe = await git(repoRoot, targetArgs, timeoutMs, maxBuffer);
  if (targetProbe.unavailable) return gitUnavailable(targetProbe.unavailable);
  if (!targetProbe.ok) {
    const badTarget = `the configured target ref ${targetRef} does not resolve to a commit in ${repoRoot}.`;
    return { status: 'refused', code: 'target-ref-unresolvable', reason: badTarget };
  }
  const targetSha = targetProbe.stdout.trim();
  const commitArgs = ['rev-parse', '--verify', '--quiet', `${candidateSha}^{commit}`];
  const commitProbe = await git(repoRoot, commitArgs, timeoutMs, maxBuffer);
  if (commitProbe.unavailable) return gitUnavailable(commitProbe.unavailable);
  if (!commitProbe.ok) {
    // Observed truth: no such commit — fields stay empty, nothing invented; owner refuses.
    return {
      status: 'ok',
      facts: codeFacts(candidateSha, [], '', false, false),
    };
  }
  const fullSha = commitProbe.stdout.trim();

  // Subject and parent list in one bounded read (%x1f is the unit separator).
  const logArgs = ['log', '-1', '--format=%s%x1f%P', fullSha];
  const logRun = await git(repoRoot, logArgs, timeoutMs, maxBuffer);
  if (logRun.unavailable) return gitUnavailable(logRun.unavailable);
  const [subject = '', parents = ''] = logRun.ok
    ? logRun.stdout.replace(/\n$/, '').split('\x1f')
    : [];

  // The paths this commit actually changed, repo-relative. A root commit diffs against
  // nothing (--root); an ordinary commit diffs against its one parent; a merge is compared with
  // its OWN VERIFIED FIRST PARENT, named explicitly as the base of the diff.
  // WHY the explicit pair (sentinel-prod-8364 close-gate repair): `diff-tree --no-commit-id
  // --name-only -r --first-parent <merge>` prints nothing for a merge commit - measured on the
  // landed merge a3e145db5310c632ae2750b69ab2543af05c9f45, where it returned zero paths while the
  // merge's own first-parent diff holds five. A real landing was therefore observed as changing no
  // paths and the owner refused the close with a 409. Plain diff-tree on a merge is equally empty.
  // The first parent is taken from the same verified `log -1 --format=%P` read as the parents
  // themselves, so the comparison is derived from the commit's own ancestry: no ref, path or
  // bypass is ever taken from a caller. Root and ordinary single-parent commits keep their old
  // commands unchanged, and the ancestry, subject, repository guard, timeout and buffer reads are
  // the same calls as before.
  let diffArgs: string[];
  if (parents === '')
    diffArgs = ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', fullSha];
  else if (parents.includes(' '))
    diffArgs = [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      parents.split(' ')[0],
      fullSha,
    ];
  else diffArgs = ['diff-tree', '--no-commit-id', '--name-only', '-r', fullSha];
  const diffRun = await git(repoRoot, diffArgs, timeoutMs, maxBuffer);
  if (diffRun.unavailable) return gitUnavailable(diffRun.unavailable);
  const changedPaths = diffRun.ok
    ? diffRun.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];

  const ancestryArgs = ['merge-base', '--is-ancestor', fullSha, targetSha];
  const ancestry = await git(repoRoot, ancestryArgs, timeoutMs, maxBuffer);
  if (ancestry.unavailable) return gitUnavailable(ancestry.unavailable);

  return {
    status: 'ok',
    facts: codeFacts(fullSha, changedPaths, subject, true, ancestry.ok),
  };
}

// Observe the report/cancel artifact facts: the actual retained bytes inside the approved
// roots. A body-supplied path that resolves outside them, or a symlink escaping them,
// refuses; the observer never deletes or changes the artifact.
export async function observeArtifactFacts(config: ArtifactFactsConfig): Promise<ArtifactResult> {
  const { approvedRoots, requestedPath, beadId, reason, kind, disposition } = config;
  if (
    !Array.isArray(approvedRoots) ||
    approvedRoots.length === 0 ||
    approvedRoots.some((r) => !isAbsolutePath(r))
  )
    return cfgRefusal(
      'approvedRoots must be a nonempty list of nonempty absolute paths from the server manifest.',
    );
  if (!isNonemptyString(requestedPath)) return cfgRefusal('requestedPath must be a nonempty path.');
  if (!isNonemptyString(beadId))
    return cfgRefusal('beadId must be the nonempty canonical bead id.');
  if (!isNonemptyString(reason)) return cfgRefusal('reason must be a nonempty string.');
  if (kind !== 'report' && kind !== 'cancel') return cfgRefusal('kind must be report or cancel.');
  if (kind === 'cancel' && !isNonemptyString(disposition))
    return cfgRefusal('a cancel close carries a nonempty disposition saying where the work goes.');

  let missing = true;
  let outside = true;
  let fsFailure: string | null = null;
  for (const root of approvedRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A root that does not resolve holds nothing; a root that exists but cannot be
      // traversed (EACCES and friends) is an I/O failure, and no "missing" claim may stand.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      fsFailure = `approved root ${root} is not readable: ${(err as Error).message}`;
      continue;
    }
    const candidate = path.resolve(realRoot, requestedPath);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue; // try the next root; a symlink loop is ENOENT-ish
      fsFailure = `cannot resolve ${requestedPath} under ${root}: ${(err as Error).message}`;
      continue;
    }
    missing = false;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue; // escaped: keep checking
    outside = false;
    let stat;
    try {
      stat = await fs.stat(real);
    } catch (err) {
      fsFailure = `cannot stat ${real}: ${(err as Error).message}`;
      continue;
    }
    if (!stat.isFile())
      return {
        status: 'refused',
        code: 'artifact-not-file',
        reason: `the resolved artifact ${real} is not a regular file.`,
      };
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(real);
    } catch (err) {
      fsFailure = `cannot read ${real}: ${(err as Error).message}`;
      continue;
    }
    if (bytes.length === 0)
      return {
        status: 'refused',
        code: 'artifact-empty',
        reason: `the artifact ${real} is empty; an empty artifact does not close a card.`,
      };
    return {
      status: 'ok',
      facts: {
        verified: true,
        bead_id: beadId,
        kind,
        reason,
        artifact: real,
        artifact_verified: true,
        artifact_bytes: bytes.length,
        artifact_sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(kind === 'cancel' && disposition !== undefined ? { disposition } : {}),
      },
    };
  }
  if (fsFailure) return { status: 'unavailable', code: 'fs-error', reason: fsFailure };
  const missingMsg = `no approved root holds ${requestedPath}.`;
  if (missing) return { status: 'refused', code: 'artifact-missing', reason: missingMsg };
  if (outside)
    return {
      status: 'refused',
      code: 'artifact-outside-root',
      reason: `${requestedPath} resolves outside every approved root (or escapes one through a symlink).`,
    };
  return { status: 'refused', code: 'artifact-missing', reason: missingMsg };
}
