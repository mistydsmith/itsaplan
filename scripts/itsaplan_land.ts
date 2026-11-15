// scripts/itsaplan_land.ts — sentinel-prod-8429 native auto-lander CLI: the operator entry point over the five
// landed units. Units 1 to 5 own every decision; this file reads a job, asks the units, and reports the answers.
//
// WHY it refuses instead of supplying a storage: the production RecordStorage is nativeRecordStorage in
// apps/api/src/modules/issues/landing-record-storage.ts. Only apps/api can import drizzle-orm and the '#shared/*'
// aliases, so nothing in scripts/ can import it. This CLI names the owners it needs and refuses with its own code
// when one is absent: an injected adapter is a proof seam, not a shipped capability, and no second one is authored.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { evaluateBundle, parseReceipt, type ItemState } from './landing-evidence';
import { evaluateGitEligibility, execRunner, type GitPolicy, type GitRunner } from './landing-git';
import { publishLanding, type ProofRunner, type PublishResult } from './landing-publish';
import {
  recordLanding,
  type ColumnDescriptor,
  type RecordResult,
  type RecordStorage,
} from './landing-record';
import type { SlotDriver } from './landing-slot';

export type LandCommand = 'plan' | 'land' | 'record';
const LAND_COMMANDS: readonly LandCommand[] = ['plan', 'land', 'record'];

export interface LandingJob {
  /** An absolute path, never a short name; the identity the landing slot is keyed on separately. */
  repo: string;
  /** Exact ref, e.g. refs/heads/main. Unit 3 refuses a short name rather than resolve it. */
  targetRef: string;
  excludedPathPatterns: string[];
  repoIdentity: string;
  remote: string;
  expectedPushURL: string;
  itemKey: string;
  projectId: number;
  /** Informational: unit 5 re-reads the item's column under the lock. */
  columnId: number | null;
  status?: string;
  archived?: boolean;
  receipts: unknown[];
  verdicts: unknown[];
  /** Explicit, never inferred: the column a FULL landing completes into. */
  completedColumnId: number;
  columns: ColumnDescriptor[];
  actorName: string;
  /** The manifest key of the repo this landing closes against. The adapter refuses a key the manifest lacks. */
  closeRepoKey: string;
  /** Module that supplies the injected owners checked in resolveAdapter. */
  adapterModule: string;
}

export type CliCode =
  | 'JOB_PATH_MISSING'
  | 'JOB_UNREADABLE'
  | 'JOB_MALFORMED'
  | 'JOB_FIELDS_MISSING'
  | 'PLAN_GIT_REFUSED'
  | 'PLAN_EVIDENCE_REFUSED'
  | 'ADAPTER_MODULE_MISSING'
  | 'ADAPTER_STORAGE_FACTORY_MISSING'
  | 'ADAPTER_CLIENT_MISSING'
  | 'ADAPTER_SLOT_MISSING'
  | 'ADAPTER_PROOF_MISSING'
  | 'ADAPTER_CLOSER_MISSING'
  | 'PUBLISH_REFUSED'
  | 'RETRY_REFUSED'
  | 'RECORD_REFUSED';

export interface LandReport {
  ok: boolean;
  stage: 'job' | 'plan' | 'adapter' | 'publish' | 'record';
  code?: CliCode;
  reason: string;
  /** Carried from the reviewed subject: a partial landing never completes the item. */
  partial?: boolean;
  completed?: boolean;
  publish?: PublishResult;
  record?: RecordResult;
}

export interface AdapterOwners {
  nativeRecordStorage: (options: {
    completedColumnId: number;
    closeRepoKey: string;
    closerUserId: string;
    client?: unknown;
  }) => RecordStorage;
  landingDbClient: unknown;
  landingSlotDriver: SlotDriver;
  landingProofRunner: ProofRunner;
  // WHY an adapter owner and not a job field: the closer is the trusted native executor's user id, resolved where
  // the session is held. A job's actorName or a claim owner passed as the closer would be impersonation.
  landingCloserUserId: string;
}

