// The retained-row half of the bd adapter tests (split out of
// bd-adapter.test.ts, Root P0 2026-11-15: leaves under the 400-line cap,
// split by actual responsibility, no behavior change - these tests moved
// verbatim). bd-adapter.test.ts keeps the export parsing, the one-command
// boundary, the snapshot and the registration; this leaf owns the retained
// rows and the durable artifact:
//
//   - listRetainedRows: the memory row (exact key/value, memory:<key>
//     namespace, never a bead id) AND each real ticket's ticket_metadata row;
//   - the artifact BYTES: the memory value and the ticket notes reach the
//     job artifact, distinct values give distinct digests, and an unknown
//     field bd adds still survives and changes the digest.
//
// The board fixtures are the same real-shape export the core file uses
// (duplicated per leaf - test fixtures, not a shim chain).
import { describe, expect, test } from 'bun:test';
import { BdReader, RETAINED_CONTENT_NOTE, type BdCommandRunner } from './bd-adapter';
import type { BdCardView } from './bd-mapping';
import { retainedArtifactOf } from './import-retained';

// A captured `bd export --all` in its REAL shape (Root P0 2026-11-15 baseline):
// JSONL, one record per line. Issue records are _type:'issue' with the
// measured fields (comments/dependencies present-only-when-non-empty); memory
// records are EXACTLY {_type:'memory', key, value} - no id, no issue_type.
// The board: a root ticket with inline comments, a blocked daughter with the
// assignee token, a CLOSED feature (closed + non-task types are native issues,
// never retained), and one memory record.
const card = (
  c: Partial<BdCardView> & { id: string; title: string; issue_type: string },
): BdCardView => ({
  description: '',
  status: 'open',
  priority: null,
  assignee: null,
  labels: [],
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...c,
});

const BOARD_CARDS: BdCardView[] = [
  card({
    id: 'sentinel-prod-9010',
    title: 'root ticket',
    description: 'root body',
    issue_type: 'task',
    priority: 2,
    labels: ['import'],
    comment_count: 1,
    comments: [
      {
        id: 'c-uuid-1',
        issue_id: 'sentinel-prod-9010',
        author: 'codex_admin',
        text: 'a note',
        created_at: '2026-11-03T00:00:00.000Z',
      },
    ],
  }),
  card({
    id: 'sentinel-prod-9010.1',
    title: 'blocked daughter',
    description: 'daughter body',
    status: 'blocked',
    issue_type: 'task',
    assignee: 'qwen',
    notes: 'daughter notes',
    owner: 'qwen',
    dependencies: [
      {
        issue_id: 'sentinel-prod-9010.1',
        depends_on_id: 'sentinel-prod-9010',
        type: 'blocked_by',
        created_at: '2026-11-02T00:00:00Z',
        created_by: 'qwen',
        metadata: '{}',
      },
    ],
  }),
  // Root P0: the old task/bug/epic/decision ticket set wrongly retained the
  // 333 feature/chore/molecule/spike/event/merge-request issues as non-tickets.
  // A CLOSED feature is the sharpest case: closed AND not a task class.
  card({
    id: 'sentinel-prod-9011',
    title: 'shipped feature',
    status: 'closed',
    issue_type: 'feature',
  }),
];

const MEMORY = { _type: 'memory', key: 'lane-preference', value: 'use bun, not npm' } as const;

// The full export text: issues first, then the memory record - the measured
// order of the real board's export (issues, then memories).
const EXPORT_TEXT = [
  ...BOARD_CARDS.map((c) => JSON.stringify({ _type: 'issue', ...c })),
  JSON.stringify(MEMORY),
].join('\n');

