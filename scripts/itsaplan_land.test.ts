// scripts/itsaplan_land.test.ts — sentinel-prod-8429 native auto-lander CLI: the thin layer over the five landed
// units, proven against those units' own accepted fixtures.
//
// WHY the fixtures are borrowed: units 3, 4 and 5 already carry scratch-repository and fake harnesses Root
// reviewed, and a CLI test that builds its own would drift from the units it claims to compose. WHAT is not
// proven: the production RecordStorage. The real adapter lives in apps/api and cannot be imported from scripts/,
// so every storage here is a test double reached through the one adapter seam.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  cleanupPublishFixtures,
  fakeProofs,
  fakeSlot,
  KEY,
  publishFixture,
  recordingGit,
} from './landing-publish.test-fixtures';
import { cleanupFixtures } from './landing-git.test-fixtures';
import type { GitRunner } from './landing-git';
import * as land from './itsaplan_land';
import {
  answering,
  CLOSER,
  HELD,
  jobFor,
  pass,
  receipt,
  rig,
  TESTS,
  type Args,
  type Deps,
  type Fields,
} from './itsaplan_land.test-fixtures';

afterEach(() => {
  cleanupPublishFixtures();
  cleanupFixtures();
});

describe('the job is data, so it is checked before any unit is asked', () => {
  const jobRefusal = (raw: string) => (land.parseJob(raw) as { report: land.LandReport }).report;

  it('refuses a job file that is not json, and one that is json but not an object', () => {
    expect(jobRefusal('not json').code).toBe('JOB_MALFORMED');
    expect(jobRefusal('[1,2]').code).toBe('JOB_MALFORMED');
  });
  it('names every field it needed, so the operator fixes one file in one pass', () => {
    const reason = jobRefusal(JSON.stringify({ repo: '/tmp/x', receipts: [] })).reason;
    const needed = 'targetRef repoIdentity remote expectedPushURL itemKey closeRepoKey columns';
    for (const name of needed.split(' ')) expect(reason).toInclude(name);
  });
  it('refuses a columnId that is neither a number nor null', () => {
    const job = { ...jobFor(publishFixture()), columnId: '11' };
    expect(jobRefusal(JSON.stringify(job)).code).toBe('JOB_FIELDS_MISSING');
  });
});

describe('plan asks the landed units the two eligibility questions, in unit 4 order', () => {
  it('plans a full candidate eligible, with the subject read from git', () => {
    const f = publishFixture();
    const report = land.planJob(jobFor(f), f.git);
    expect([report.ok, report.partial, report.stage]).toEqual([true, false, 'plan']);
    expect(land.reportText(report)).toInclude('eligible as a full landing');
  });
  it('refuses the author reviewing their own work', () => {
    const f = publishFixture();
    const job = jobFor(f, { verdicts: [pass(f, { reviewer: 'dsh' })] });
    const report = land.planJob(job, f.git);
    expect(report.ok).toBe(false);
    expect(report.reason).toInclude('NOT_INDEPENDENT_REVIEWER');
  });
  it('refuses a verdict that is not a pass, and a receipt whose sha is not the full 40', () => {
    const f = publishFixture();
    const returned = jobFor(f, { verdicts: [pass(f, { decision: 'RETURN' })] });
    expect(land.planJob(returned, f.git).reason).toInclude('VERDICT_NOT_PASS');
    const cut = jobFor(f, { receipts: [receipt(f, { candidateSha: f.candidate.slice(0, 8) })] });
    const short = land.planJob(cut, f.git);
    expect([short.ok, short.stage]).toEqual([false, 'plan']);
    expect(short.reason).toInclude('SHA_INVALID');
  });
  it('plans a (partial) subject as partial', () => {
    const f = publishFixture({ partial: true });
    const report = land.planJob(jobFor(f), f.git);
    expect([report.ok, report.partial]).toEqual([true, true]);
    expect(land.reportText(report)).toInclude('partial landing');
  });
  it('refuses a candidate that touches a protected surface, and a target named by a short ref', () => {
    const f = publishFixture();
    const protectedRun = land.planJob(jobFor(f, { excludedPathPatterns: ['scripts/'] }), f.git);
    expect(protectedRun.reason).toInclude('EXCLUDED_PATH');
    const shortRef = land.planJob(jobFor(f, { targetRef: 'main' }), f.git);
    expect(shortRef.reason).toInclude('POLICY_INVALID');
  });
});