export interface LandDeps {
  readFile: (path: string) => string;
  // The one seam that can reach another workspace, and unit 3's runner: both are injected so a proof never
  // pretends the adapter exists and both let a test answer about a scratch repository instead of the real one.
  loadAdapter: (modulePath: string) => Promise<Record<string, unknown>>;
  runnerFor: (repo: string) => GitRunner;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

const REQUIRED_STRINGS =
  'repo targetRef repoIdentity remote expectedPushURL itemKey actorName closeRepoKey adapterModule';
const REQUIRED_ARRAYS = ['excludedPathPatterns', 'receipts', 'verdicts', 'columns'] as const;
const REQUIRED_NUMBERS = ['projectId', 'completedColumnId'] as const;

function refusal(
  stage: LandReport['stage'],
  code: CliCode,
  reason: string,
  extra: Partial<LandReport> = {},
): LandReport {
  return { ok: false, stage, code, reason, ...extra };
}

/** The job is data, so every field is checked before a unit is asked anything about it. */
export function parseJob(
  raw: string,
): { ok: true; job: LandingJob } | { ok: false; report: LandReport } {
  const bad = (code: CliCode, reason: string) =>
    ({ ok: false, report: refusal('job', code, reason) }) as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad('JOB_MALFORMED', 'the job file is not json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return bad('JOB_MALFORMED', 'the job file must hold one json object');
  const job = parsed as Record<string, unknown>;
  const absent: string[] = [];
  for (const key of REQUIRED_STRINGS.split(' '))
    if (typeof job[key] !== 'string' || job[key] === '') absent.push(key);
  for (const key of REQUIRED_ARRAYS) if (!Array.isArray(job[key])) absent.push(key);
  for (const key of REQUIRED_NUMBERS)
    if (typeof job[key] !== 'number' || !Number.isInteger(job[key])) absent.push(key);
  if (job.columnId !== null && typeof job.columnId !== 'number') absent.push('columnId');
  if (absent.length > 0)
    return bad('JOB_FIELDS_MISSING', `the job is missing or mis-types: ${absent.join(', ')}`);
  return { ok: true, job: job as unknown as LandingJob };
}

export function policyOf(job: LandingJob): GitPolicy {
  const { repo, targetRef, excludedPathPatterns } = job;
  return { repo, targetRef, excludedPathPatterns };
}

export function itemStateOf(job: LandingJob): ItemState {
  const state: ItemState = { itemKey: job.itemKey };
  if (job.status !== undefined) state.status = job.status;
  if (job.archived !== undefined) state.archived = job.archived;
  return state;
}

// The two eligibility questions the landed units already answer, in unit 4's order: Git first, so the subject the
// record is judged against is the one Git holds, then the evidence bundle against that subject.
export function planJob(job: LandingJob, runner: GitRunner): LandReport {
  // Unit 1's parser first: unit 3 takes a typed receipt, and a job file is not a type. A receipt that will not
  // parse is refused here rather than reaching a unit that would have to guess what it meant to be.
  const parsedReceipt = parseReceipt(job.receipts[0]);
  if (typeof parsedReceipt === 'string')
    return refusal('plan', 'PLAN_EVIDENCE_REFUSED', `${parsedReceipt}: the receipt is not valid`);
  const git = evaluateGitEligibility(policyOf(job), parsedReceipt, runner);
  if (!git.eligible) return refusal('plan', 'PLAN_GIT_REFUSED', `${git.code}: ${git.reason}`);
  const subject = git.facts?.subject ?? '';
  const evidence = evaluateBundle(itemStateOf(job), subject, job.receipts, job.verdicts);
  if (!evidence.eligible) {
    const why = `${evidence.code}: ${evidence.reason}`;
    return refusal('plan', 'PLAN_EVIDENCE_REFUSED', why, { partial: evidence.partial });
  }
  const reason = evidence.partial
    ? 'eligible as a partial landing: the item keeps its column'
    : 'eligible as a full landing';
  return { ok: true, stage: 'plan', reason, partial: evidence.partial };
}

// The frozen contract, checked owner by owner so a half-written adapter cannot read as a capability: no client
// means no transaction, no driver means no slot, no proof runner means tests claimed and not run.
const method = (name: string) => (v: unknown) =>
  typeof (v as Record<string, unknown> | null)?.[name] === 'function';
const named = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const ADAPTER_OWNERS: Array<[keyof AdapterOwners, CliCode, (value: unknown) => boolean]> = [
  ['nativeRecordStorage', 'ADAPTER_STORAGE_FACTORY_MISSING', (v) => typeof v === 'function'],
  ['landingDbClient', 'ADAPTER_CLIENT_MISSING', (v) => typeof v === 'object' && v !== null],
  ['landingSlotDriver', 'ADAPTER_SLOT_MISSING', method('connect')],
  ['landingProofRunner', 'ADAPTER_PROOF_MISSING', method('run')],
  ['landingCloserUserId', 'ADAPTER_CLOSER_MISSING', named],
];

export async function resolveAdapter(
  job: LandingJob,
  loadAdapter: LandDeps['loadAdapter'],
): Promise<{ ok: true; owners: AdapterOwners } | { ok: false; report: LandReport }> {
  let module: Record<string, unknown>;
  try {
    module = await loadAdapter(job.adapterModule);
  } catch {
    const why = `the adapter module could not be loaded: ${job.adapterModule}`;
    return { ok: false, report: refusal('adapter', 'ADAPTER_MODULE_MISSING', why) };
  }
  for (const [name, code, test] of ADAPTER_OWNERS) {
    if (test(module[name])) continue;
    const why = `the adapter exports no usable ${name}, so nothing can record a landing`;
    return { ok: false, report: refusal('adapter', code, why) };
  }
  return { ok: true, owners: module as unknown as AdapterOwners };
}

// The publication facts for a record retry, read from the configured repository and remote. No job field says
// "published", and every command here is a read. WHY unit 3 judges the retry in its published-exact-tip mode
// (Root 2026-11-15 msg_44a6c904c749): its subject, declared path, excluded path and authorship checks come after
// the already-landed answer, so a retry that accepted that answer skipped them. The mode lifts only the
// already-landed and stale-target refusals, and only while the target is exactly the candidate. WHY the target and
// the remote must both equal the candidate: a ref that moved on is no longer the reviewed landing, and recording
// it would describe a state nobody proved.
export function readPublication(job: LandingJob, runner: GitRunner): PublishResult | LandReport {
  const stop = (reason: string) => refusal('publish', 'RETRY_REFUSED', reason);
  const receipt = parseReceipt(job.receipts[0]);
  if (typeof receipt === 'string') return stop(`${receipt}: the receipt is not valid`);
  const { candidateSha } = receipt;
  const landed = evaluateGitEligibility(policyOf(job), receipt, runner, 'published-exact-tip');
  if (!landed.eligible || !landed.facts)
    return stop(`not a landed candidate: ${landed.code ?? 'NO_FACTS'}: ${landed.reason}`);
  const read = (...args: string[]): string | null => {
    const out = runner.run(args);
    return out.status === 0 ? out.stdout : null;
  };
  const lines = (text: string | null) => (text ?? '').split('\n').map((line) => line.trim());
  const targetSha = read('rev-parse', '--verify', '--quiet', `${job.targetRef}^{commit}`)?.trim();
  if (targetSha !== candidateSha)
    return stop(`${job.targetRef} is ${targetSha ?? 'unreadable'}, not candidate ${candidateSha}`);
  const urls = lines(read('remote', 'get-url', '--push', '--all', job.remote)).filter(Boolean);
  if (urls.length === 0 || urls.some((url) => url !== job.expectedPushURL.trim()))
    return stop(`${job.remote} does not push only to the configured URL`);
  const remoteSha = lines(read('ls-remote', job.remote, job.targetRef))
    .map((line) => line.split(/\s+/))
    .find((fields) => fields[1] === job.targetRef)?.[0];
  if (remoteSha !== candidateSha)
    return stop(`${job.remote} reports ${remoteSha ?? 'no ref'}, not candidate ${candidateSha}`);
  // The subject and the changed paths are the ones unit 3 just judged, never a second read of them.
  const { subject } = landed.facts;
  const evidence = evaluateBundle(itemStateOf(job), subject, job.receipts, job.verdicts);
  return {
    published: true,
    landed: true,
    partial: evidence.partial,
    reason: `read back ${candidateSha} at ${job.targetRef} locally and on ${job.remote}`,
    candidateSha,
    targetRef: job.targetRef,
    remoteSha,
    evidence,
    git: landed,
  };
}

/** Unit 5 on a publication, for land and for the retry alike. Unit 5 owns the replay: one record per candidate. */
async function recordPublished(job: LandingJob, owners: AdapterOwners, publish: PublishResult) {
  const { receipts, verdicts, completedColumnId, columns, actorName } = job;
  const storage = owners.nativeRecordStorage({
    completedColumnId,
    closeRepoKey: job.closeRepoKey,
    closerUserId: owners.landingCloserUserId,
    client: owners.landingDbClient,
  });
  const item = { ...itemStateOf(job), projectId: job.projectId, columnId: job.columnId };
  const reviewed = { receipts, verdicts, completedColumnId, columns, actorName };
  const record = await recordLanding({ publication: publish, item, storage, ...reviewed });
  const extra = { partial: record.partial, publish, record };
  if (!record.recorded)
    return refusal('record', 'RECORD_REFUSED', `${record.code}: ${record.reason}`, extra);
  const reason = record.completed
    ? 'published and recorded: the item is complete'
    : 'published and recorded as partial: the item is not complete';
  const done: LandReport = { ok: true, stage: 'record', reason, completed: record.completed };
  return { ...done, ...extra };
}

// The retry for a landing that published and then failed to record. WHY its own command: after the publish, plan
// answers ALREADY_LANDED, so land can never reach unit 5 again. This reads the publication back and records it.
export async function recordJob(job: LandingJob, deps: LandDeps): Promise<LandReport> {
  const publish = readPublication(job, deps.runnerFor(job.repo));
  if ('stage' in publish) return publish;
  const adapter = await resolveAdapter(job, deps.loadAdapter);
  if (!adapter.ok) return adapter.report;
  return recordPublished(job, adapter.owners, publish);
}

// plan, then the injected owners, then unit 4, then unit 5. Each stage stops at its own refusal and nothing after
// it is attempted: an unpublished candidate is never recorded, and an adapter missing one owner is never used.
export async function landJob(job: LandingJob, deps: LandDeps): Promise<LandReport> {
  const runner = deps.runnerFor(job.repo);
  const planned = planJob(job, runner);
  if (!planned.ok) return planned;

  const adapter = await resolveAdapter(job, deps.loadAdapter);
  if (!adapter.ok) return adapter.report;

  const publish = await publishLanding(
    {
      publication: {
        policy: policyOf(job),
        repoIdentity: job.repoIdentity,
        remote: job.remote,
        expectedPushURL: job.expectedPushURL,
      },
      item: itemStateOf(job),
      receipts: job.receipts,
      verdicts: job.verdicts,
      slotDriver: adapter.owners.landingSlotDriver,
      proofRunner: adapter.owners.landingProofRunner,
    },
    runner,
  );
  if (!publish.published) {
    const reason = `${publish.code}: ${publish.reason}`;
    return refusal('publish', 'PUBLISH_REFUSED', reason, { partial: publish.partial, publish });
  }

  return recordPublished(job, adapter.owners, publish);
}

/** One block an operator can read, and one that a script can grep. */
export function reportText(report: LandReport): string {
  const lines = [`${report.ok ? 'OK' : 'REFUSED'} at ${report.stage}: ${report.reason}`];
  if (report.partial !== undefined) lines.push(`  partial: ${report.partial}`);
  if (report.completed !== undefined) lines.push(`  completed: ${report.completed}`);
  if (report.publish?.candidateSha) lines.push(`  candidate: ${report.publish.candidateSha}`);
  if (report.publish?.remoteSha) lines.push(`  remote: ${report.publish.remoteSha}`);
  if (report.record?.activityId) lines.push(`  activity: ${report.record.activityId}`);
  if (report.record?.replayed) lines.push('  replayed: true, nothing was written again');
  return lines.join('\n');
}

export function parseCommand(argv: readonly string[]): {
  command: LandCommand | null;
  jobPath: string | null;
} {
  const known = (LAND_COMMANDS as readonly string[]).includes(argv[0] ?? '');
  const job = typeof argv[1] === 'string' && argv[1] !== '' ? argv[1] : null;
  return { command: known ? (argv[0] as LandCommand) : null, jobPath: job };
}

/** 0 success, 1 a refusal by a unit or a missing owner, 2 the operator called the CLI wrong. */
export async function runCommand(argv: readonly string[], deps: LandDeps): Promise<number> {
  const { command, jobPath } = parseCommand(argv);
  const usage = `usage: bun run scripts/itsaplan_land.ts <${LAND_COMMANDS.join('|')}> <job.json>`;
  if (command === null) {
    deps.writeErr(`${usage}\n`);
    return 2;
  }
  if (jobPath === null) {
    deps.writeErr(`${reportText(refusal('job', 'JOB_PATH_MISSING', 'no job file was named'))}\n`);
    return 2;
  }
  let raw: string;
  try {
    raw = deps.readFile(jobPath);
  } catch {
    const reason = `the job file could not be read: ${jobPath}`;
    deps.writeErr(`${reportText(refusal('job', 'JOB_UNREADABLE', reason))}\n`);
    return 1;
  }
  const parsed = parseJob(raw);
  if (!parsed.ok) {
    deps.writeErr(`${reportText(parsed.report)}\n`);
    return 1;
  }
  const { job } = parsed;
  const report =
    command === 'plan'
      ? planJob(job, deps.runnerFor(job.repo))
      : await (command === 'land' ? landJob : recordJob)(job, deps);
  const text = `${reportText(report)}\n`;
  if (report.ok) deps.writeOut(text);
  else deps.writeErr(text);
  return report.ok ? 0 : 1;
}

// Only the shipped CLI wires the real filesystem, git and the adapter seam.
if (import.meta.main) {
  const deps: LandDeps = {
    readFile: (path) => readFileSync(path, 'utf8'),
    loadAdapter: async (modulePath) =>
      (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>,
    runnerFor: (repo) => execRunner(repo),
    writeOut: (text) => void process.stdout.write(text),
    writeErr: (text) => void process.stderr.write(text),
  };
  const reportExit = await runCommand(process.argv.slice(2), deps);
  process.exit(reportExit);
}
