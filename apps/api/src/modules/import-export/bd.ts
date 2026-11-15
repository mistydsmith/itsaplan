import { execFile } from 'node:child_process';
import { HttpError } from '#shared/lib';
import { requireGod, type AuthUser } from '#shared/access';

// WHY the board path and the bd executable come from the server, not the request
// (Root, 8363.1 decision, 2026-11-15): a board path and an executable name are
// privileged - an untrusted API body naming either could read any directory the
// server user can reach or run any command. The operator freezes them in server
// config; the API surface accepts no path and no command. A bd job imports the
// ONE board this server is configured to read. The worker reads the same
// variables when it builds the reader (apps/worker/src/import-sources.ts).

type StateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export const BD_IMPORT_ENV = {
  // Absolute path of the directory whose .beads store is the source board.
  boardRoot: 'BD_IMPORT_BOARD_ROOT',
  // The bd executable. Defaults to bd on PATH.
  bdCommand: 'BD_IMPORT_BD_COMMAND',
} as const;

export interface BdBoardConfig {
  boardPath: string;
  bdCommand: string;
}

export function bdBoardConfig(env: NodeJS.ProcessEnv = process.env): BdBoardConfig {
  const boardPath = (env[BD_IMPORT_ENV.boardRoot] ?? '').trim();
  if (!boardPath.startsWith('/')) {
    throw new HttpError(
      400,
      `bd import is not configured on this server; the operator must set ${BD_IMPORT_ENV.boardRoot} to the board directory`,
    );
  }
  const bdCommand = (env[BD_IMPORT_ENV.bdCommand] ?? '').trim() || 'bd';
  if (!/^\S+$/.test(bdCommand)) {
    throw new HttpError(500, `${BD_IMPORT_ENV.bdCommand} must be a single word with no whitespace`);
  }
  return { boardPath: boardPath.replace(/\/+$/, ''), bdCommand };
}

export type BdCommandRunner = (boardPath: string, args: string[]) => Promise<string>;

// The full-export bound (Root P0 2026-11-15, D2 R2): the export JSONL is the
// ONLY complete snapshot - every issue kind, closed included. 256MiB holds
// the measured board with room.
const EXPORT_MAX_BUFFER = 256 * 1024 * 1024;

const defaultBdRunner: BdCommandRunner = (boardPath, args) =>
  new Promise((resolve, reject) => {
    execFile(
      args[0],
      args.slice(1),
      { cwd: boardPath, maxBuffer: EXPORT_MAX_BUFFER },
      (err, stdout) => {
        if (err)
          reject(new HttpError(400, `the bd board at ${boardPath} cannot be read: ${err.message}`));
        else resolve(stdout);
      },
    );
  });

// The bd board is SERVER-GLOBAL private data (Root, D2 R2): its path is
// operator config, but its contents belong to no project, so a bd-source
// operation needs the instance operator ('god') IN ADDITION TO the project's
// import_export permission. Reuses the existing instance-owner guard; 403
// before any bd command runs.
export function requireBdOperator(user: AuthUser | undefined | null): AuthUser {
  return requireGod(user);
}

// Resume restarts the bd export for a stored bd job: the STORED job source
// (not any body claim) decides whether the operator guard applies. Other
// sources resume unchanged; pause/cancel have no extra gate (Root 2026-11-15).
export function requireBdResumeOperator(
  user: AuthUser | undefined | null,
  storedSource: string | null | undefined,
): void {
  if (storedSource === 'bd') requireBdOperator(user);
}

// A stored bd lastError can name the server-global board id, path or command.
// list/get readers who are not the operator get this fixed sentence instead;
// the operator reads the stored text. null stays null; other sources are
// untouched (Root 2026-11-15).
export const BD_JOB_ERROR_REDACTED = 'A bd import step failed; ask the operator for the details.';

export function redactBdJobError<T extends { source: string; lastError: string | null }>(
  job: T,
  user: AuthUser | undefined | null,
): T {
  if (job.lastError == null || job.source !== 'bd' || user?.role === 'god') return job;
  return { ...job, lastError: BD_JOB_ERROR_REDACTED };
}

// The same two tables the worker mapping owns (apps/worker/src/bd-mapping.ts): the
// state NAME preserves the source status, the category is the coarse mapping. The
// api does not depend on the worker package, so the small mapping is repeated here,
// the way listCategory in trello.ts mirrors trello-mapping.ts.
const STATUS_CATEGORY: Record<string, StateCategory> = {
  open: 'unstarted',
  queued: 'backlog',
  in_progress: 'started',
  blocked: 'started',
  review: 'started',
  deferred: 'backlog',
  closed: 'completed',
};

const STATUS_NAME: Record<string, string> = {
  open: 'Open',
  queued: 'Queued',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  review: 'Review',
  deferred: 'Deferred',
  closed: 'Closed',
};

