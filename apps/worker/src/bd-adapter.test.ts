import { describe, expect, test } from 'bun:test';
import { BdReader, type BdCommandRunner } from './bd-adapter';
import { mapBdSource, type BdCardView } from './bd-mapping';
import { card } from './bd-adapter-testboard';

// A captured `bd export --all` in its REAL shape (Root P0 2026-11-15 baseline):
// JSONL, one record per line. Issue records are _type:'issue' with the
// measured fields (comments/dependencies present-only-when-non-empty); memory
// records are EXACTLY {_type:'memory', key, value} - no id, no issue_type.
// The board: a root ticket with inline comments, a blocked daughter with the
// assignee token, a CLOSED feature (closed + non-task types are native issues,
// never retained), and one memory record.

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
        type: 'parent-child',
        created_at: '2026-11-02T00:00:00Z',
        created_by: 'qwen',
        metadata: '{}',
      },
      {
        issue_id: 'sentinel-prod-9010.1',
        depends_on_id: 'sentinel-prod-9010',
        type: 'blocks',
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

describe('BdReader', () => {
  test('names the board from the config, falling back to the directory name', async () => {
    const { run } = fakeBd();
    const named = new BdReader(
      { boardPath: '/srv/boards/sentinel-prod', sourceName: 'Sentinel prod board' },
      run,
    );
    expect(await named.describeSource()).toEqual({ name: 'Sentinel prod board', url: null });
    const unnamed = new BdReader({ boardPath: '/srv/boards/sentinel-prod' }, run);
    expect((await unnamed.describeSource()).name).toBe('sentinel-prod');
  });

  test('listIssueTypes returns the EXACT distinct source issue_type names, machine-bound, never translated', async () => {
    const { run } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    // The fixture board carries task + feature: both exact names, sorted, no
    // duplicates, no translation (the readiness mapping task/feature -> task
    // happens at the native ready fact, not here).
    expect(await reader.listIssueTypes()).toEqual([
      { sourceId: 'feature', name: 'feature' },
      { sourceId: 'task', name: 'task' },
    ]);
  });

  test('listStates and listLabels come from the whole-board snapshot', async () => {
    const { run } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    expect(await reader.listStates()).toEqual([
      { sourceId: 'status:blocked', name: 'Blocked', category: 'started' },
      { sourceId: 'status:closed', name: 'Closed', category: 'completed' },
      { sourceId: 'status:open', name: 'Open', category: 'unstarted' },
    ]);
    expect(await reader.listLabels()).toEqual([{ sourceId: 'label:import', name: 'import' }]);
  });

  test('EVERY _type issue record is a ticket: closed and feature are not retained (Root P0)', async () => {
    const { run } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    const page = await reader.listIssues();
    expect(page.cursor).toBeNull();
    // All three issue records are issues - the closed feature included. No
    // issue is retained as a non-ticket; the only retained row is the memory.
    expect(page.items.map((i) => i.sourceId)).toEqual([
      'sentinel-prod-9010',
      'sentinel-prod-9010.1',
      'sentinel-prod-9011',
    ]);
    const daughter = page.items.find((i) => i.sourceId === 'sentinel-prod-9010.1')!;
    expect(daughter.parentSourceId).toBe('sentinel-prod-9010');
    expect(daughter.stateSourceId).toBe('status:blocked');
    const feature = page.items.find((i) => i.sourceId === 'sentinel-prod-9011')!;
    expect(feature.stateSourceId).toBe('status:closed');
    const rows = await reader.listRetainedRows();
    expect(rows.filter((r) => r.retention === 'memory_key')).toHaveLength(1);
    expect(rows.filter((r) => r.sourceId.startsWith('sentinel-prod-'))).toHaveLength(
      BOARD_CARDS.length,
    );
    // The mapper's retained port (true bead retention) is empty: the memory
    // records are not beads and never ride it.
    const snap = mapBdSource(BOARD_CARDS, { rigPrefix: 'sentinel-prod' });
    expect(snap.retained).toEqual([]);
    expect(snap.issues).toHaveLength(3);
  });

  test('getIssue returns the card from the snapshot and refuses an unknown id', async () => {
    const { run } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    expect((await reader.getIssue('sentinel-prod-9010')).title).toBe('9010: root ticket');
    expect(reader.getIssue('9999')).rejects.toThrow(/not a ticket/);
  });

  test('listIssueRelations sees an edge at both ends', async () => {
    const { run } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    expect(await reader.listIssueRelations('sentinel-prod-9010')).toEqual([
      {
        kind: 'blocks',
        sourceIssueSourceId: 'sentinel-prod-9010',
        targetIssueSourceId: 'sentinel-prod-9010.1',
      },
    ]);
    expect(await reader.listIssueRelations('sentinel-prod-9010.1')).toEqual([
      {
        kind: 'blocks',
        sourceIssueSourceId: 'sentinel-prod-9010',
        targetIssueSourceId: 'sentinel-prod-9010.1',
      },
    ]);
    expect(await reader.listIssueRelations('9011')).toEqual([]);
  });

  test('comments come INLINE from the export record, keep the author token, and are cached', async () => {
    const { run, calls } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    const first = await reader.listIssueComments('sentinel-prod-9010');
    const second = await reader.listIssueComments('sentinel-prod-9010');
    expect(first).toEqual(second);
    // The export's comment object is {id, issue_id, author, text, created_at}:
    // the uuid id is the stable sourceId (never an index guess), the text field
    // is the body, and the author token survives.
    expect(first).toEqual([
      {
        sourceId: 'sentinel-prod-9010:c-uuid-1',
        authorEmail: null,
        authorName: 'codex_admin',
        bodyMarkdown: 'a note',
        createdAt: '2026-11-03T00:00:00.000Z',
        replyToSourceId: null,
      },
    ]);
    // NO show crawl: the whole board (comments included) came from the single
    // export read, and the comment read issued nothing at all.
    expect(calls).toEqual([['bd', 'export', '--all']]);
    // A record with no comments key: present-only-when-non-empty means absent
    // is no comments - but the read still issues no commands.
    expect(await reader.listIssueComments('sentinel-prod-9011')).toEqual([]);
    expect(calls).toEqual([['bd', 'export', '--all']]);
  });

  test('the ONLY command the adapter issues is the readonly bd export --all', async () => {
    const { run, calls } = fakeBd();
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod', bdCommand: 'bd' }, run);
    await reader.listIssues();
    await reader.listIssueComments('sentinel-prod-9010.1');
    await reader.listRetainedRows();
    expect(calls).toEqual([['bd', 'export', '--all']]);
  });

  test('a failing bd command fails the read with the command named', async () => {
    const run: BdCommandRunner = async () => {
      throw new Error('bd export --all failed: exit 1');
    };
    const reader = new BdReader({ boardPath: '/boards/sentinel-prod' }, run);
    expect(reader.listIssues()).rejects.toThrow(/bd export --all failed/);
  });

  describe('the bd export --all JSONL boundary (Root measured shape, 2026-11-15)', () => {
    const readerWith = (stdout: string) =>
      new BdReader({ boardPath: '/boards/sentinel-prod' }, async (args: string[]) => {
        if (args[1] === 'export' && args[2] === '--all') return stdout;
        throw new Error(`unexpected: ${args.join(' ')}`);
      });

    test('accepts the measured JSONL shape and tolerates blank lines', async () => {
      const reader = readerWith(`${JSON.stringify({ _type: 'memory', key: 'a', value: 'b' })}\n\n`);
      const rows = await reader.listRetainedRows();
      expect(rows.map((r) => r.sourceId)).toEqual(['memory:a']);
    });

    test('refuses a non-JSON line loudly, named by line number', async () => {
      const reader = readerWith(`${JSON.stringify(MEMORY)}\nnot json`);
      await expect(reader.listIssues()).rejects.toThrow(/line 2 is not a JSON object/);
    });

    test('refuses an issue record without an id', async () => {
      const reader = readerWith(JSON.stringify({ _type: 'issue', title: 'no id' }));
      await expect(reader.listIssues()).rejects.toThrow(/line 1 is an issue record without an id/);
    });

    test('refuses an issue record without a nonempty string status, like the api', async () => {
      // The mapper cannot map an undefined status to a state, so the tick
      // fails closed instead of shipping a stateless card (Root 2026-11-15).
      const noStatus = readerWith(
        JSON.stringify({ _type: 'issue', id: 'sentinel-prod-1', title: 'no status' }),
      );
      await expect(noStatus.listIssues()).rejects.toThrow(
        /line 1 is an issue record without a status/,
      );
      const emptyStatus = readerWith(
        JSON.stringify({ _type: 'issue', id: 'sentinel-prod-1', status: '' }),
      );
      await expect(emptyStatus.listIssues()).rejects.toThrow(
        /line 1 is an issue record without a status/,
      );
      const notString = readerWith(
        JSON.stringify({ _type: 'issue', id: 'sentinel-prod-1', status: 7 }),
      );
      await expect(notString.listIssues()).rejects.toThrow(
        /line 1 is an issue record without a status/,
      );
      // a valid status still lists the card
      const ok = readerWith(
        JSON.stringify({ _type: 'issue', id: 'sentinel-prod-1', title: 'a card', status: 'open' }),
      );
      const rows = await ok.listIssues();
      expect(rows.items.length).toBe(1);
    });

    test('refuses a memory record without a key', async () => {
      const reader = readerWith(JSON.stringify({ _type: 'memory', value: 'orphan' }));
      await expect(reader.listIssues()).rejects.toThrow(/line 1 is a memory record without a key/);
    });

    test('refuses an unknown _type rather than dropping records', async () => {
      const reader = readerWith(JSON.stringify({ _type: 'template', key: 'x' }));
      await expect(reader.listIssues()).rejects.toThrow(/unknown _type \(template\)/);
    });
  });
});
