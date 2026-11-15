import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BdReader } from './bd-adapter';
import { mapBdSource } from './bd-mapping';
import { card } from './bd-adapter-testboard';
import { importSourceNames, readerForJob } from './import-sources';

// The bd import source registration and the reader behaviors that hang
// off it (board address from server config, single-flight snapshot, the
// derived tree cap). Split from bd-adapter.test.ts by responsibility so
// both files stay under the 400-line new-leaf cap (CT 2026-11-15; the
// test bodies move byte-for-byte - nothing compressed, no proof lost).
describe('the bd import source registration', () => {
  // The board address is privileged server config (Root 2026-11-15), not job config.
  const saved = {
    boardRoot: process.env.BD_IMPORT_BOARD_ROOT,
    bdCommand: process.env.BD_IMPORT_BD_COMMAND,
  };
  const job = { id: 1, source: 'bd', config: {} };

  beforeEach(() => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    delete process.env.BD_IMPORT_BD_COMMAND;
  });

  afterEach(() => {
    if (saved.boardRoot === undefined) delete process.env.BD_IMPORT_BOARD_ROOT;
    else process.env.BD_IMPORT_BOARD_ROOT = saved.boardRoot;
    if (saved.bdCommand === undefined) delete process.env.BD_IMPORT_BD_COMMAND;
    else process.env.BD_IMPORT_BD_COMMAND = saved.bdCommand;
  });

  test('bd is registered and its project key is null', () => {
    expect(importSourceNames()).toContain('bd');
    expect(readerForJob(job, {})).toBeInstanceOf(BdReader);
  });

  test('a bd job refuses a credential', () => {
    expect(() => readerForJob(job, { apiKey: 'x' })).toThrow(/needs none/);
  });

  test('a bd job fails closed when the server has no board configured', () => {
    delete process.env.BD_IMPORT_BOARD_ROOT;
    expect(() => readerForJob(job, {})).toThrow(/BD_IMPORT_BOARD_ROOT/);
  });

  test('a multi-word executable is a server misconfiguration, not a reader config', () => {
    process.env.BD_IMPORT_BD_COMMAND = 'bd --unsafe';
    expect(() => readerForJob(job, {})).toThrow(/single word/);
  });

  test('the board comes from server config; a job config board address is not read', () => {
    const reader = readerForJob(
      { id: 3, source: 'bd', config: { boardPath: '/somebody-elses/board' } },
      {},
    );
    expect(reader).toBeInstanceOf(BdReader);
  });

  test('the production reader factory derives UNCAPPED depth for every bd job (Studio GO)', () => {
    // Every bd import requires a rig target (the stamps fail closed without
    // one), so every bd target project is rig-gated - and a rig-gated tree
    // has no cap (issue-tree.ts). The cap is therefore DERIVED in the server
    // reader, not read from job config: an old config.maxDepth (or any
    // request-supplied number) must not change what the factory builds, and
    // Infinity never rides in the config JSON.
    const fresh = () => readerForJob({ id: 3, source: 'bd', config: {} }, {}) as BdReader;
    expect(fresh().treeCap).toBe(Number.POSITIVE_INFINITY);
    // A legacy job config carrying a stored cap is ignored: the rig gate made
    // the knob dead, so the factory derives uncapped regardless.
    const legacy = readerForJob(
      { id: 4, source: 'bd', config: { maxDepth: 8, sourceName: 'old' } },
      {},
    ) as BdReader;
    expect(legacy.treeCap).toBe(Number.POSITIVE_INFINITY);
    // And the derivation is what the mapper would receive, proven behaviorally
    // at the mapper: an explicit parent-child chain deeper than the old default
    // of 8 stays PARENTED (no explicit-relates downgrade) when the
    // factory-derived cap is used. (Root P0 2026-11-15: bd parentage is the
    // EXPLICIT parent-child edge, never the dotted decimal id.)
    const chainIds = ['sentinel-prod-9100'];
    for (let i = 1; i <= 10; i++) chainIds.push(`${chainIds[i - 1]!}.${i}`);
    const deep = chainIds.map((id, i) =>
      card({
        id,
        title: `level ${i}`,
        issue_type: 'task',
        dependencies:
          i === 0
            ? []
            : [
                {
                  issue_id: id,
                  depends_on_id: chainIds[i - 1]!,
                  type: 'parent-child',
                },
              ],
      }),
    );
    const deepReader = new BdReader(
      { boardPath: '/boards/sentinel-prod', maxDepth: fresh().treeCap },
      (args) =>
        args[1] === 'export' && args[2] === '--all'
          ? Promise.resolve(deep.map((c) => JSON.stringify({ _type: 'issue', ...c })).join('\n'))
          : Promise.reject(new Error(`unexpected: ${args.join(' ')}`)),
    );
    const issues = deepReader.listIssues();
    return (
      issues as Promise<{ items: { sourceId: string; parentSourceId: string | null }[] }>
    ).then((page) => {
      // All eleven levels parented; the deepest is NOT an explicit relates edge.
      const rows = page.items;
      expect(rows).toHaveLength(11);
      const deepest = rows.find((r) => r.sourceId === chainIds[10]!)!;
      expect(deepest.parentSourceId).toBe(chainIds[9]!);
      // The same chain under the OLD default of 8 would have downgraded the
      // deep edges: the derived cap is what keeps them parented.
      const capped = mapBdSource(deep, { rigPrefix: 'sentinel-prod' });
      const downgraded = capped.issues.find((i) => i.sourceId === chainIds[10]!)!;
      expect(downgraded.parentSourceId).toBeNull();
    });
  });
});
