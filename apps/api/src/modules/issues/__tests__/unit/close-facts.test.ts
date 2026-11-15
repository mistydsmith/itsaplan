// closeOpFields against a disposable Git repository and artifact root, judged by the real rule
// owner through gateIssueWrite. No database. The manifest is a test-owned temp copy of the composed
// pins plus a close section for one synthetic rig.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { gateIssueWrite, TRACKER_GATE_ENV } from '@repo/db/tracker-gate';
import {
  claimFactsOf,
  closeBackstopApplies,
  closeIsProven,
  closeOpFields,
  closerOf,
  isBareClose,
  closeRepoFor,
  type CloseRequest,
} from '../../close-facts';

const COMPOSED =
  process.env.TRACKER_ROUTING_TEST_CONFIG ??
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/CONFIG.json';
const pins = JSON.parse(readFileSync(COMPOSED, 'utf8')) as { python: string; owner: string };

const RIG = 'sentinel-prod';
const BEAD = 'sentinel-prod-9001';
const work = mkdtempSync(join(tmpdir(), 'close-facts-'));
const repo = join(work, 'repo');
const roots = join(work, 'roots');
const manifest = join(work, 'CONFIG.json');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
const commit = (file: string, subject: string) => {
  writeFileSync(join(repo, file), subject);
  git('add', file);
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
};

let finalSha = '';
let partialSha = '';
let offTargetSha = '';
const names = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];
const prior = names.map((name) => process.env[name]);

beforeAll(() => {
  mkdirSync(repo);
  mkdirSync(roots);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'close-facts@local');
  git('config', 'user.name', 'Close Facts');
  partialSha = commit('a.txt', `${BEAD} (partial): first piece`);
  finalSha = commit('b.txt', `${BEAD}: the closing commit`);
  git('checkout', '-q', '-b', 'side');
  offTargetSha = commit('c.txt', `${BEAD}: never merged`);
  git('checkout', '-q', 'main');
  writeFileSync(join(roots, 'report.md'), 'the report');
  writeFileSync(join(work, 'outside.md'), 'not under a root');
  writeFileSync(
    manifest,
    JSON.stringify({
      ...pins,
      close: {
        rigs: {
          [RIG]: {
            repos: { fixture: { repoRoot: repo, targetRef: 'main' } },
            artifactRoots: [roots],
          },
        },
      },
    }),
  );
  [pins.python, pins.owner, manifest].forEach((value, index) => {
    process.env[names[index]] = value;
  });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  names.forEach((name, index) => {
    if (prior[index] === undefined) delete process.env[name];
    else process.env[name] = prior[index];
  });
});

const fieldsFor = (request: CloseRequest | undefined, rigPrefix = RIG) =>
  closeOpFields({ rigPrefix, beadId: BEAD, request });
const HELD = { expectedEpoch: 1 };
const HOLDER = 'user-holder';
// A synthetic live claim by the closer, so the owner's claim rule passes and the close rule is
// the one under test. The gated update reads the real row.
const liveClaim = () => ({
  owner: HOLDER,
  epoch: 1,
  expires_at_ms: Date.now() + 60_000,
  now_ms: Date.now(),
  actor: HOLDER,
  expected_epoch: HELD.expectedEpoch,
});
// The op the gated update builds for a close, with the observed fields attached.
const judge = async (claim: CloseRequest | undefined) =>
  gateIssueWrite({
    rigId: 1,
    op: {
      op: 'close',
      id: BEAD,
      rig_prefix: RIG,
      claim_facts: liveClaim(),
      ...(await fieldsFor(claim)),
    },
  });
const refusalOf = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: Error) => error.message,
  );

