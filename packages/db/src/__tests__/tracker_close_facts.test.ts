// 8429 G2 — boundary tests for the read-only close-facts observer.
//
// Every fixture is disposable (a temp Git repository, temp files). The close/refuse
// decisions are made by the REAL owner — tools/tracker_rule_close.py — invoked with the
// observer's exact fields; the observer never decides. The owner's exact refusal strings
// are asserted; the owner loads by absolute path and the suite fails loudly if absent.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  observeArtifactFacts,
  observeCodeFacts,
  type CloseFactsResult,
  type CodeCloseFacts,
  type ArtifactCloseFacts,
} from '../tracker-close-facts';

const execFileAsync = promisify(execFile);

const OWNER_DIR =
  process.env.ITSAPLAN_TRACKER_CLOSE_OWNER ?? '/Users/misty/sentinel/sentinel-prod/tools';

let work = '';
let repo = '';
let roots = '';
let sha = '';
let partial = '';

const gitRun = async (dir: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd: dir })).stdout.trim();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const factsOf = (r: CloseFactsResult<CodeCloseFacts> | CloseFactsResult<ArtifactCloseFacts>) =>
  (r as { status: 'ok'; facts: CodeCloseFacts | ArtifactCloseFacts }).facts;

// The real owner's op: op="close", id = the canonical bead id, close_facts = the observer's
// exact fields, plus the owner's configured repo/branch from the same privileged source.
const codeOp = (
  facts: CodeCloseFacts,
  id = 'sentinel-prod-9001',
  configured_repo = repo,
  configured_branch = 'main',
) => ({ op: 'close', id, close_facts: facts, configured_repo, configured_branch });

// The harness: load the REAL owner module from its absolute path and print its verdict
// ("" for the None permit). The owner is the single close-policy owner; this suite only
// hands it the observer's exact fields and asserts its exact strings.
const OWNER_HARNESS = `import json, sys, importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("tracker_rule_close", Path(sys.argv[1]) / "tracker_rule_close.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
v = mod.validate_close(json.loads(sys.argv[2]))
print("" if v is None else v)`;

beforeEach(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'qwen-8429g2-'));
  repo = path.join(work, 'repo');
  roots = path.join(work, 'roots');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(roots, { recursive: true });
  await gitRun(repo, ['init', '-q', '-b', 'main']);
  await gitRun(repo, ['config', 'user.email', 'obs@local']);
  await gitRun(repo, ['config', 'user.name', 'Observer']);
  const write = (rel: string, body: string) => fs.writeFile(path.join(repo, rel), `${body}\n`);
  await write('src/a.ts', 'a');
  await gitRun(repo, ['add', 'src/a.ts']);
  await gitRun(repo, ['commit', '-q', '-m', 'sentinel-prod-9001 seed: establish the tree']);
  await write('src/b.ts', 'b');
  await gitRun(repo, ['add', 'src/b.ts']);
  await gitRun(repo, ['commit', '-q', '-m', 'sentinel-prod-9001 (partial): first slice']);
  await write('src/a.ts', 'a2');
  await gitRun(repo, ['add', 'src/a.ts']);
  await gitRun(repo, ['commit', '-q', '-m', 'sentinel-prod-9001: complete the slice']);
  sha = await gitRun(repo, ['rev-parse', 'main']);
  partial = await gitRun(repo, ['rev-parse', 'HEAD~1']);
  await gitRun(repo, ['checkout', '-q', '-b', 'wip', 'HEAD~2']);
  await write('src/wip.ts', 'w');
  await gitRun(repo, ['add', 'src/wip.ts']);
  await gitRun(repo, ['commit', '-q', '-m', 'sentinel-prod-9001: off-target work']);
});

afterAll(() => work && rmSync(work, { recursive: true, force: true }));

// The real owner's validate_close(op) -> str | None (None = permit; a string is its refusal).
const ownerDecide = async (op: Record<string, unknown>): Promise<string | null> => {
  const owner = path.join(OWNER_DIR, 'tracker_rule_close.py');
  try {
    await fs.access(owner);
  } catch (err) {
    throw new Error(
      `the real owner tools/tracker_rule_close.py must exist for this suite (got: ${(err as Error).message})`,
    );
  }
  const opJson = JSON.stringify(op);
  const { stdout } = await execFileAsync('python3', ['-c', OWNER_HARNESS, OWNER_DIR, opJson]);
  return stdout.trim() === '' ? null : stdout.trim();
};

