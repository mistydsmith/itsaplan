// Transport fake for @repo/db used by the 8428 proof tests (NO LIVE DB): a fake
// query builder that records every operation instead of touching a database.
// The mock (anchor_stamp_preload.ts) spreads the REAL @repo/db module and
// replaces only the client, so the real schema tables, error classes and pure
// functions stay in place and the real service code paths run against the fake
// exactly as they run against drizzle.
//
// Candidate rows for the landing sweep's issue read come from the JSON file
// named by ITSAPLAN_FAKE_ISSUE_ROWS, so a child process (the shipped CLI under
// the shipped git hook) sees the same fixture as an in-process call.
// The ingress mode (ordinary board vs gated rig) lives on the recorded log.
// DATABASE_URL is set by the preload so the real lazy client loads; it is
// never queried.

import { readFileSync } from 'node:fs';

export type Op = { op: string; table?: string; values?: unknown; text?: string };

export interface FakeLog {
  ops: Op[];
  rolledBack: boolean;
  /** Ingress mode the next create runs in: ordinary board or gated rig. */
  mode: 'ordinary' | 'gated';
}

type Fields = Record<string, unknown>;

// A stored issue row needs every column the DTO mapping reads; keys the insert
// did not set read as NULL, like the real RETURNING row would.
const ROW_DEFAULTS: Record<string, unknown> = {
  typeId: null,
  initiativeId: null,
  cycleId: null,
  parentId: null,
  assigneeUserId: null,
  delegateUserId: null,
  priority: null,
  estimatePoints: null,
  estimateMinutes: null,
  startDate: null,
  dueDate: null,
  archivedAt: null,
  shareToken: null,
  shareExtended: false,
  shareExpiresAt: null,
  beadId: null,
  createdAt: new Date('2026-11-14T00:00:00Z'),
  updatedAt: new Date('2026-11-14T00:00:00Z'),
};

// Drizzle keeps a table's SQL name on a well-known Symbol (Symbol.for('drizzle:Name'));
// a column object carries .table back to its table, and drizzle column names are
// String objects, so the symbol is the only reliable identity.
function tableName(v: unknown): string {
  for (const cand of [v, (v as { table?: unknown })?.table]) {
    if (typeof cand !== 'object' || cand === null) continue;
    const name = (cand as Record<symbol, unknown>)[Symbol.for('drizzle:Name')];
    if (typeof name === 'string') return name;
  }
  return '?';
}

export interface FakeIssueRow {
  id: number;
  description: string;
  archivedAt: string | null;
  columnId: number | null;
  stateType: string | null;
}

function fixtureRows(): FakeIssueRow[] {
  const p = process.env.ITSAPLAN_FAKE_ISSUE_ROWS;
  if (!p) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as FakeIssueRow[];
  } catch {
    return [];
  }
}

class Chain {
  tables: string[] = [];
  rows: Record<string, unknown>[] = [];
  constructor(
    private log: FakeLog,
    private fields: Fields,
    private kind: string,
  ) {}
  from(t: unknown) {
    this.tables.push(tableName(t));
    return this;
  }
  innerJoin(t: unknown) {
    this.tables.push(tableName(t));
    return this;
  }
  leftJoin(t: unknown, on?: unknown) {
    const name = tableName(t);
    this.tables.push(name);
    // Capture what the shipped code actually handed the query builder, so a
    // proof can assert the emitted join instead of a self-description.
    this.log.ops.push({ op: 'left_join', table: name, text: capturedSql(on) });
    return this;
  }
  where(c: unknown) {
    this.log.ops.push({
      op: 'where',
      table: this.tables[0],
      text: capturedSql(c),
    });
    return this;
  }
  set(v: unknown) {
    this.log.ops.push({ op: `${this.kind}.set`, table: this.tables[0], values: v });
    return this;
  }
  values(v: unknown) {
    this.log.ops.push({ op: `${this.kind}.values`, table: this.tables[0], values: v });
    this.rows = (Array.isArray(v) ? v : [v]).map((r) => ({
      id: 42,
      ...(r as Record<string, unknown>),
    }));
    return this;
  }
  limit(_n: number) {
    return this;
  }
  groupBy(..._a: unknown[]) {
    return this;
  }
  having(_c: unknown) {
    return this;
  }
  offset(_n: number) {
    return this;
  }
  rightJoin(t: unknown) {
    this.tables.push(tableName(t));
    return this;
  }
  fullJoin(t: unknown) {
    this.tables.push(tableName(t));
    return this;
  }
  forUpdate() {
    return this;
  }
  orderBy(..._a: unknown[]) {
    return this;
  }
  returning(sel?: Fields) {
    if (this.kind === 'update' && this.tables[0] === 'project')
      return Promise.resolve([{ seq: 7 }]);
    if (sel && 'id' in sel && 'createdAt' in sel) {
      return Promise.resolve([{ id: 42, createdAt: new Date('2026-11-14T00:00:00Z') }]);
    }
    return Promise.resolve(this.rows);
  }
  then(onFulfilled?: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) {
    return this.resolve().then(onFulfilled, onRejected);
  }
  private storedIssues(): Record<string, unknown>[] {
    // The rows the fake actually holds: what the insert wrote, plus the id and
    // timestamps Postgres would have filled in on the returning stretch.
    return this.log.ops
      .filter((o) => o.op === 'insert.values' && o.table === 'issue')
      .flatMap((o) => (Array.isArray(o.values) ? o.values : [o.values]))
      .map((r) => ({
        id: 42,
        sequenceNumber: 42,
        beadId: null,
        createdAt: new Date('2026-11-14T00:00:00Z'),
        updatedAt: new Date('2026-11-14T00:00:00Z'),
        ...(r as Record<string, unknown>),
      }));
  }
  async resolve(): Promise<unknown[]> {
    const f = Object.keys(this.fields ?? {});
    const head = this.tables[0] ?? '?';
    this.log.ops.push({ op: 'select', table: head });
    if (head === 'issue' && this.tables.includes('project')) {
      if (f.includes('count')) return [{ count: 0 }];
      const stored = this.storedIssues().map((r) => ({ ...ROW_DEFAULTS, ...r }));
      if (f.includes('issue') && f.includes('projectKey')) {
        return stored.map((r) => ({ issue: r, projectKey: 'TST' }));
      }
      return stored.map((r) => ({ id: r.id, key: 'TST', seq: r.sequenceNumber }));
    }
    if (head === 'issue' && this.tables.includes('initiative')) return [];
    if (head === 'issue' && f.includes('pos')) {
      // Board position bookkeeping: COALESCE(MAX(position),0)+1000.
      return [{ pos: 1000 }];
    }
    if (head === 'issue') {
      // The landing sweep's candidate read: the fixture stands in for the DB.
      const rows = fixtureRows();
      if (process.env.ITSAPLAN_FAKE_DEBUG)
        console.log(
          '[DEBUG resolve]',
          head,
          JSON.stringify(this.tables),
          JSON.stringify(f),
          'rows:',
          rows.length,
        );
      return rows;
    }
    if (head === 'project') {
      // Same mode knob as the raw path: ordinary project holds no rig.
      return [{ rig_id: this.log.mode === 'gated' ? 5 : null }];
    }
    if (head === 'project_column') {
      return [
        { id: 7, name: 'Doing', stateType: 'started', userId: null, wipLimit: null, wipMode: null },
      ];
    }
    return [];
  }
}