describe('8429 G2 close fields from a close request', () => {
  it('leaves the facts null with no request, and the owner refuses the close', async () => {
    expect(await fieldsFor(undefined)).toEqual({ close_facts: null });
    expect(await refusalOf(judge(undefined))).toContain('close_facts');
  });

  it('allows a code close on a final commit that sits on the configured branch', async () => {
    const fields = await fieldsFor({
      ...HELD,
      kind: 'code',
      reason: 'landed',
      repo: 'fixture',
      sha: finalSha,
    });
    expect(fields).toMatchObject({
      configured_repo: repo,
      configured_branch: 'main',
      close_facts: {
        verified: true,
        bead_id: BEAD,
        sha: finalSha,
        changed_paths: ['b.txt'],
        subject: `${BEAD}: the closing commit`,
        commit_exists: true,
        on_target_branch: true,
      },
    });
    expect(
      await refusalOf(
        judge({ ...HELD, kind: 'code', reason: 'landed', repo: 'fixture', sha: finalSha }),
      ),
    ).toBe('allowed');
  });

  it('refuses a partial commit, a commit off the branch and an unknown commit', async () => {
    const partial = await refusalOf(
      judge({ ...HELD, kind: 'code', reason: 'landed', repo: 'fixture', sha: partialSha }),
    );
    expect(partial).toContain('partial marker');
    const side = await refusalOf(
      judge({ ...HELD, kind: 'code', reason: 'landed', repo: 'fixture', sha: offTargetSha }),
    );
    expect(side).toContain('on_target_branch');
    const unknown = await refusalOf(
      judge({ ...HELD, kind: 'code', reason: 'landed', repo: 'fixture', sha: 'a'.repeat(40) }),
    );
    expect(unknown).toContain('changed_paths');
  });

  it('refuses a code claim with no full commit id before the owner runs', async () => {
    const short = fieldsFor({
      ...HELD,
      kind: 'code',
      reason: 'landed',
      repo: 'fixture',
      sha: finalSha.slice(0, 12),
    });
    await expect(short).rejects.toMatchObject({ status: 409, code: 'invalid-config' });
  });

  it('allows a report and a cancel on a file inside the configured root', async () => {
    expect(
      await refusalOf(judge({ ...HELD, kind: 'report', reason: 'done', artifact: 'report.md' })),
    ).toBe('allowed');
    const cancel: CloseRequest = {
      ...HELD,
      kind: 'cancel',
      reason: 'dropped',
      artifact: 'report.md',
      disposition: 'superseded',
    };
    expect(await refusalOf(judge(cancel))).toBe('allowed');
  });

  it('refuses an artifact outside the root or missing', async () => {
    const outside = fieldsFor({
      ...HELD,
      kind: 'report',
      reason: 'done',
      artifact: '../outside.md',
    });
    await expect(outside).rejects.toMatchObject({ status: 409, code: 'artifact-outside-root' });
    const missing = fieldsFor({ ...HELD, kind: 'report', reason: 'done', artifact: 'none.md' });
    await expect(missing).rejects.toMatchObject({ status: 409, code: 'artifact-missing' });
  });

  it('refuses a repository key the manifest does not list, and an inherited key', async () => {
    for (const repo of ['elsewhere', 'toString', '']) {
      const unknown = fieldsFor({ ...HELD, kind: 'code', reason: 'landed', repo, sha: finalSha });
      await expect(unknown).rejects.toMatchObject({ status: 409, code: 'close-unconfigured' });
    }
    expect(await closeRepoFor(RIG, 'fixture')).toEqual({ repoRoot: repo, targetRef: 'main' });
    expect(await closeRepoFor(RIG, 'elsewhere')).toBeUndefined();
  });

  it('refuses a rig the manifest names no close repository for', async () => {
    const other = fieldsFor(
      { ...HELD, kind: 'code', reason: 'landed', repo: 'fixture', sha: finalSha },
      'other-rig',
    );
    await expect(other).rejects.toMatchObject({ status: 409, code: 'close-unconfigured' });
  });
});