const base = (): Parameters<typeof observeCodeFacts>[0] => ({
  repoRoot: repo!,
  targetRef: 'main',
  beadId: 'sentinel-prod-9001',
  candidateSha: sha,
  reason: 'the tracked implementation is complete on main',
});

describe('8429 G2 close-facts observer: code facts', () => {
  test('a complete commit on main is observed and the REAL owner permits it', async () => {
    const r = await observeCodeFacts(base());
    expect(r.status).toBe('ok');
    const f = factsOf(r) as CodeCloseFacts;
    expect(f).toEqual({
      verified: true,
      bead_id: 'sentinel-prod-9001',
      kind: 'code',
      reason: base().reason,
      repo: repo,
      branch: 'main',
      sha: sha,
      changed_paths: ['src/a.ts'],
      subject: 'sentinel-prod-9001: complete the slice',
      commit_exists: true,
      on_target_branch: true,
    });
    const verdict = await ownerDecide(codeOp(f));
    expect(verdict, `the real owner must permit these facts: ${verdict}`).toBeNull();
  });

  test('the root commit is observed with its diff against nothing', async () => {
    const rootSha = await gitRun(repo, ['rev-list', '--max-parents=0', 'main']);
    const r = await observeCodeFacts({ ...base(), candidateSha: rootSha });
    expect(r.status).toBe('ok');
    expect(factsOf(r)).toMatchObject({
      changed_paths: ['src/a.ts'],
      commit_exists: true,
      on_target_branch: true,
    });
  });

  test('an unknown SHA is observed truthfully (nothing invented) and the owner refuses', async () => {
    const ghost = 'd'.repeat(40);
    const r = await observeCodeFacts({ ...base(), candidateSha: ghost });
    expect(r.status).toBe('ok');
    // Truthful observation: the fields are the empty truth, nothing invented.
    expect(factsOf(r)).toMatchObject({
      commit_exists: false,
      subject: '',
      changed_paths: [],
      on_target_branch: false,
    });
    const verdict = await ownerDecide(codeOp(factsOf(r) as CodeCloseFacts));
    expect(verdict).toBe(
      'close_facts.changed_paths must be a nonempty list of repo-relative paths the commit actually touched; an empty or non-list value is not a code proof.',
    );
  });

  test('a commit on another branch is observed with on_target_branch=false and the owner refuses', async () => {
    const wipTip = await gitRun(repo, ['rev-parse', 'wip']);
    const r = await observeCodeFacts({ ...base(), candidateSha: wipTip });
    expect(r.status).toBe('ok');
    expect(factsOf(r)).toMatchObject({ on_target_branch: false, commit_exists: true });
    const verdict = await ownerDecide(codeOp(factsOf(r) as CodeCloseFacts));
    expect(verdict).toBe(
      'close_facts.on_target_branch must be exactly True: the commit must sit on the configured branch.',
    );
  });

  test('a subject that does not start with the bead id is refused by the owner with its exact string', async () => {
    const r = await observeCodeFacts({ ...base(), beadId: 'sentinel-prod-8999' });
    expect(r.status).toBe('ok');
    const f = factsOf(r) as CodeCloseFacts;
    expect(f.bead_id).toBe('sentinel-prod-8999'); // the config's bead id; the subject keeps its own
    const verdict = await ownerDecide(codeOp(f, 'sentinel-prod-8999'));
    expect(verdict).toBe(
      "close_facts.subject must begin with the exact canonical id 'sentinel-prod-8999' followed by whitespace, a colon or the end; a prefix collision or a subject naming another bead is not this card's commit.",
    );
  });

  test('a partial-marker subject is refused by the owner with its exact string', async () => {
    const r = await observeCodeFacts({ ...base(), candidateSha: partial });
    expect(r.status).toBe('ok');
    const f = factsOf(r) as CodeCloseFacts;
    expect(f.subject).toBe('sentinel-prod-9001 (partial): first slice');
    const verdict = await ownerDecide(codeOp(f));
    expect(verdict).toBe(
      'A parenthesized partial marker in the subject refuses automatic/final code proof; the final close commit carries no (partial) marker.',
    );
  });

  test('tampered observer output (verified=false) is refused by the owner', async () => {
    const r = await observeCodeFacts(base());
    const f = { ...(factsOf(r) as CodeCloseFacts), verified: false };
    const verdict = await ownerDecide(codeOp(f));
    expect(verdict).toBe(
      'close_facts.verified must be exactly True as observed by the server adapter; truthy strings and 1 are not verified. Re-observe the facts and emit them again.',
    );
  });

  test('a wrong configured_repo is refused by the owner with its exact string', async () => {
    const r = await observeCodeFacts(base());
    const f = factsOf(r) as CodeCloseFacts;
    const verdict = await ownerDecide(codeOp(f, 'sentinel-prod-9001', '/other'));
    expect(verdict).toBe(
      `close_facts.repo '${repo}' does not equal the configured repo '/other'; a code proof on any other repo is refused.`,
    );
  });

  test('a repo root that is not a repository is unavailable, not a refusal', async () => {
    const r = await observeCodeFacts({ ...base(), repoRoot: path.join(work!, 'not-a-repo') });
    expect(r).toMatchObject({ status: 'unavailable', code: 'repo-unavailable' });
  });

  test('an unresolvable target ref refuses as a typed config/semantics refusal', async () => {
    const r = await observeCodeFacts({ ...base(), targetRef: 'no-such-branch' });
    expect(r).toMatchObject({ status: 'refused', code: 'target-ref-unresolvable' });
  });

  test('config refusals: non-absolute root, short sha, empty bead id, empty reason', async () => {
    const cases: Array<[Parameters<typeof observeCodeFacts>[0], string]> = [
      [
        { ...base(), repoRoot: 'relative/path' },
        'repoRoot must be a nonempty absolute POSIX path from the server manifest.',
      ],
      [
        { ...base(), candidateSha: sha.slice(0, 12) },
        'candidateSha must be the full 40-hex commit SHA; abbreviations are not observed.',
      ],
      [
        { ...base(), beadId: '' },
        'beadId must be the nonempty canonical bead id derived from the DB.',
      ],
    ];
    for (const [cfg, reason] of cases) {
      const r = await observeCodeFacts(cfg);
      expect(r, reason).toMatchObject({ status: 'refused', code: 'invalid-config', reason });
    }
  });
});