describe('the adapter seam refuses by name, because a half-supplied adapter is not a capability', () => {
  const codeOf = (resolved: Awaited<ReturnType<typeof land.resolveAdapter>>) =>
    resolved.ok ? 'RESOLVED' : resolved.report.code;
  const cases: Array<[string, Fields, string]> = [
    ['no storage factory', { nativeRecordStorage: undefined }, 'ADAPTER_STORAGE_FACTORY_MISSING'],
    ['no database client', { landingDbClient: undefined }, 'ADAPTER_CLIENT_MISSING'],
    ['no slot driver', { landingSlotDriver: undefined }, 'ADAPTER_SLOT_MISSING'],
    ['no proof runner', { landingProofRunner: undefined }, 'ADAPTER_PROOF_MISSING'],
    ['no trusted closer', { landingCloserUserId: ' ' }, 'ADAPTER_CLOSER_MISSING'],
  ];

  for (const [label, over, code] of cases) {
    it(`refuses ${label} with its own code and never partly uses the adapter`, async () => {
      const f = publishFixture();
      const { deps, calls } = rig(f, {}, over);
      expect(codeOf(await land.resolveAdapter(jobFor(f), deps.loadAdapter))).toBe(code);
      expect(calls.factoryOptions).toEqual([]);
    });
  }
  it('refuses a module path that cannot be loaded, the honest answer today', async () => {
    const resolved = await land.resolveAdapter(jobFor(publishFixture()), async () => {
      throw new Error('cannot import drizzle-orm from this workspace');
    });
    expect(codeOf(resolved)).toBe('ADAPTER_MODULE_MISSING');
  });
  it('calls the storage factory with the frozen options, and the closer is the adapter user', async () => {
    const f = publishFixture();
    const { deps, calls } = rig(f);
    expect((await land.landJob(jobFor(f), deps)).ok).toBe(true);
    expect(calls.factoryOptions.length).toBe(1);
    const [options] = calls.factoryOptions;
    const names = ['client', 'closeRepoKey', 'closerUserId', 'completedColumnId'];
    expect(Object.keys(options).sort()).toEqual(names);
    // The job's actorName is qwen2: it is never the closer.
    expect([options.closeRepoKey, options.closerUserId]).toEqual(['tracker', CLOSER]);
    expect(options.completedColumnId).toBe(12);
  });
});

describe('land composes the five landed units and stops at the first refusal', () => {
  it('publishes, records and completes a full landing once', async () => {
    const f = publishFixture();
    const slot = fakeSlot();
    const { deps, storage } = rig(f, HELD, { landingSlotDriver: slot.driver });
    const report = await land.landJob(jobFor(f), deps);
    expect([report.ok, report.completed, report.partial]).toEqual([true, true, false]);
    expect(report.publish?.remoteSha).toBe(f.candidate);
    expect([f.targetRef(), f.remoteTarget()]).toEqual([f.candidate, f.candidate]);
    expect(storage.rows.map((row) => row.kind)).toEqual(['landing_full']);
    expect([slot.connects, slot.ends]).toEqual([1, 1]);
  });
  it('publishes and records a partial landing without completing or moving the item', async () => {
    const f = publishFixture({ partial: true });
    const { deps, storage } = rig(f);
    const report = await land.landJob(jobFor(f), deps);
    expect([report.ok, report.completed, report.partial]).toEqual([true, false, true]);
    expect(storage.rows.map((row) => row.kind)).toEqual(['landing_partial']);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });
  it('refuses a busy slot before the storage factory is ever called', async () => {
    const f = publishFixture();
    const { deps, calls } = rig(f, {}, { landingSlotDriver: fakeSlot({ held: false }).driver });
    const report = await land.landJob(jobFor(f), deps);
    expect([report.ok, report.stage]).toEqual([false, 'publish']);
    expect(report.reason).toInclude('SLOT_BUSY');
    expect(calls.factoryOptions).toEqual([]);
    expect(f.targetRef()).toBe(f.base);
  });
  it('refuses a proof run that reports a failed suite, and the target ref never moves', async () => {
    const f = publishFixture();
    const outcomes = [{ name: 'suite one', passed: 2, failed: 1 }];
    const failing = fakeProofs({ candidateSha: f.candidate, namedTests: TESTS, outcomes });
    const { deps, calls } = rig(f, {}, { landingProofRunner: failing });
    const report = await land.landJob(jobFor(f), deps);
    expect(report.reason).toInclude('PROOF_FAILED');
    expect(calls.factoryOptions).toEqual([]);
    expect(f.targetRef()).toBe(f.base);
  });
  it('reports a record-stage failure beside the publication it made', async () => {
    const f = publishFixture();
    const { deps } = rig(f, { ...HELD, failAt: 'move' });
    const report = await land.landJob(jobFor(f), deps);
    expect([report.ok, report.stage]).toEqual([false, 'record']);
    expect(report.reason).toInclude('STORAGE_FAILED');
    expect(report.publish?.published).toBe(true);
    expect(report.record?.recorded).toBe(false);
  });
  it('refuses a configured completed column that does not exist, and records nothing', async () => {
    const f = publishFixture();
    const { deps, storage } = rig(f);
    const report = await land.landJob(jobFor(f, { completedColumnId: 99 }), deps);
    expect([report.ok, report.stage]).toEqual([false, 'record']);
    expect(report.reason).toInclude('COLUMN_MISSING');
    expect(storage.rows).toEqual([]);
  });
});

