// Root partition ruling 2026-11-15 (msg_255f9f8ffd51): the retained board
// snapshot is bound into two explicit target project/rig partitions
// (sentinel-prod and b, b-4500 preserved unchanged) through the SAME
// existing production owner. This is the no-database regression for that
// contract:
//  - the pure sibling-set parser (privileged server env, fail-closed),
//  - the pure target-rig acceptance (only the primary or an explicitly
//    declared sibling; the resolver's two trusted queries wrap this, so the
//    refusal needs no database),
//  - both partitions through the same BdReader production class, each fed
//    by ONE synthetic export of the measured `bd export --all` shape. The
//    private retained snapshot is NOT embedded in tracked tests.
// No actual import, no target project or rig created, no real board read,
// no database client loaded or connection attempted.
import { describe, expect, test } from 'bun:test';
import { BdReader } from './bd-adapter';
import { acceptBdPartition, parseBdSiblingRigPrefixes } from './bd-mapping-partitions';

// The board the operator configured (server config, never request input):
// the directory name is the PRIMARY partition prefix.
const BOARD = '/srv/boards/sentinel-prod';
const PRIMARY = 'sentinel-prod';

// --- the synthetic board: the measured `bd export --all` record shapes ---
// (the measured ids are the measured shape: the primary rig carries the
// dotted decimal tokens, the sibling partition carries b-4500 with no edges,
// and an unknown foreign rig is present for the refusal controls)
function issue(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: 'issue',
    id,
    title: `T-${id}`,
    description: 'd',
    status: 'open',
    priority: null,
    issue_type: 'task',
    ...extra,
  };
}

const PARTITION_BOARD: Record<string, unknown>[] = [
  issue('sentinel-prod-100', {
    comments: [{ author: 'a', text: 'hello', created_at: '2026-11-01T00:00:00Z' }],
  }),
  issue('sentinel-prod-100.5', {
    dependencies: [
      {
        issue_id: 'sentinel-prod-100.5',
        depends_on_id: 'sentinel-prod-100',
        type: 'parent-child',
        created_at: '2026-11-01T00:00:00Z',
        created_by: 'a',
      },
    ],
  }),
  issue('sentinel-prod-200', { status: 'closed' }),
  // The preserved sibling card: the measured identity (prefix b, token 4500,
  // no edges). Its source id must come out of the sibling partition UNCHANGED.
  issue('b-4500', { status: 'closed' }),
  { _type: 'memory', key: 'memory-one', value: 'value-one' },
  { _type: 'memory', key: 'memory-two', value: 'value-two' },
];

const FOREIGN_BOARD: Record<string, unknown>[] = [
  issue('sentinel-prod-100'),
  // Outside the entire declared set: the strict mapper must still refuse it.
  issue('foreign-rig-9'),
];

const exportJsonl = (records: Record<string, unknown>[]): string =>
  records.map((r) => JSON.stringify(r)).join('\n');

// One runner per reader that records the exact command args: the partition
// contract is ONE readonly full-board export per reader, the same shape the
// production adapter always issues.
function recordingRunner(records: Record<string, unknown>[]): {
  run: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    run: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(exportJsonl(records));
    },
    calls,
  };
}

// A reader the SAME way the production factory builds one: board address from
// server config, the explicit declared partition set, and the job's own
// partition resolved by the (here-injected) trusted resolver.
function partitionedReader(
  own: string,
  records: Record<string, unknown>[],
): { reader: BdReader; calls: string[][] } {
  const { run, calls } = recordingRunner(records);
  const reader = new BdReader(
    {
      boardPath: BOARD,
      declaredPartitions: [PRIMARY, 'b'],
      resolveOwnPartition: async () => own,
    },
    run,
  );
  return { reader, calls };
}

describe('the explicit sibling partition set (privileged server env, fail-closed)', () => {
  test('an absent or empty value preserves the historical strict single-rig behavior', () => {
    expect(parseBdSiblingRigPrefixes('', PRIMARY)).toEqual([]);
    expect(parseBdSiblingRigPrefixes('   ', PRIMARY)).toEqual([]);
  });

  test('the exact comma-separated list is accepted (this board: b)', () => {
    expect(parseBdSiblingRigPrefixes('b', PRIMARY)).toEqual(['b']);
    expect(parseBdSiblingRigPrefixes('b, c', PRIMARY)).toEqual(['b', 'c']);
  });

  test('an empty entry is refused rather than silently dropped', () => {
    expect(() => parseBdSiblingRigPrefixes('b,,c', PRIMARY)).toThrow(/empty entry/);
    expect(() => parseBdSiblingRigPrefixes('b,', PRIMARY)).toThrow(/empty entry/);
  });

  test('a duplicate declaration is refused', () => {
    expect(() => parseBdSiblingRigPrefixes('b,b', PRIMARY)).toThrow(/more than once/);
  });

  test('the primary partition cannot also be a sibling', () => {
    expect(() => parseBdSiblingRigPrefixes(`${PRIMARY},b`, PRIMARY)).toThrow(/primary partition/);
  });

  test('ambiguous overlapping configured prefixes are refused (a card could carry both)', () => {
    // sentinel is a strict prefix of sentinel-prod, so a sentinel-prod card
    // would carry BOTH configured prefixes.
    expect(() => parseBdSiblingRigPrefixes('sentinel', PRIMARY)).toThrow(/strict prefix/);
    // A genuinely disjoint set is NOT over-refused.
    expect(parseBdSiblingRigPrefixes('c,d', 'bb-x')).toEqual(['c', 'd']);
  });
});