export interface BdStateOption {
  id: string;
  name: string;
  category: StateCategory;
}

interface BdCardRow {
  id: string;
  status: string;
}

function boardNameOf(boardPath: string): string {
  return boardPath.split('/').filter(Boolean).pop() ?? boardPath;
}

// The SAME full-board export contract the worker adapter reads (bd-adapter.ts
// is the mirror; the api does not depend on the worker package, so the parse
// is repeated here, like the status tables above). ONE readonly
// `bd export --all`, JSONL: every _type:'issue' record is a card regardless of
// kind or status (closed counted); _type:'memory' is the only non-issue kind
// and is skipped (retained rows, never cards); any other _type, a non-object
// record, or a non-JSON line fails closed with a 400 naming the line.
async function bdBoardExport(config: BdBoardConfig, runner: BdCommandRunner): Promise<BdCardRow[]> {
  const out = await runner(config.boardPath, [config.bdCommand, 'export', '--all']);
  const cards: BdCardRow[] = [];
  for (const [i, line] of out.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new HttpError(
        400,
        `the bd board at ${config.boardPath} returned a non-JSON export line ${i + 1}; the tick fails closed`,
      );
    }
    // JSON.parse also accepts null, arrays and primitives: a board record is a
    // plain object, so anything else is refused with its shape named.
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      const shape =
        value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
      throw new HttpError(
        400,
        `the bd board at ${config.boardPath} returned ${shape} as export record line ${i + 1}; refusing`,
      );
    }
    const record = value as Record<string, unknown>;
    if (record._type === 'issue') {
      const card = record as { id?: unknown; status?: unknown };
      if (typeof card.id !== 'string' || !card.id) {
        throw new HttpError(
          400,
          `the bd board at ${config.boardPath} returned an issue record without an id at export line ${i + 1}; refusing`,
        );
      }
      if (typeof card.status !== 'string' || !card.status) {
        throw new HttpError(
          400,
          `the bd board at ${config.boardPath} returned an issue record without a status at export line ${i + 1}; refusing`,
        );
      }
      cards.push({ id: card.id, status: card.status });
    } else if (record._type === 'memory') {
      // Dolt memory records: retained rows in the worker, never cards here.
      // The SAME key contract the worker enforces: a memory without a
      // nonempty string key is refused, not silently skipped (Root 2026-11-15).
      const mem = record as { key?: unknown };
      if (typeof mem.key !== 'string' || !mem.key) {
        throw new HttpError(
          400,
          `the bd board at ${config.boardPath} returned a memory record without a key at export line ${i + 1}; refusing`,
        );
      }
      continue;
    } else {
      // A future bd revision with a new _type fails closed rather than being
      // silently dropped: the contract is issues AND memories, nothing else.
      throw new HttpError(
        400,
        `the bd board at ${config.boardPath} returned an unknown record _type (${String(record._type)}) at export line ${i + 1}; refusing rather than dropping it`,
      );
    }
  }
  return cards;
}

function statesOf(cards: BdCardRow[]): BdStateOption[] {
  const seen = new Set<string>();
  for (const card of cards) seen.add(card.status);
  return [...seen].sort().map((status) => ({
    id: `status:${status}`,
    name: STATUS_NAME[status] ?? status,
    category: STATUS_CATEGORY[status] ?? 'unstarted',
  }));
}

// Confirms the configured board is readable before anything is stored, and shows
// the states the import would create - one named state per source status, no folding.
export async function testBdConnection(
  runner: BdCommandRunner = defaultBdRunner,
): Promise<{ board: string; cards: number; states: BdStateOption[] }> {
  const config = bdBoardConfig();
  const cards = await bdBoardExport(config, runner);
  return { board: boardNameOf(config.boardPath), cards: cards.length, states: statesOf(cards) };
}

// The configured board's states and card count: what the connect form shows before
// a job is created.
export async function previewBdBoard(
  runner: BdCommandRunner = defaultBdRunner,
): Promise<{ cards: number; states: BdStateOption[] }> {
  const config = bdBoardConfig();
  const cards = await bdBoardExport(config, runner);
  return { cards: cards.length, states: statesOf(cards) };
}

// What createImportJob stores for a bd job: no credential and no board address -
// the board is server config, and the worker's registration refuses a non-empty
// credential. Only the display name the operator made at creation time. (The
// tree cap is NOT a job choice: every bd import requires a rig target, so the
// server reader derives it uncapped - the maxDepth knob was removed as a dead
// control, Studio 2026-11-15 GO.)
export interface CreateBdImportJobInput {
  source: 'bd';
  sourceName?: string;
}

export function bdJobFields(input: CreateBdImportJobInput) {
  const sourceName = input.sourceName?.trim();
  return {
    source: 'bd' as const,
    credential: {},
    config: {
      ...(sourceName !== undefined && sourceName !== '' ? { sourceName } : {}),
    },
  };
}