describe('record retries unit 5 for a landing that published and then failed to record', () => {
  const moves = (git: { calls: string[][] }) =>
    git.calls.filter((args) => args[0] === 'push' || args[0] === 'update-ref');

  it('records once on the retry, pushes nothing, and a repeated retry writes nothing again', async () => {
    const f = publishFixture();
    const r = rig(f, { ...HELD, failAt: 'move' });
    const first = await land.landJob(jobFor(f), r.deps);
    expect([first.stage, first.publish?.published]).toEqual(['record', true]);
    expect([r.storage.rows.length, r.storage.items.get(KEY)?.columnId]).toEqual([0, 11]);
    // The reason the retry exists: the plan now stops every later land before unit 5.
    expect((await land.landJob(jobFor(f), r.deps)).reason).toInclude('ALREADY_LANDED');

    r.storage.failAt = undefined;
    const git = recordingGit(f.git);
    const deps = { ...r.deps, runnerFor: () => git };
    const retry = await land.recordJob(jobFor(f), deps);
    expect([retry.ok, retry.completed, retry.record?.replayed]).toEqual([true, true, false]);
    expect(retry.publish?.remoteSha).toBe(f.candidate);
    expect(r.storage.rows.map((row) => row.kind)).toEqual(['landing_full']);
    expect(r.storage.items.get(KEY)?.columnId).toBe(12);
    expect(r.calls.factoryOptions.at(-1)).toMatchObject({ closerUserId: CLOSER });

    expect(await land.runCommand(['record', 'job.json'], deps)).toBe(0);
    expect(r.out.join('')).toInclude('replayed: true');
    expect([r.storage.rows.length, r.storage.cleanups.length]).toEqual([1, 1]);
    expect(moves(git)).toEqual([]);
    expect([f.targetRef(), f.remoteTarget()]).toEqual([f.candidate, f.candidate]);
  });
  it('retries a partial landing as partial: recorded once, and the item keeps its column', async () => {
    const f = publishFixture({ partial: true });
    const r = rig(f, { ...HELD, failAt: 'append' });
    expect((await land.landJob(jobFor(f), r.deps)).reason).toInclude('STORAGE_FAILED');
    r.storage.failAt = undefined;
    const retry = await land.recordJob(jobFor(f), r.deps);
    expect([retry.ok, retry.completed, retry.partial]).toEqual([true, false, true]);
    const again = await land.recordJob(jobFor(f), r.deps);
    expect([again.ok, again.record?.replayed]).toEqual([true, true]);
    expect(r.storage.rows.map((row) => row.kind)).toEqual(['landing_partial']);
    expect([r.storage.items.get(KEY)?.columnId, r.storage.cleanups.length]).toEqual([11, 0]);
  });
  it('refuses a candidate that never published, and a job whose push URL is not the remote', async () => {
    const f = publishFixture();
    const r = rig(f);
    const unpublished = await land.recordJob(jobFor(f), r.deps);
    expect([unpublished.ok, unpublished.code]).toEqual([false, 'RETRY_REFUSED']);
    expect(unpublished.reason).toInclude('not a landed candidate: STALE_TARGET');
    expect((await land.landJob(jobFor(f), r.deps)).ok).toBe(true);
    const elsewhere = jobFor(f, { expectedPushURL: `${f.remotePath}-mirror` });
    expect((await land.recordJob(elsewhere, r.deps)).reason).toInclude('configured URL');
    expect(r.calls.factoryOptions.length).toBe(1);
  });
  it('refuses when the remote or the local target no longer holds the candidate', async () => {
    const f = publishFixture();
    const r = rig(f, { ...HELD, failAt: 'move' });
    await land.landJob(jobFor(f), r.deps);
    r.storage.failAt = undefined;
    const retryOn = (git: GitRunner, job = jobFor(f)) =>
      land.recordJob(job, { ...r.deps, runnerFor: () => git });
    const listed = `${f.base}\trefs/heads/main\n`;
    const remote = await retryOn(answering(f.git, (args) => args[0] === 'ls-remote', listed));
    expect([remote.code, remote.stage]).toEqual(['RETRY_REFUSED', 'publish']);
    expect(remote.reason).toInclude(`reports ${f.base}, not candidate ${f.candidate}`);
    // Unit 3 resolves the target once; the second read of it is the retry's own, answered as a moved ref.
    let reads = 0;
    const second = (args: Args) => args.at(-1) === 'refs/heads/main^{commit}' && ++reads === 2;
    const local = await retryOn(answering(f.git, second, `${f.base}\n`));
    expect(local.reason).toInclude(`refs/heads/main is ${f.base}, not candidate`);
    const other = jobFor(f, { receipts: [receipt(f, { candidateSha: 'c'.repeat(40) })] });
    expect((await retryOn(f.git, other)).reason).toInclude('CANDIDATE_MISSING');
    expect([r.storage.rows.length, r.calls.factoryOptions.length]).toEqual([0, 1]);
  });
  // WHY these cases publish by hand: land refuses each of these candidates, so only a publish made outside
  // the lander can put one at the tip. The retry must then refuse it on unit 3's own checks.
  it('refuses a published exact tip that fails a unit 3 check, before the storage factory', async () => {
    const trailer = `${KEY}: a signed change\n\nCo-Authored-By: Someone <someone@example.com>`;
    // The scratch repository keeps every file it was given, so each commit on the base changes scripts/a.ts
    // and scripts/b.ts as well as its own path.
    const both = ['scripts/a.ts', 'scripts/b.ts'];
    const cases: Array<[string, string, string[], string]> = [
      ['scripts/a.ts', `${KEY}: two files`, ['scripts/a.ts'], 'not declared: scripts/b.ts'],
      ['scripts/a.ts', `${KEY}: one more`, [...both, 'scripts/z.ts'], 'unchanged: scripts/z.ts'],
      ['Legal/form.ts', `${KEY}: a legal form`, [...both, 'Legal/form.ts'], 'EXCLUDED_PATH'],
      ['scripts/a.ts', 'a subject with no item key', both, 'SUBJECT_INVALID'],
      ['scripts/a.ts', trailer, both, 'AUTHORSHIP_TRAILER'],
    ];
    for (const [path, message, allowedPaths, expected] of cases) {
      const f = publishFixture();
      const r = rig(f);
      const candidate = f.fixture.commit(path, `content of ${expected}`, message, [f.base]);
      f.setTarget(candidate);
      expect(f.git.run(['push', f.remote, `${candidate}:refs/heads/main`]).status).toBe(0);
      const evidence = {
        receipts: [receipt(f, { candidateSha: candidate, allowedPaths })],
        verdicts: [pass(f, { sha: candidate })],
      };
      const retry = await land.recordJob(jobFor(f, evidence), r.deps);
      expect([expected, retry.ok, retry.code]).toEqual([expected, false, 'RETRY_REFUSED']);
      expect(retry.reason).toInclude(expected);
      expect([r.calls.factoryOptions.length, r.storage.rows.length]).toEqual([0, 0]);
      expect([f.targetRef(), f.remoteTarget()]).toEqual([candidate, candidate]);
    }
  });
  it('refuses a candidate the target has moved past, as land does', async () => {
    const f = publishFixture();
    const r = rig(f);
    const later = f.fixture.commit('scripts/c.ts', 'later', `${KEY}: a later landing`, [
      f.candidate,
    ]);
    f.setTarget(later);
    const retry = await land.recordJob(jobFor(f), r.deps);
    expect([retry.code, r.calls.factoryOptions.length]).toEqual(['RETRY_REFUSED', 0]);
    expect(retry.reason).toInclude('ALREADY_LANDED');
  });
});