describe('the trusted target binding acceptance (only the primary or a declared sibling)', () => {
  // The resolver (resolveBdJobOwnPartition) resolves the target rig EXCLUSIVELY
  // from job -> import_job.project_id -> project.rig_id -> rig.prefix (the same
  // trusted RIG_FOR_PROJECT query the identity hooks use) and hands the prefix
  // to this pure acceptance - which the regression covers without a database.
  test('a job whose target rig is the primary resolves to the primary', () => {
    expect(acceptBdPartition(PRIMARY, PRIMARY, ['b'])).toBe(PRIMARY);
  });

  test('a job whose target rig is the declared sibling resolves to that sibling', () => {
    expect(acceptBdPartition('b', PRIMARY, ['b'])).toBe('b');
  });

  test('a target rig outside the entire declared set is refused', () => {
    expect(() => acceptBdPartition('x-rig', PRIMARY, ['b'])).toThrow(
      /neither the primary partition sentinel-prod nor a declared sibling \(b\)/,
    );
  });

  test('an empty resolved prefix is refused', () => {
    expect(() => acceptBdPartition('', PRIMARY, ['b'])).toThrow(/empty/);
  });
});

describe('both partitions through the same existing production owner', () => {
  test('the primary partition maps only its own cards and preserves b-4500 (never refused, never renamed)', async () => {
    const { reader, calls } = partitionedReader(PRIMARY, PARTITION_BOARD);
    const page = await reader.listIssues();
    expect(page.items.map((i) => i.sourceId).sort()).toEqual([
      'sentinel-prod-100',
      'sentinel-prod-100.5',
      'sentinel-prod-200',
    ]);
    // b-4500 is PRESERVED for the sibling job: it is not in this snapshot and
    // its presence did not fail the mapping (unlike the historical refusal).
    expect(page.items.some((i) => i.sourceId === 'b-4500')).toBe(false);
    // ONE readonly full-board export, the production command shape.
    expect(calls).toEqual([['bd', 'export', '--all']]);
    expect(reader).toBeInstanceOf(BdReader);
  });

  test('the sibling partition maps exactly b-4500 with its identity unchanged (prefix b, token 4500)', async () => {
    const { reader, calls } = partitionedReader('b', PARTITION_BOARD);
    const page = await reader.listIssues();
    expect(page.items).toHaveLength(1);
    const b = page.items[0]!;
    // The FULL source id is untouched (reconciliation matches it), and the
    // local token the identity owner checks in the title is exactly 4500.
    expect(b.sourceId).toBe('b-4500');
    expect(b.title).toBe('4500: T-b-4500');
    // The sentinel-prod cards are preserved for the primary job.
    const { reader: primary } = partitionedReader(PRIMARY, PARTITION_BOARD);
    expect(await primary.listIssues().then((p) => p.items.map((i) => i.sourceId))).not.toContain(
      'b-4500',
    );
    expect(calls).toEqual([['bd', 'export', '--all']]);
  });

  test('a card outside the entire declared set still refuses the mapping (both partitions)', async () => {
    for (const own of [PRIMARY, 'b']) {
      const { reader } = partitionedReader(own, FOREIGN_BOARD);
      await expect(reader.listIssues()).rejects.toThrow(/rig prefix/);
    }
  });

  test('an unbound reader (no env) keeps the historical strict single-rig behavior: b-4500 refuses', async () => {
    const { run, calls } = recordingRunner(PARTITION_BOARD);
    const reader = new BdReader({ boardPath: BOARD }, run);
    await expect(reader.listIssues()).rejects.toThrow(/rig prefix/);
    expect(calls).toEqual([['bd', 'export', '--all']]);
  });

  test('exact memory ownership: the primary job alone retains the board memories, the sibling its own ticket metadata only', async () => {
    const { reader: primary } = partitionedReader(PRIMARY, PARTITION_BOARD);
    const primaryRows = await primary.listRetainedRows();
    const memoryRows = primaryRows.filter((r) => r.sourceId.startsWith('memory:'));
    expect(memoryRows.map((r) => r.sourceId).sort()).toEqual([
      'memory:memory-one',
      'memory:memory-two',
    ]);
    for (const row of memoryRows) {
      expect(row.retention).toBe('memory_key');
      const key = row.unmapped.find((f) => f.field === 'key')!.value;
      const value = row.unmapped.find((f) => f.field === 'value')!.value;
      expect([key, value]).toEqual(
        row.sourceId === 'memory:memory-one'
          ? ['memory-one', 'value-one']
          : ['memory-two', 'value-two'],
      );
    }
    // The primary retains its own three tickets' metadata.
    expect(
      primaryRows
        .filter((r) => r.retention === 'ticket_metadata')
        .map((r) => r.sourceId)
        .sort(),
    ).toEqual(['sentinel-prod-100', 'sentinel-prod-100.5', 'sentinel-prod-200']);

    const { reader: sibling } = partitionedReader('b', PARTITION_BOARD);
    const siblingRows = await sibling.listRetainedRows();
    // NO memories under the second job's receipt; only b-4500's own metadata.
    expect(siblingRows.filter((r) => r.sourceId.startsWith('memory:'))).toHaveLength(0);
    expect(siblingRows).toHaveLength(1);
    expect(siblingRows[0]!.sourceId).toBe('b-4500');
    expect(siblingRows[0]!.retention).toBe('ticket_metadata');
  });
});