describe('8429 G2 close-facts observer: artifact facts', () => {
  const artifactOp = (facts: object, id = 'sentinel-prod-9001') => ({
    op: 'close',
    id,
    close_facts: facts,
  });
  const artifactCfg = (over: Partial<Parameters<typeof observeArtifactFacts>[0]> = {}) => ({
    approvedRoots: [roots],
    requestedPath: 'r.md',
    beadId: 'sentinel-prod-9001',
    reason: 'x',
    kind: 'report' as const,
    ...over,
  });

  test('a report artifact inside an approved root is observed and the REAL owner permits it', async () => {
    const body = 'close report for sentinel-prod-9001\n';
    const file = path.join(roots, 'r1/report.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    const r = await observeArtifactFacts(
      artifactCfg({ requestedPath: 'r1/report.md', reason: 'the report is retained' }),
    );
    expect(r.status).toBe('ok');
    const f = factsOf(r) as ArtifactCloseFacts;
    const real = await fs.realpath(file);
    expect(f).toEqual({
      verified: true,
      bead_id: 'sentinel-prod-9001',
      kind: 'report',
      reason: 'the report is retained',
      artifact: real,
      artifact_verified: true,
      artifact_bytes: body.length,
      artifact_sha256: sha256(body),
    });
    const verdict = await ownerDecide(artifactOp(f));
    expect(verdict, `the real owner must permit these artifact facts: ${verdict}`).toBeNull();
  });

  test('a cancel artifact keeps its disposition and the owner permits it', async () => {
    const body = 'cancel record\n';
    const file = path.join(roots, 'c1/cancel.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    const cfg = artifactCfg({
      requestedPath: 'c1/cancel.md',
      kind: 'cancel',
      disposition: 'deferred',
    });
    const r = await observeArtifactFacts(cfg);
    expect(r.status).toBe('ok');
    const f = factsOf(r) as ArtifactCloseFacts;
    expect(f.disposition).toBe('deferred');
    const verdict = await ownerDecide(artifactOp(f));
    expect(verdict, `the real owner must permit these cancel facts: ${verdict}`).toBeNull();
  });

  test('a path that resolves outside every approved root refuses (escape refused, not observed)', async () => {
    const outside = path.join(work, 'outside.md');
    await fs.writeFile(outside, 'x\n');
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: '../outside.md' }));
    expect(r).toMatchObject({
      status: 'refused',
      code: 'artifact-outside-root',
      reason:
        '../outside.md resolves outside every approved root (or escapes one through a symlink).',
    });
  });

  test('a symlink inside a root that escapes the root refuses', async () => {
    const outside = path.join(work, 'secret.md');
    await fs.writeFile(outside, 'x\n');
    await fs.symlink(outside, path.join(roots, 'link.md'));
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: 'link.md' }));
    expect(r).toMatchObject({ status: 'refused', code: 'artifact-outside-root' });
  });

  test('a missing artifact refuses as artifact-missing (a data refusal, not an I/O failure)', async () => {
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: 'no/such/file.md' }));
    expect(r).toMatchObject({
      status: 'refused',
      code: 'artifact-missing',
      reason: 'no approved root holds no/such/file.md.',
    });
  });

  test('an empty artifact refuses as artifact-empty', async () => {
    const file = path.join(roots, 'empty.md');
    await fs.writeFile(file, '');
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: 'empty.md' }));
    expect(r).toMatchObject({
      status: 'refused',
      code: 'artifact-empty',
      reason: `the artifact ${await fs.realpath(file)} is empty; an empty artifact does not close a card.`,
    });
  });

  test('a directory is not a retained artifact', async () => {
    const dir = path.join(roots, 'dir.md');
    await fs.mkdir(dir, { recursive: true });
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: 'dir.md' }));
    expect(r).toMatchObject({
      status: 'refused',
      code: 'artifact-not-file',
      reason: `the resolved artifact ${await fs.realpath(dir)} is not a regular file.`,
    });
  });

  test('an unreadable root is an I/O unavailable, NOT an artifact-missing refusal', async () => {
    if ((process as unknown as { getuid?: () => number }).getuid?.() === 0) return; // root can read anything
    const locked = path.join(work, 'locked');
    await fs.mkdir(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const r = await observeArtifactFacts(
        artifactCfg({ approvedRoots: [roots, locked], requestedPath: 'report.md' }),
      );
      expect(r).toMatchObject({ status: 'unavailable', code: 'fs-error' });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('config refusals: non-absolute root, empty path, empty bead id, cancel without disposition', async () => {
    const cases: Array<[Parameters<typeof observeArtifactFacts>[0], string]> = [
      [
        artifactCfg({ approvedRoots: ['relative'] }),
        'approvedRoots must be a nonempty list of nonempty absolute paths from the server manifest.',
      ],
      [artifactCfg({ requestedPath: '' }), 'requestedPath must be a nonempty path.'],
      [artifactCfg({ beadId: '' }), 'beadId must be the nonempty canonical bead id.'],
      [
        artifactCfg({ kind: 'cancel' }),
        'a cancel close carries a nonempty disposition saying where the work goes.',
      ],
    ];
    for (const [cfg, reason] of cases) {
      const r = await observeArtifactFacts(cfg);
      expect(r, reason).toMatchObject({ status: 'refused', code: 'invalid-config', reason });
    }
  });

  test('a forged artifact fact (artifact_verified=false) is refused by the owner', async () => {
    const file = path.join(roots, 'forged.md');
    await fs.writeFile(file, 'x\n');
    const r = await observeArtifactFacts(artifactCfg({ requestedPath: 'forged.md' }));
    const f = { ...(factsOf(r) as ArtifactCloseFacts), artifact_verified: false };
    const verdict = await ownerDecide(artifactOp(f));
    expect(verdict).toBe(
      'close_facts.artifact_verified must be exactly True: an empty or unverified artifact does not close a card.',
    );
  });
});