describe('the shipped CLI answers in exit codes an operator can script against', () => {
  it('exits 2 for an unknown command and for a missing job file', async () => {
    const f = publishFixture();
    expect(land.parseCommand(['nope', 'x.json']).command).toBe(null);
    expect(await land.runCommand(['nope', 'x.json'], rig(f).deps)).toBe(2);
    const noJob = rig(f);
    expect(await land.runCommand(['plan'], noJob.deps)).toBe(2);
    expect(noJob.err.join('')).toInclude('no job file was named');
  });
  it('exits 1 with the refusal named, and 0 with the outcome', async () => {
    const f = publishFixture();
    expect(await land.runCommand(['plan', 'job.json'], rig(f).deps)).toBe(0);
    const selfReview = JSON.stringify(jobFor(f, { verdicts: [pass(f, { reviewer: 'dsh' })] }));
    const broken = rig(f, HELD, {}, { readFile: () => selfReview });
    expect(await land.runCommand(['plan', 'job.json'], broken.deps)).toBe(1);
    expect(broken.err.join('')).toInclude('NOT_INDEPENDENT_REVIEWER');
  });
  it('reads the adapter through the real dynamic-import seam from a file on disk', async () => {
    const f = publishFixture();
    const scratch = mkdtempSync(join(process.cwd(), '.8429-land-adapter-'));
    try {
      const fixtures = join(import.meta.dir, 'landing-record.test-fixtures.ts');
      const slotFixtures = join(import.meta.dir, 'landing-publish.test-fixtures.ts');
      const adapterPath = join(scratch, 'adapter.ts');
      writeFileSync(
        adapterPath,
        [
          // A test double for the production adapter, written to disk only to prove the CLI's real load path.
          `import { fakeStorage } from '${fixtures}';`,
          `import { fakeSlot, fakeProofs } from '${slotFixtures}';`,
          `export const nativeRecordStorage = () => fakeStorage({ items: { '${KEY}': { columnId: 11 } } });`,
          `export const landingDbClient = { transaction: async (fn) => fn({}) };`,
          `export const landingSlotDriver = fakeSlot().driver;`,
          `export const landingProofRunner = fakeProofs({ candidateSha: '${f.candidate}', namedTests: ['suite one'] });`,
          `export const landingCloserUserId = '${CLOSER}';`,
          '',
        ].join('\n'),
      );
      const jobPath = join(scratch, 'job.json');
      writeFileSync(jobPath, JSON.stringify(jobFor(f, { adapterModule: adapterPath })));
      const onDisk: Deps = {
        readFile: () => readFileSync(jobPath, 'utf8'),
        loadAdapter: async (path) => (await import(path)) as Fields,
      };
      const { deps, out } = rig(f, HELD, {}, onDisk);
      expect(await land.runCommand(['land', jobPath], deps)).toBe(0);
      expect(out.join('')).toInclude('published and recorded: the item is complete');
      expect(f.targetRef()).toBe(f.candidate);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it('reports a landing in one block an operator can read', async () => {
    const f = publishFixture();
    const { deps, out } = rig(f);
    expect(await land.runCommand(['land', 'job.json'], deps)).toBe(0);
    for (const text of ['OK at record', 'completed: true', f.candidate])
      expect(out.join('')).toInclude(text);
  });
  it('spawns the real CLI with a bad command and leaves nothing behind', () => {
    const cli = join(import.meta.dir, 'itsaplan_land.ts');
    const result = spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toInclude('usage');
  });
});
