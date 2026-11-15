import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HttpError } from '#shared/lib';
import {
  BD_JOB_ERROR_REDACTED,
  bdBoardConfig,
  bdJobFields,
  previewBdBoard,
  redactBdJobError,
  requireBdOperator,
  requireBdResumeOperator,
  testBdConnection,
  type BdCommandRunner,
} from '../../bd';

const runWith =
  (stdout: string, calls: string[][] = []): BdCommandRunner =>
  async (cwd, args) => {
    calls.push([cwd, ...args]);
    return stdout;
  };

// The measured `bd export --all` JSONL shape: every _type:'issue' record is a
// card regardless of kind or status (closed included), and the ONE non-issue
// record kind is _type:'memory' (a retained row, never a card).
const EXPORT = [
  { _type: 'issue', id: 'sentinel-prod-1', status: 'open' },
  { _type: 'issue', id: 'sentinel-prod-2', status: 'in_progress' },
  { _type: 'issue', id: 'sentinel-prod-3', status: 'closed' },
  { _type: 'issue', id: 'sentinel-prod-4', status: 'weird_new_status' },
  { _type: 'memory', key: 'lane-preference', value: 'use bun, not npm' },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

describe('bd connection (server-configured board, full-export contract)', () => {
  const saved = {
    boardRoot: process.env.BD_IMPORT_BOARD_ROOT,
    bdCommand: process.env.BD_IMPORT_BD_COMMAND,
  };

  beforeEach(() => {
    delete process.env.BD_IMPORT_BOARD_ROOT;
    delete process.env.BD_IMPORT_BD_COMMAND;
  });

  afterEach(() => {
    if (saved.boardRoot === undefined) delete process.env.BD_IMPORT_BOARD_ROOT;
    else process.env.BD_IMPORT_BOARD_ROOT = saved.boardRoot;
    if (saved.bdCommand === undefined) delete process.env.BD_IMPORT_BD_COMMAND;
    else process.env.BD_IMPORT_BD_COMMAND = saved.bdCommand;
  });

  test('refuses with a clear message when the server has no bd board configured', async () => {
    await expect(testBdConnection(runWith(EXPORT))).rejects.toThrow(/BD_IMPORT_BOARD_ROOT/);
    // The preview route refuses the same way, and no command was attempted.
    const calls: string[][] = [];
    await expect(previewBdBoard(runWith(EXPORT, calls))).rejects.toThrow(/not configured/);
    expect(calls).toEqual([]);
  });

  test('a relative board root is not a configured board', () => {
    process.env.BD_IMPORT_BOARD_ROOT = 'relative/board';
    expect(() => bdBoardConfig()).toThrow(/BD_IMPORT_BOARD_ROOT/);
  });

  test('ONE full export read, all kinds counted, closed included, memory skipped', async () => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod/';
    const calls: string[][] = [];
    const out = await testBdConnection(runWith(EXPORT, calls));

    // FOUR cards: the old list read saw only the ~320 open cards on the
    // measured board; the full export counts every issue kind, closed included.
    expect(out).toEqual({
      board: 'sentinel-prod',
      cards: 4,
      states: [
        { id: 'status:closed', name: 'Closed', category: 'completed' },
        { id: 'status:in_progress', name: 'In Progress', category: 'started' },
        { id: 'status:open', name: 'Open', category: 'unstarted' },
        { id: 'status:weird_new_status', name: 'weird_new_status', category: 'unstarted' },
      ],
    });
    // The SAME one command the worker adapter runs: a readonly full-board
    // export, in the configured board, with the default bd executable and no
    // body-sourced argument anywhere. The memory record is not a card.
    expect(calls).toEqual([['/srv/boards/sentinel-prod', 'bd', 'export', '--all']]);
  });

  test('an operator-set bd executable is used, and a multi-word one is a server error', async () => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    process.env.BD_IMPORT_BD_COMMAND = 'bd-classic';
    const calls: string[][] = [];
    await testBdConnection(runWith(EXPORT, calls));
    expect(calls[0]).toEqual(['/srv/boards/sentinel-prod', 'bd-classic', 'export', '--all']);

    process.env.BD_IMPORT_BD_COMMAND = 'bd --unsafe';
    await expect(testBdConnection(runWith(EXPORT))).rejects.toThrow(/single word/);
  });

  test('an unknown record _type is refused with a 400 naming it, not dropped', async () => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    const foreign = `${EXPORT}\n${JSON.stringify({ _type: 'bead', id: 'sentinel-prod-9' })}`;
    await expect(previewBdBoard(runWith(foreign))).rejects.toThrow(/unknown record _type \(bead\)/);
  });

  test('a non-JSON export line and an id-less issue record fail closed', async () => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    await expect(previewBdBoard(runWith('not json at all'))).rejects.toThrow(
      /non-JSON export line/,
    );
    const noId = `${EXPORT}\n${JSON.stringify({ _type: 'issue', status: 'open' })}`;
    await expect(previewBdBoard(runWith(noId))).rejects.toThrow(/without an id/);
    const noStatus = `${EXPORT}\n${JSON.stringify({ _type: 'issue', id: 'sentinel-prod-5' })}`;
    await expect(previewBdBoard(runWith(noStatus))).rejects.toThrow(/without a status/);
  });

  test('null, array and primitive export records are refused with the line named', async () => {
    // JSON.parse accepts all of these: a board record is a plain object, so
    // each shape is refused with a 400 naming the line, before any _type
    // dereference.
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    const shapes: [string, string][] = [
      ['null', 'null'],
      ['an array', '[]'],
      ['a boolean', 'true'],
      ['a string', '"just a string"'],
    ];
    for (const [shape, text] of shapes) {
      await expect(previewBdBoard(runWith(`${EXPORT}\n${text}`))).rejects.toThrow(
        new RegExp(`returned ${shape} as export record line 6`),
      );
    }
  });

  test('a memory record without a nonempty string key is refused, like the worker', async () => {
    // The worker fails the tick on a keyless memory; the api must refuse with
    // the line named instead of silently skipping a malformed record.
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    await expect(
      previewBdBoard(runWith(`${EXPORT}\n${JSON.stringify({ _type: 'memory', value: 'no key' })}`)),
    ).rejects.toThrow(/memory record without a key at export line 6/);
    await expect(
      previewBdBoard(
        runWith(`${EXPORT}\n${JSON.stringify({ _type: 'memory', key: '', value: 'empty' })}`),
      ),
    ).rejects.toThrow(/memory record without a key at export line 6/);
    await expect(
      previewBdBoard(
        runWith(`${EXPORT}\n${JSON.stringify({ _type: 'memory', key: 7, value: 'not a string' })}`),
      ),
    ).rejects.toThrow(/memory record without a key at export line 6/);
    // a valid memory record is still skipped, never a card
    const out = await previewBdBoard(runWith(EXPORT));
    expect(out.cards).toBe(4);
    expect(out.states.map((s) => s.id)).toEqual([
      'status:closed',
      'status:in_progress',
      'status:open',
      'status:weird_new_status',
    ]);
  });

  test('the preview shows the configured board states and count', async () => {
    process.env.BD_IMPORT_BOARD_ROOT = '/srv/boards/sentinel-prod';
    const out = await previewBdBoard(runWith(EXPORT));
    expect(out.cards).toBe(4);
    expect(out.states.map((s) => s.id)).toEqual([
      'status:closed',
      'status:in_progress',
      'status:open',
      'status:weird_new_status',
    ]);
  });
});