/** Test-side rendering of the SQL a real drizzle builder was handed: literal
 * chunks plus every referenced column as table.column and any bound literal.
 * This is the capture a proof asserts on, so production code needs no helper
 * exported just for the test. */
export function capturedSql(fragment: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      parts.push(v);
      return;
    }
    if (v instanceof String) {
      parts.push(String(v)); // a drizzle column name
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((piece) => walk(piece, depth + 1));
      return;
    }
    if (typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.queryChunks)) {
      o.queryChunks.forEach((c) => walk(c, depth + 1));
      return;
    }
    if (Array.isArray(o.strings)) {
      o.strings.forEach((s) => typeof s === 'string' && s.trim() && parts.push(s));
      return;
    }
    if (Array.isArray(o.value)) {
      o.value.forEach((piece) => walk(piece, depth + 1));
      return;
    }
    const name = o.name;
    if (typeof name === 'string' || name instanceof String) {
      const table = tableName(o);
      parts.push(`${table === '?' ? '' : `${table}.`}${String(name)}`);
      return;
    }
    if (typeof o.value === 'string' || o.value instanceof String) parts.push(String(o.value));
  };
  walk(fragment, 0);
  return parts.join(' ');
}

/** Raw-SQL text of a drizzle sql`...` fragment (queryChunks holds the literal pieces). */
export function rawSqlText(query: unknown): string {
  if (typeof query === 'string') return query;
  const q = query as { strings?: string[]; queryChunks?: unknown[] };
  if (q?.strings?.length) return q.strings.join(' ? ');
  if (Array.isArray(q?.queryChunks)) {
    // drizzle splits a sql`...` fragment into StringChunk literals (their value
    // is an ARRAY of literal pieces) interleaved with the parameter values.
    const parts: string[] = [];
    for (const chunk of q.queryChunks) {
      if (typeof chunk === 'string') {
        parts.push(chunk);
        continue;
      }
      const v =
        (chunk as { value?: unknown; str?: unknown }).value ?? (chunk as { str?: unknown }).str;
      if (Array.isArray(v)) {
        for (const piece of v) {
          if (piece != null) parts.push(String(piece));
        }
      } else if (typeof v === 'string') {
        parts.push(v);
      } else {
        parts.push(' ? '); // a bound parameter: the shape of the statement is what we dispatch on
      }
    }
    return parts.join(' ');
  }
  return '';
}

/**
 * Raw-SQL answers for the create chain (A4 item 1). Dispatched on the tables
 * the statement names, with the ingress mode taken from the recorded fake's
 * state (resetLog('ordinary'|'gated')) rather than process env, so a test
 * cannot leak mode into the next one. Statements whose rows the real chain
 * ignores (row locks, seed reads) answer "no rows", which is what a locked or
 * empty table answers.
 */
function rawAnswer(log: FakeLog, text: string): unknown[] {
  const gated = log.mode === 'gated';
  if (/\bproject\b/i.test(text) && /rig_id/i.test(text)) return [{ rig_id: gated ? 5 : null }];
  return [];
}

export function makeFakeDb(log: FakeLog) {
  const client: Record<string, unknown> = {};
  const exec = async (query: unknown): Promise<unknown[]> => {
    const text = rawSqlText(query);
    log.ops.push({ op: 'execute', table: 'raw', text: text.slice(0, 120) });
    return rawAnswer(log, text);
  };
  client.select = (fields?: Fields) => new Chain(log, fields ?? {}, 'select');
  client.insert = (t: unknown) => {
    const c = new Chain(log, {}, 'insert');
    c.from(t);
    return c;
  };
  client.update = (t: unknown) => {
    const c = new Chain(log, {}, 'update');
    c.from(t);
    return c;
  };
  client.delete = (t: unknown) => {
    const c = new Chain(log, {}, 'delete');
    c.from(t);
    return c;
  };
  client.execute = exec;
  client.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    // One recorded context stands in for the transaction; a thrown callback is
    // the rollback the fake reports on the log.
    try {
      return await fn(client);
    } catch (e) {
      log.rolledBack = true;
      throw e;
    }
  };
  return client;
}
