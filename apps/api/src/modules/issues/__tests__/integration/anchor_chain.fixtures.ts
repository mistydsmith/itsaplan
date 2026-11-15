// Shared proof setup for the 8428 anchor chain slices (S2a facts: anchor_chain_facts.test.ts;
// S2b adapter: anchor_chain.test.ts). One place owns the recorded-fake wiring, the plan fixtures in
// the shared tool's published shape, and the captured writer, so the two proof files read as the
// claims they make rather than as two copies of the same plumbing.
//
// SELF-CONTAINED ON PURPOSE: this file imports nothing from either slice it serves. The shared tool's
// interpreter and plan mode are named here directly, and the plan shape is the shared tool's own
// published shape restated here rather than borrowed from the adapter, so slice S2a's proofs run on the
// base commit with no adapter present, and slice S2b adds to them without re-defining them.
//
// DB-free by construction: the self read and the candidate read are served by the recorded fake the
// 8428 proofs already use, a plan is served by a fixture in the shared tool's published shape, and
// the writer is CAPTURED instead of executed - because ItsPlan's own relation writer inserts through
// a raw statement the recorded fake cannot run. Production wiring is proven from the shipped source
// text, the way 8428's create-stamp wiring proof does.

import { afterAll, beforeAll, setDefaultTimeout } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG } from './fake_log';

// Bun's per-test default is 5 s; the shared-tool round trips start a python child.
setDefaultTimeout(120_000);

// The shared chain tool's interpreter and plan mode, named here as the transport the proofs use. The
// production adapter (slice S2b) states the same two values as its own exported constants and S2b's
// proof asserts them from the shipped source, so a drift between the two fails a test instead of
// passing unnoticed.
export const SHARED_CHAIN_PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';
export const SHARED_CHAIN_PLAN_MODE = '--plan-json';

/** One planned adjacency, in the shared tool's published field names. */
export interface PlanEdge {
  lower: string;
  upper: string;
  known: boolean;
  present: boolean;
  claimed: boolean;
  cycle: boolean;
  status?: string;
}

export interface PlanShape {
  ok?: boolean;
  appliable?: boolean;
  me_id?: string;
  files?: { path: string; order: string[]; edges: PlanEdge[]; conflict: boolean }[];
  conflict_files?: string[];
  diagnostics?: string[];
}

export const ENV_KEYS = [
  'ITSAPLAN_ANCHOR_CHAIN_TOOL',
  'ITSAPLAN_ANCHOR_CHAIN_PROOF_TOOL',
  'ITSAPLAN_ANCHOR_CHAIN_ACTOR',
  'ITSAPLAN_FAKE_ISSUE_ROWS',
  'ITSAPLAN_ANCHOR_MAP_TOOL',
  'ITSAPLAN_ANCHOR_MAP_REPO',
];

const savedEnv: Record<string, string | undefined> = {};
export const TMP = mkdtempSync(path.join(os.tmpdir(), '8428-chain-'));

/** The chain must never inherit a name from the machine running the proofs: every proof starts with
 * these keys as they were, and names one only inside `withEnv`. */
export function installEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.ITSAPLAN_ANCHOR_CHAIN_ACTOR;
}

export function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

export function withEnv(
  key: string,
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const had = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return run().finally(() => {
    if (had === undefined) delete process.env[key];
    else process.env[key] = had;
  });
}

