// The synthetic bd board the 8363.1 whole-pipeline D2 witness feeds the REAL
// BdReader (Root handoff 2026-11-15: "REAL BdReader with injected synthetic
// export (no bd calls), REAL native store and the same source stamp hooks").
// It is the measured `bd export --all` JSONL shape (one record per line;
// issues carry their comments and dependencies INLINE; Dolt memories carry
// exactly {_type, key, value}) with a board small enough to assert EXACTLY:
//
//   - every issue_type is a native kind (task, bug, feature, epic, decision);
//   - the closed card rides the preserved 'Closed' state (no silent folding);
//   - a dotted daughter with the MEASURED edge kinds (an explicit parent-child
//     edge AND a blocks link - Root P0 2026-11-15: actual edges authoritative);
//   - a 'related' edge; comments on two cards; notes; owner/created_by/
//     started_at metadata; and an UNKNOWN field (source_app) bd did not name
//     in BdCardView - the catch-all must carry it verbatim to the artifact;
//   - one Dolt memory with its exact key/value retained raw.
//
// The runner answers ONLY `bd export --all` with this export and records every
// command it saw; any other shape throws, so the witness proves no bd call of
// any other kind ever leaves the pipeline. The boardPath's last segment is the
// trusted rig prefix (the reader derives it), so the card ids are
// '<prefix>-<token>' exactly as the measured board prints them.
import type { BdCommandRunner } from '../../bd-adapter';

interface WitnessCard {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number | null;
  assignee?: string | null;
  issue_type: string;
  labels?: string[];
  dependencies?: {
    issue_id: string;
    depends_on_id: string;
    type: string;
    created_at?: string | null;
    created_by?: string | null;
    metadata?: string;
  }[];
  created_at: string | null;
  updated_at: string | null;
  notes?: string;
  owner?: string | null;
  created_by?: string | null;
  started_at?: string | null;
  comments?: { id: string; author: string | null; text: string; created_at: string | null }[];
  [key: string]: unknown;
}

export interface WitnessBoard {
  // The trusted rig prefix = the board directory's name.
  prefix: string;
  boardPath: string;
  // The full export text the runner returns for `bd export --all`.
  exportText: string;
  // The injected runner: ONE command, `bd export --all`, nothing else.
  run: BdCommandRunner;
  calls: string[][];
  // The five card ids in export order.
  cardIds: string[];
  // The exact kind every card must materialize natively as.
  kinds: Record<string, string>;
  memory: { key: string; value: string };
}

export function buildWitnessBoard(run: string): WitnessBoard {
  const prefix = `imp83631pl-${run}`;
  const cid = (token: string) => `${prefix}-${token}`;
  const memory = { _type: 'memory', key: 'lane-preference', value: 'use bun, not npm' } as const;

  const cards: WitnessCard[] = [
    {
      id: cid('7100'),
      title: 'witness root card',
      description: 'root body',
      status: 'open',
      priority: 2,
      assignee: 'qwen',
      issue_type: 'task',
      labels: ['witness-label'],
      created_at: '2026-11-01T08:00:00Z',
      updated_at: '2026-11-02T08:00:00Z',
      notes: 'root notes verbatim',
      owner: 'qwen',
      created_by: 'qwen',
      started_at: '2026-11-01T09:00:00Z',
      comments: [
        {
          id: 'witness-c1',
          author: 'qwen',
          text: 'first comment body',
          created_at: '2026-11-01T10:00:00Z',
        },
        {
          id: 'witness-c2',
          author: 'codex_admin',
          text: 'second comment body',
          created_at: '2026-11-01T11:00:00Z',
        },
      ],
      // A field bd did NOT name in BdCardView: the adapter's catch-all keeps it
      // as printed, and the retained artifact's raw must carry the exact bytes.
      source_app: 'witness-app',
    },
    {
      id: cid('7100.1'),
      title: 'blocked daughter',
      description: 'daughter body',
      status: 'blocked',
      priority: null,
      assignee: 'qwen',
      issue_type: 'bug',
      created_at: '2026-11-01T12:00:00Z',
      updated_at: '2026-11-02T09:00:00Z',
      notes: 'daughter notes verbatim',
      owner: 'qwen',
      dependencies: [
        {
          issue_id: cid('7100.1'),
          depends_on_id: cid('7100'),
          type: 'parent-child',
          created_at: '2026-11-01T12:30:00Z',
          created_by: 'qwen',
          metadata: '{}',
        },
        {
          issue_id: cid('7100.1'),
          depends_on_id: cid('7100'),
          type: 'blocks',
          created_at: '2026-11-01T13:00:00Z',
          created_by: 'qwen',
          metadata: '{}',
        },
      ],
    },
    {
      id: cid('7101'),
      title: 'shipped feature',
      status: 'closed',
      priority: null,
      issue_type: 'feature',
      created_at: '2026-11-01T14:00:00Z',
      updated_at: '2026-11-02T10:00:00Z',
    },
    {
      id: cid('7102'),
      title: 'queued epic',
      status: 'queued',
      priority: null,
      issue_type: 'epic',
      labels: ['witness-label'],
      created_at: '2026-11-01T15:00:00Z',
      updated_at: '2026-11-02T11:00:00Z',
      comments: [
        {
          id: 'witness-c3',
          author: 'qwen',
          text: 'third comment body',
          created_at: '2026-11-02T09:00:00Z',
        },
      ],
    },
    {
      id: cid('7103'),
      title: 'in review',
      status: 'review',
      priority: null,
      issue_type: 'decision',
      created_at: '2026-11-01T16:00:00Z',
      updated_at: '2026-11-02T12:00:00Z',
      dependencies: [
        {
          issue_id: cid('7103'),
          depends_on_id: cid('7101'),
          type: 'related',
          created_at: '2026-11-01T17:00:00Z',
          created_by: 'qwen',
          metadata: '{}',
        },
      ],
    },
  ];

  const exportText = [
    ...cards.map((c) => JSON.stringify({ _type: 'issue', ...c })),
    JSON.stringify(memory),
  ].join('\n');

  const calls: string[][] = [];
  const run_: BdCommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'bd' && args[1] === 'export' && args[2] === '--all') return exportText;
    throw new Error(`unexpected bd command: ${args.join(' ')}`);
  };

  return {
    prefix,
    boardPath: `/boards/${prefix}`,
    exportText,
    run: run_,
    calls,
    cardIds: cards.map((c) => c.id),
    kinds: {
      '7100': 'task',
      '7100.1': 'bug',
      '7101': 'feature',
      '7102': 'epic',
      '7103': 'decision',
    },
    memory: { key: memory.key, value: memory.value },
  };
}

// The row's jsonb column may come back as a string or an object depending
// on the driver path; the witness reads it as an object either way.
export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) : (value as Record<string, unknown>);
}