// The fake runner: ONE command, `bd export --all`, returning the captured
// export text. Any other command shape is a test failure - the adapter must
// never issue list, show, or anything else.
function fakeBd(text: string = EXPORT_TEXT): { run: BdCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: BdCommandRunner = async (args) => {
    calls.push(args);
    if (args[1] === 'export' && args[2] === '--all') return text;
    throw new Error(`unexpected bd command: ${args.join(' ')}`);
  };
  return { run, calls };
}
describe('the bd retained rows and the durable artifact (split leaf)', () => {
  test('listRetainedRows: the memory row (exact key/value, memory:<key> namespace) AND each real ticket metadata row', async () => {
    const { run, calls } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    const rows = await reader.listRetainedRows();
    const daughter = BOARD_CARDS[1]!;
    const root = BOARD_CARDS[0]!;
    // The raw entry serializes the record AS PARSED: the _type:'issue' marker
    // rides along verbatim - the honest byte of the export line.
    const rawOf = (c: BdCardView) => JSON.stringify({ _type: 'issue', ...c });
    expect(rows).toEqual([
      {
        sourceId: 'memory:lane-preference',
        title: 'lane-preference',
        retention: 'memory_key',
        reason:
          'Dolt memory record: exact key/value retained under the source namespace, never a bead id',
        unmapped: [
          { field: 'key', value: 'lane-preference', note: RETAINED_CONTENT_NOTE },
          { field: 'value', value: 'use bun, not npm', note: RETAINED_CONTENT_NOTE },
          { field: 'raw', value: JSON.stringify(MEMORY), note: RETAINED_CONTENT_NOTE },
        ],
      },
      {
        sourceId: 'sentinel-prod-9010',
        title: 'root ticket',
        retention: 'ticket_metadata',
        reason: 'real ticket: source metadata retained durably, no tombstone',
        originalTitle: 'root ticket',
        alreadyPrefixed: false,
        unmapped: [{ field: 'raw', value: rawOf(root), note: RETAINED_CONTENT_NOTE }],
      },
      {
        sourceId: 'sentinel-prod-9010.1',
        title: 'blocked daughter',
        retention: 'ticket_metadata',
        reason: 'real ticket: source metadata retained durably, no tombstone',
        originalTitle: 'blocked daughter',
        alreadyPrefixed: false,
        unmapped: [
          {
            field: 'assignee',
            value: 'qwen',
            note: 'bd assignee token is not a project-member email; retained for reconciliation',
          },
          {
            field: 'dependency:blocked_by',
            value: JSON.stringify(daughter.dependencies![0]!),
            note: 'raw kind blocked_by is not in the measured set; retained raw, never projected and never dropped',
          },
          {
            field: 'notes',
            value: 'daughter notes',
            note: 'bd notes field has no target column; carried verbatim',
          },
          {
            field: 'owner',
            value: 'qwen',
            note: 'bd owner token is not a project-member email; retained for reconciliation',
          },
          { field: 'raw', value: rawOf(daughter), note: RETAINED_CONTENT_NOTE },
        ],
      },
      {
        sourceId: 'sentinel-prod-9011',
        title: 'shipped feature',
        retention: 'ticket_metadata',
        reason: 'real ticket: source metadata retained durably, no tombstone',
        originalTitle: 'shipped feature',
        alreadyPrefixed: false,
        unmapped: [{ field: 'raw', value: rawOf(BOARD_CARDS[2]!), note: RETAINED_CONTENT_NOTE }],
      },
    ]);
    // ONE export read for the whole tick: the memory row, the metadata rows,
    // and the comments all came from that single snapshot.
    expect(calls).toEqual([['bd', 'export', '--all']]);
    // A second read adds no commands: the snapshot is cached for the tick.
    await reader.listRetainedRows();
    expect(calls).toEqual([['bd', 'export', '--all']]);
  });

  test('the memory value and the ticket notes reach the JOB artifact bytes (not snapshot arrays)', async () => {
    const { run } = fakeBd();
    const rows = await new BdReader({ boardPath: '/boards/sentinel-prod' }, run).listRetainedRows();
    const bytes = JSON.stringify(retainedArtifactOf(rows).rows);
    const parsed = JSON.parse(bytes) as {
      sourceId: string;
      retention: string;
      originalTitle?: string;
      alreadyPrefixed?: boolean;
      unmapped: { field: string; value: string }[];
    }[];
    // The memory row is IN the artifact under the source namespace with its
    // EXACT value bytes...
    const mem = parsed.find((r) => r.sourceId === 'memory:lane-preference')!;
    expect(mem.retention).toBe('memory_key');
    expect(mem.unmapped.find((u) => u.field === 'value')!.value).toBe('use bun, not npm');
    expect(bytes).toContain('"value":"use bun, not npm"');
    // ...the ticket's original title is reconstructible...
    const daughter = parsed.find((r) => r.sourceId === 'sentinel-prod-9010.1')!;
    expect(daughter.originalTitle).toBe('blocked daughter');
    expect(daughter.alreadyPrefixed).toBe(false);
    // ...and the export's notes field is byte-for-byte inside the artifact.
    expect(daughter.unmapped.find((u) => u.field === 'notes')!.value).toBe('daughter notes');
    expect(bytes).toContain('"value":"daughter notes"');
    // A changed memory value changes the durable digest: the bytes are
    // load-bearing, not decorative.
    const alt = EXPORT_TEXT.replace('use bun, not npm', 'use pnpm');
    const altRows = await new BdReader(
      { boardPath: '/boards/sentinel-prod' },
      fakeBd(alt).run,
    ).listRetainedRows();
    expect(retainedArtifactOf(altRows).digest).not.toBe(retainedArtifactOf(rows).digest);
  });

  test('distinct memory values produce distinct artifacts: a changed value changes the digest', async () => {
    // The RETURN3 defect, memory edition: two boards differing only in a
    // memory value must never collapse to the same durable artifact.
    const withValue = (value: string) => `${JSON.stringify({ _type: 'memory', key: 'k', value })}`;
    const readerA = new BdReader(
      { boardPath: '/boards/sentinel-prod' },
      fakeBd(withValue('first')).run,
    );
    const readerB = new BdReader(
      { boardPath: '/boards/sentinel-prod' },
      fakeBd(withValue('second')).run,
    );
    const rowsA = await readerA.listRetainedRows();
    const rowsB = await readerB.listRetainedRows();
    const valueOf = (rows: { unmapped: { field: string; value: string; note: string }[] }[]) =>
      rows[0]!.unmapped.find((u) => u.field === 'value')!.value;
    expect(valueOf(rowsA)).toBe('first');
    expect(valueOf(rowsB)).toBe('second');
    expect(retainedArtifactOf(rowsA).digest).not.toBe(retainedArtifactOf(rowsB).digest);
    // And the identical board still digests identically: determinism is kept.
    const readerA2 = new BdReader(
      { boardPath: '/boards/sentinel-prod' },
      fakeBd(withValue('first')).run,
    );
    expect(retainedArtifactOf(rowsA).digest).toBe(
      retainedArtifactOf(await readerA2.listRetainedRows()).digest,
    );
  });

  test('an unknown field bd adds still survives to the artifact and changes the digest', async () => {
    // BdCardView names the fields bd has today; the catch-all must preserve any
    // field a future bd adds, so no source byte can be silently dropped (Root,
    // 8363.1: ALL raw fields, known and unknown).
    const withUnknown = (extra: Record<string, unknown>) =>
      EXPORT_TEXT.replace(
        JSON.stringify(MEMORY),
        JSON.stringify({ ...MEMORY, source_app: 'qore', board_revision: 17, ...extra }),
      );
    const plain = new BdReader({ boardPath: '/boards/sentinel-prod' }, fakeBd(EXPORT_TEXT).run);
    const evolved = new BdReader(
      { boardPath: '/boards/sentinel-prod' },
      fakeBd(withUnknown({})).run,
    );
    const rowsA = await plain.listRetainedRows();
    const rowsB = await evolved.listRetainedRows();
    // The unknown fields are recoverable from the memory row, verbatim.
    const rawOf = (rows: { unmapped: { field: string; value: string; note: string }[] }[]) =>
      JSON.parse(rows[0]!.unmapped.find((u) => u.field === 'raw')!.value) as Record<
        string,
        unknown
      >;
    expect(rawOf(rowsA).source_app).toBeUndefined();
    expect(rawOf(rowsB).source_app).toBe('qore');
    expect(rawOf(rowsB).board_revision).toBe(17);
    // ...and a changed unknown field changes the durable artifact's digest.
    expect(retainedArtifactOf(rowsA).digest).not.toBe(retainedArtifactOf(rowsB).digest);
  });
});