// The claim half of a close: the facts claimFactsOf builds from a claim row and the authenticated
// closer, judged by the owner next to observed code facts. The row values are given here;
// readClaimFacts reads them from the locked issue row in the gated update.
describe('8429 G2 claim facts of a close', () => {
  const NOW = 1_800_000_000_000;
  const request: CloseRequest = {
    ...HELD,
    kind: 'code',
    reason: 'landed',
    repo: 'fixture',
    sha: '',
  };
  const held = { owner: HOLDER, epoch: 1, expiresAtMs: NOW + 60_000 };
  const closeWith = async (
    row: { owner: string | null; epoch: number; expiresAtMs: number | null },
    actorUserId: string | null = HOLDER,
    asked: CloseRequest = request,
  ) => {
    const op = {
      op: 'close',
      id: BEAD,
      rig_prefix: RIG,
      ...(await fieldsFor({ ...request, sha: finalSha })),
      claim_facts: claimFactsOf({ ...row, nowMs: NOW }, closerOf(actorUserId, asked)),
    };
    return refusalOf(gateIssueWrite({ rigId: 1, op }));
  };

  it('allows the close for the authenticated holder at the stored epoch', async () => {
    expect(await closeWith({ ...held, expiresAtMs: NOW + 1 })).toBe('allowed');
  });

  it('refuses an authenticated user that is not the holder, whatever the request says', async () => {
    expect(await closeWith(held, 'user-other')).not.toBe('allowed');
    // A request object that smuggles the stored owner in is still judged on the authenticated user.
    const forged = { ...request, claimActor: HOLDER, actor: HOLDER } as CloseRequest;
    expect(closerOf('user-other', forged)).toEqual({ actor: 'user-other', expectedEpoch: 1 });
    expect(await closeWith(held, 'user-other', forged)).not.toBe('allowed');
    expect(await closeWith(held, HOLDER, forged)).toBe('allowed');
  });

  it('refuses a close with no authenticated user before any claim is read', () => {
    for (const none of [null, ''])
      expect(() => closerOf(none, request)).toThrow('authenticated user');
  });

  it('judges the epoch the closer read against the stored one', async () => {
    expect(await closeWith({ ...held, epoch: 2 })).not.toBe('allowed');
    expect(await closeWith({ ...held, epoch: 2 }, HOLDER, { ...request, expectedEpoch: 2 })).toBe(
      'allowed',
    );
    expect(await closeWith(held, HOLDER, { ...request, expectedEpoch: 2 })).not.toBe('allowed');
  });

  it('refuses a lapsed claim and an unclaimed card', async () => {
    // The boundary is inclusive: a deadline equal to the clock has lapsed.
    expect(await closeWith({ ...held, expiresAtMs: NOW })).not.toBe('allowed');
    expect(
      await closeWith({ owner: null, epoch: 0, expiresAtMs: null }, HOLDER, {
        ...request,
        expectedEpoch: 0,
      }),
    ).not.toBe('allowed');
  });

  it('calls a closing write bare only when it sets nothing but the move', () => {
    const move = { columnId: 7, position: 1000, updatedAt: new Date() };
    expect(isBareClose(move)).toBe(true);
    expect(isBareClose({ columnId: 7 })).toBe(true);
    for (const extra of [{ title: 'x' }, { assigneeUserId: 'u' }, { description: '' }])
      expect(isBareClose({ ...move, ...extra })).toBe(false);
  });

  it('calls a close proven only with observed facts and a claim row', () => {
    const claim = claimFactsOf({ ...held, nowMs: NOW }, closerOf(HOLDER, request));
    expect(closeIsProven({ close_facts: { verified: true }, claim_facts: claim })).toBe(true);
    expect(closeIsProven({ close_facts: null, claim_facts: claim })).toBe(false);
    expect(closeIsProven({ close_facts: { verified: 'true' }, claim_facts: claim })).toBe(false);
    expect(closeIsProven({ close_facts: { verified: true } })).toBe(false);
    expect(closeIsProven({ claim_facts: claim })).toBe(false);
  });

  // The mutation pair for sentinel-prod-8429: drop the person from closeBackstopApplies and the first line fails.
  it("leaves a person's unproven close to the rule owner and refuses an agent's and a system's", () => {
    const claim = claimFactsOf({ ...held, nowMs: NOW }, closerOf(HOLDER, request));
    const unproven = { close_facts: null, claim_facts: claim };
    const proven = { close_facts: { verified: true }, claim_facts: claim };
    // WHY (Misty 2026-11-15): "i guarantee you EVERY block will block me too". The writer's own backstop is the tracker refusing a
    // signed-in person on her own card before any rule owner speaks, so it does not apply to her. Every agent and system close is
    // refused on the same closeIsProven fact in the same words as before this change.
    expect(closeBackstopApplies(unproven, 'human')).toBe(false);
    expect(closeBackstopApplies(unproven, 'agent')).toBe(true);
    expect(closeBackstopApplies(unproven, 'system')).toBe(true);
    expect(closeBackstopApplies(proven, 'human')).toBe(false);
    expect(closeBackstopApplies(proven, 'agent')).toBe(false);
    expect(closeBackstopApplies(proven, 'system')).toBe(false);
  });
});