/** The rows the recorded fake will serve for the candidate read and the self read. */
export function fixtureRows(rows: Record<string, unknown>[]): void {
  const file = path.join(TMP, `rows-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(rows));
  process.env.ITSAPLAN_FAKE_ISSUE_ROWS = file;
}

/** The keys the shared planner reads, in the order `bd show --json` hands them over. */
export const NATIVE_KEYS = [
  'id',
  'status',
  'assignee',
  'owner',
  'description',
  'notes',
  'created_at',
  'dependencies',
];

// A row of the table the chain reads, with the fields the chain needs. createdAt is an ISO instant so
// the shared rule's creation tie-break has something to compare.
export const row = (id: number, description: string, extra: Record<string, unknown> = {}) => ({
  id,
  description,
  projectId: 1,
  columnId: null,
  stateType: null,
  claimOwner: null,
  assigneeUserId: null,
  archivedAt: null,
  createdAt: new Date('2026-11-01T00:00:00.000Z').toISOString(),
  ...extra,
});

// The one proof file every chain case uses, and the two same-file anchor rows the cases are built on:
// 101 holding the shallower range, 102 the deeper one.
export const PROOF_FILE = 'tools/mod_a.py';

export function anchorRows(
  first: string,
  second: string,
  over101: Record<string, unknown> = {},
  over102: Record<string, unknown> = {},
): void {
  fixtureRows([
    row(101, `${first} ${PROOF_FILE}:1-2`, over101),
    row(102, `${second} ${PROOF_FILE}:20-24`, over102),
  ]);
}

export function twoRows(): void {
  anchorRows('a', 'b');
}

/** The same two rows as plain values, for a proof that supplies its own fact reader. */
export function proofRowPair(): Record<string, unknown>[] {
  return [row(101, `a ${PROOF_FILE}:1-2`), row(102, `b ${PROOF_FILE}:20-24`)];
}

/** What one authorised write looks like, in the shape the existing relation writer is called with. */
export function written(
  issueId: number,
  targetIssueId: number,
  actorUserId: string | null = null,
): Write {
  return { issueId, targetIssueId, kind: 'blocks', actorUserId };
}

/** The payload the adapter sends, restated in the shared tool's own field names. */
export type PayloadShape = {
  me_id: string;
  files: { path: string }[];
  issues: Record<string, unknown>[];
};

// A record in the shape the shared planner reads, for the proofs that speak to the shared tool
// directly rather than through the adapter.
export const nativeFact = (
  id: string,
  description: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  status: 'open',
  assignee: null,
  owner: null,
  description,
  notes: '',
  created_at: '2026-11-01T00:00:00Z',
  dependencies: [],
  ...over,
});

/** Twelve same-file records as native facts: the shared rule's own ten-sibling bound, exceeded by one,
 * each with its own created_at so the rule's tie-break has something to compare. */
export const twelveSameFileFacts = () =>
  Array.from({ length: 12 }, (_, i) =>
    nativeFact(String(100 + i), `x ${PROOF_FILE}:${i * 5 + 1}-${i * 5 + 3}`, {
      created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z`,
    }),
  );

export function edge(lower: string, upper: string, over: Partial<PlanEdge> = {}): PlanEdge {
  return {
    lower,
    upper,
    known: true,
    present: false,
    claimed: false,
    cycle: false,
    status: 'open',
    ...over,
  };
}

export function planFile(p: string, order: string[], edges: PlanEdge[]) {
  return { path: p, order, edges, conflict: false };
}

/** A plan in the shared tool's published shape, with the permission field it publishes. */
export function plan(files: ReturnType<typeof planFile>[], appliable = true): PlanShape {
  return { ok: true, appliable, me_id: '102', files, conflict_files: [], diagnostics: [] };
}

export function fakePlanner(
  result: PlanShape,
  seen: unknown[],
): (payload: unknown) => Promise<PlanShape> {
  return async (payload) => {
    seen.push(payload);
    return result;
  };
}

export interface Write {
  issueId: number;
  targetIssueId: number;
  kind: string;
  actorUserId: string | null;
}

/** The writer stand-in: it records what the chain asked for and can be made to refuse, so a write is
 * proved as a call with a null actor id, never as a row in a fake table. */
export function captureWriter(writes: Write[], fail?: (write: Write) => unknown) {
  return async (
    issueId: number,
    targetIssueId: number,
    kind: 'blocks',
    actorUserId: string | null,
  ) => {
    const write = { issueId, targetIssueId, kind, actorUserId };
    writes.push(write);
    const error = fail?.(write);
    if (error) throw error;
    return { id: 'link', sourceIssueId: issueId, targetIssueId, kind };
  };
}

export function activityRows(marker: string): Record<string, unknown>[] {
  return LOG.ops
    .filter((o) => o.op === 'insert.values' && o.table === 'issue_activity')
    .flatMap((o) => (Array.isArray(o.values) ? o.values : [o.values]))
    .filter((r) => JSON.stringify(r).includes(marker)) as Record<string, unknown>[];
}

export const chainReports = () => activityRows('anchor_chain_report');
export const stampedReports = () => activityRows('anchor_map_stamped');