describe('bd operator guard (server-global board boundary, D2 R2)', () => {
  test('a non-operator is refused with a 403 BEFORE any bd command can run', () => {
    // The pure guard: the route handlers call this first; on a non-god session
    // it throws, so neither the project permission check's result nor a bd
    // command ever moves - zero commands, zero board bytes.
    const err = (() => {
      try {
        requireBdOperator({ id: 'u1', email: 'owner@example.invalid', role: 'user' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toMatch(/owner-only/);
  });

  test('no session at all is a 401, not a board read', () => {
    expect(() => requireBdOperator(null)).toThrow(/Authentication required/);
  });

  test('the instance operator is allowed', () => {
    const u = requireBdOperator({ id: 'op', email: 'operator@example.invalid', role: 'god' });
    expect(u.id).toBe('op');
  });

  // Resume restarts the bd export: the STORED job source (not a body claim)
  // triggers the operator guard. pause/cancel and other sources are untouched.
  test('a stored bd source refuses a non-operator with a 403 before any command', () => {
    expect(() =>
      requireBdResumeOperator({ id: 'u1', email: 'owner@example.invalid', role: 'user' }, 'bd'),
    ).toThrow(/owner-only/);
  });

  test('a stored bd source with no session is a 401', () => {
    expect(() => requireBdResumeOperator(null, 'bd')).toThrow(/Authentication required/);
  });

  test('a stored bd source allows the operator and is silent for other sources', () => {
    expect(
      requireBdResumeOperator({ id: 'op', email: 'operator@example.invalid', role: 'god' }, 'bd'),
    ).toBeUndefined();
    for (const source of ['plane', 'linear', 'trello', null, undefined]) {
      expect(() =>
        requireBdResumeOperator({ id: 'u1', email: 'owner@example.invalid', role: 'user' }, source),
      ).not.toThrow();
    }
  });
});

describe('bd lastError redaction (server-global board details, list/get)', () => {
  const job = {
    id: 7,
    source: 'bd',
    lastError: 'bd board /srv/boards/sentinel-prod export failed: board id 42',
  } as { id: number; source: string; lastError: string | null };
  const editor = { id: 'u1', email: 'owner@example.invalid', role: 'user' };
  const operator = { id: 'op', email: 'operator@example.invalid', role: 'god' };

  test('a non-operator reader gets the fixed sentence, never the stored text', () => {
    const out = redactBdJobError(job, editor);
    expect(out.lastError).toBe(BD_JOB_ERROR_REDACTED);
    expect(out.lastError).not.toMatch(/srv\/boards|board id 42/);
    // status/progress/other fields are preserved untouched
    expect(out.id).toBe(7);
    expect(out.source).toBe('bd');
  });

  test('the operator reads the stored lastError', () => {
    expect(redactBdJobError(job, operator).lastError).toBe(job.lastError);
  });

  test('a null lastError stays null for everyone and other sources are untouched', () => {
    const clean = { ...job, lastError: null };
    expect(redactBdJobError(clean, editor).lastError).toBeNull();
    const plane = { ...job, source: 'plane', lastError: 'plane 500' };
    expect(redactBdJobError(plane, editor).lastError).toBe('plane 500');
    // no session at all still reads (project permission owns access)
    expect(redactBdJobError(job, null).lastError).toBe(BD_JOB_ERROR_REDACTED);
  });
});

describe('bdJobFields stores no credential and no board address', () => {
  test('a bare bd job stores empty credential and config', () => {
    expect(bdJobFields({ source: 'bd' })).toEqual({ source: 'bd', credential: {}, config: {} });
  });

  test('the mapping choices are trimmed and stored, nothing else', () => {
    // The tree cap is no longer a job choice (every bd import is rig-targeted,
    // so the server reader derives it uncapped): a stray maxDepth is not a
    // field of the input type and nothing about it is stored.
    expect(bdJobFields({ source: 'bd', sourceName: '  Sentinel beads  ' })).toEqual({
      source: 'bd',
      credential: {},
      config: { sourceName: 'Sentinel beads' },
    });
    expect(bdJobFields({ source: 'bd', sourceName: '   ' })).toEqual({
      source: 'bd',
      credential: {},
      config: {},
    });
  });
});