export function lastOp(op: string): { table?: string; text?: string } {
  return LOG.ops.filter((o) => o.op === op).slice(-1)[0] ?? {};
}

/** Write a small stand-in proof script: a shared tool a proof can name by path without asking the real
 * shared checkout to behave differently. */
export function writeProofScript(file: string, body: string[]): string {
  writeFileSync(file, body.join('\n'));
  return file;
}

export function ops(op: string): { table?: string; text?: string }[] {
  return LOG.ops.filter((o) => o.op === op) as { table?: string; text?: string }[];
}

/** The shared chain tool a runner names for proof, or empty when none is installed. A proof that
 * needs the shared tool prints SKIP in that case - never a PASS. */
export const proofTool = (): string => (process.env.ITSAPLAN_ANCHOR_CHAIN_PROOF_TOOL ?? '').trim();

/** Ask the shared tool for a plan over a fixture payload: its own process, its own answers. */
export function askShared(payload: unknown): PlanShape {
  const out = execFileSync(
    process.env.ITSAPLAN_ANCHOR_MAP_PYTHON ?? SHARED_CHAIN_PYTHON,
    ['-B', proofTool(), SHARED_CHAIN_PLAN_MODE],
    { encoding: 'utf8', input: JSON.stringify(payload) },
  );
  return JSON.parse(out) as PlanShape;
}

/** The shipped source, read as text: the way 8428 proves production wiring without a live database. */
export function sourceOf(rel: string): string {
  return readFileSync(path.join(import.meta.dir, rel), 'utf8');
}

/** One issue carrying n 'blocks' relation rows: a relation multiplies rows, never issues. */
export const relationsOf = (id: number, n: number) =>
  Array.from({ length: n }, (_, i) => row(id, `a ${PROOF_FILE}:1-2`, { blockedBySource: 200 + i }));

/** Twelve candidates on one file: the shared rule's own ten-sibling bound, exceeded by one. */
export const twelveSameFile = () =>
  Array.from({ length: 12 }, (_, i) => row(100 + i, `x ${PROOF_FILE}:${i * 5 + 1}-${i * 5 + 3}`));

/** One issue's join multiplicity: the same relation twice, a self relation, the left join's own
 * no-relation row, a relation to an issue this read will not keep, and a second issue. */
export const dedupeRows = () => [
  row(101, `a ${PROOF_FILE}:1-2`, { blockedBySource: 102 }),
  row(101, `a ${PROOF_FILE}:1-2`, { blockedBySource: 102 }),
  row(101, `a ${PROOF_FILE}:1-2`, { blockedBySource: 101 }),
  row(101, `a ${PROOF_FILE}:1-2`, { blockedBySource: null }),
  row(101, `a ${PROOF_FILE}:1-2`, { blockedBySource: 999 }),
  row(102, `b ${PROOF_FILE}:20-24`),
];

/** Root's 8428 crowded board: eleven unfinished rows on eleven other files, then the same-file pair.
 * The unrelated rows carry the LOW ids on purpose - a bound applied to the board in id order spends
 * itself on them, which is what made the same-file peer invisible to the shared rule. */
export function crowdedRows(lowerId = 100, upperId = 101): Record<string, unknown>[] {
  return [
    ...Array.from({ length: 11 }, (_, i) => row(i + 1, `unrelated tools/other_${i}.py:1-2`)),
    row(lowerId, `lower ${PROOF_FILE}:20-24`),
    row(upperId, `upper ${PROOF_FILE}:1-2`),
  ];
}

/** The scope a chain over PROOF_FILE hands its facts reader. */
export const modAScope = (issueId = 100) => ({ issueId, files: [PROOF_FILE] });

/** A facts reader that runs a real read and remembers the scope it was handed, so a proof can show
 * what the adapter asked for as well as what the reader returned. */
export function scopeRecordingFacts<T>(
  seen: { issueId: number; files: string[] }[],
  read: (cap: number, scope: { issueId: number; files: string[] }) => Promise<T>,
) {
  return async (cap: number, scope: { issueId: number; files: string[] }): Promise<T> => {
    seen.push(scope);
    return read(cap, scope);
  };
}

export { beforeAll, afterAll, LOG };
