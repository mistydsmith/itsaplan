import type { CanonicalStateCategory } from './canonical';
import { BdReader, type BdCredential, type BdSourceConfig } from './bd-adapter';
import { bdLocalToken } from './bd-mapping';
import { LinearReader, type LinearCredential } from './linear-adapter';
import { PlaneReader, type PlaneCredential } from './plane-adapter';
import { TrelloReader, type TrelloCredential } from './trello-adapter';
import type { CanonicalRetainedRow, SourceReader } from './reader';
import {
  RIG_FOR_PROJECT,
  parseBdSiblingRigPrefixes,
  resolveBdJobOwnPartition,
} from './bd-mapping-partitions';
import { importBeadIdentity } from '@repo/db/bead-import-identity';
import type { IdentityTransaction } from '@repo/db/issue-identity';

// The import_job.config fields every source shares; the phases read them directly.
export interface CommonImportConfig {
  unmatchedUserPolicy?: 'unassigned' | 'skip';
  stateOverrides?: Record<string, CanonicalStateCategory>;
}

export interface PlaneImportConfig extends CommonImportConfig {
  planeProjectId: string;
  // Absent on a job created before the Rewrite phase existed; Rewrite then leaves text as written.
  planeProjectKey?: string;
}

export interface LinearImportConfig extends CommonImportConfig {
  teamId: string;
  // The team's issue-key prefix ("ATO" in "ATO-505") for Rewrite.
  teamKey: string;
  // One job imports one project of the team, or the team's issues with no project.
  projectFilter: 'project' | 'none';
  projectId: string | null;
}

export interface TrelloImportConfig extends CommonImportConfig {
  boardId: string;
  archivedCards: 'archive' | 'skip';
  // Trello member id -> the email of the project member the user matched it with.
  memberEmails?: Record<string, string>;
}

export interface BdImportConfig extends CommonImportConfig {
  // The target's tree cap (issue-tree.ts); omit on a rig-gated project, which is uncapped.
  maxDepth?: number;
  sourceName?: string;
}

// WHY the board address is read from the server, not the job config
// (Root, 8363.1 decision, 2026-11-15): the api no longer stores a board path or an
// executable name in an untrusted job body - they are privileged server config, the
// same two variables the api's connection handler verifies (apps/api/src/modules/
// import-export/bd.ts). A job whose server has no board configured fails closed here;
// it can never name a path it wants read or a command it wants run.
const BD_IMPORT_ENV = {
  boardRoot: 'BD_IMPORT_BOARD_ROOT',
  bdCommand: 'BD_IMPORT_BD_COMMAND',
  // The board's OTHER declared rig prefixes (Root partition ruling 2026-11-15),
  // exact comma-separated list; the primary is always the board directory name.
  siblingRigPrefixes: 'BD_IMPORT_SIBLING_RIG_PREFIXES',
} as const;

export interface ImportSourceDefinition<Credential, Config> {
  buildReader(credential: Credential, config: Partial<Config>, jobId: number): SourceReader;
  // The prefix of the source's own issue identifiers ("ROOMS" in "ROOMS-524").
  projectKey(config: Partial<Config>): string | null;
  // An optional source-specific stamp, invoked by the existing Create phase
  // (createLocalIssueAndRecord, import-store.ts) INSIDE the import's own transaction,
  // after the local row and its import_record mapping are written, so it commits or
  // rolls back with them (Root, 8363.1 pipeline decision, 2026-11-15: no second
  // importstore, no forked pipeline, no after-commit stamp). bd uses this to stamp its
  // bead identity; every other source keeps no hook.
  afterIssueCreated?(
    tx: IdentityTransaction,
    context: { jobId: number; sourceId: string; projectId: number; localId: number },
  ): Promise<void>;
  // An optional source-specific stamp for the source's NON-TICKET rows, invoked by
  // the existing Create phase (recordRetainedRows, import-worker.ts) inside one
  // import transaction, after the last issue chunk (Root, 8363.1 retained-row seam,
  // 2026-11-15: same seam, same transaction discipline, no after-commit stamp). bd
  // stamps a tombstone bead identity (issueId null) per row; every other source
  // keeps no hook.
  afterRetainedRow?(
    tx: IdentityTransaction,
    context: { jobId: number; sourceId: string; projectId: number; row: CanonicalRetainedRow },
  ): Promise<void>;
}

type StoredSourceDefinition = ImportSourceDefinition<unknown, unknown>;

// A real bd card id is <rig-prefix>-<token> (the repo name is the rig name: the rig
// 'sentinel-prod' holds the card 'sentinel-prod-8363.1'). The @repo/db writer builds
// the bead id as `${prefix}-${localToken}`, so the ledger's local token is the card's
// number WITHIN its rig, and the full source id only ever rides the import mapping
// (import_record.source_id). Passing the full id through as the token would make the
// writer prefix it again (sentinel-prod-sentinel-prod-8363.1) and hide the numeric
// root 8363 from the counter; requiring the exact prefix match keeps a card from one
// board from ever stamping into another rig's ledger (Office RETURN3 D1, 8363.1).
// One derivation, shared with the mapper's title/sequence binding (bdLocalToken,
// bd-mapping.ts) - the pinned identity owner's <prefix>- semantics.
const beadLocalToken = bdLocalToken;

// One entry per import_job.source. A build adds its own sources before the worker starts.
const IMPORT_SOURCES = new Map<string, StoredSourceDefinition>();

export function registerImportSource<Credential, Config>(
  source: string,
  definition: ImportSourceDefinition<Credential, Config>,
): void {
  if (IMPORT_SOURCES.has(source)) {
    throw new Error(`import source "${source}" is already registered`);
  }
  IMPORT_SOURCES.set(source, definition as unknown as StoredSourceDefinition);
}

registerImportSource<PlaneCredential, PlaneImportConfig>('plane', {
  buildReader(credential, config, jobId) {
    if (!config.planeProjectId) {
      throw new Error(`import job ${jobId} has no source project configured`);
    }
    return new PlaneReader(credential, config.planeProjectId);
  },
  projectKey: (config) => config.planeProjectKey ?? null,
});

registerImportSource<LinearCredential, LinearImportConfig>('linear', {
  buildReader(credential, config, jobId) {
    // The registry types do not tie a decrypted credential to its job's source.
    // Exactly { apiKey }: a Plane credential also has an apiKey, plus baseUrl and workspaceSlug.
    const keys = credential && typeof credential === 'object' ? Object.keys(credential) : [];
    if (keys.length !== 1 || typeof credential.apiKey !== 'string' || credential.apiKey === '') {
      throw new Error(`import job ${jobId} has a credential that is not a Linear API key`);
    }
    const { teamId, projectFilter, projectId } = config;
    if (!teamId || !(projectFilter === 'none' || (projectFilter === 'project' && projectId))) {
      throw new Error(`import job ${jobId} has no source project configured`);
    }
    return new LinearReader(credential, {
      teamId,
      projectFilter,
      projectId: projectFilter === 'project' ? (projectId ?? null) : null,
    });
  },
  projectKey: (config) => config.teamKey ?? null,
});

registerImportSource<TrelloCredential, TrelloImportConfig>('trello', {
  buildReader(credential, config, jobId) {
    const keys = credential && typeof credential === 'object' ? Object.keys(credential) : [];
    const isTrello =
      keys.length === 2 &&
      typeof credential.apiKey === 'string' &&
      credential.apiKey !== '' &&
      typeof credential.token === 'string' &&
      credential.token !== '';
    if (!isTrello) {
      throw new Error(`import job ${jobId} has a credential that is not a Trello key and token`);
    }
    const { boardId, archivedCards } = config;
    if (!boardId || (archivedCards !== 'archive' && archivedCards !== 'skip')) {
      throw new Error(`import job ${jobId} has no source board configured`);
    }
    return new TrelloReader(credential, {
      boardId,
      archivedCards,
      memberEmails: config.memberEmails ?? {},
    });
  },
  // A Trello card has no key-style identifier; another card is referred to by its URL.
  projectKey: () => null,
});

// A local bd board: no credential, and the board address is not job config either -
// the board root and the bd executable are privileged server config (Root 2026-11-15;
// the reader is built from BD_IMPORT_BOARD_ROOT / BD_IMPORT_BD_COMMAND and fails
// closed when the server has no board configured). No attachments, no cycles, no
// custom fields. The reader shells out read-only to bd once per tick (bd-adapter.ts);
// the phases do not change.
// The bd tree cap the PRODUCTION reader derives (Studio 2026-11-15 GO): every bd
// import requires a rig target - the after-issue-created and retained-row stamps
// fail closed without one - so every bd target project is rig-gated, and a
// rig-gated project's tree has NO cap (issue-tree.ts reads under lock with no
// depth check when rig_id is set). The cap is therefore derived HERE, server
// side, as uncapped: it is never stored in job.config and never serialized to
// JSON (Infinity is not valid JSON). A job config that carries an old maxDepth
// is ignored - the control it came from was a dead knob once the rig gate made
// every bd target uncapped. The pure mapper keeps its default of 8 for ordinary
// unit use without a rig context.
export function bdImportTreeCap(): number {
  return Number.POSITIVE_INFINITY;
}

registerImportSource<BdCredential, BdImportConfig>('bd', {
  buildReader(credential, config, jobId) {
    const keys = credential && typeof credential === 'object' ? Object.keys(credential) : [];
    if (keys.length !== 0) {
      throw new Error(`import job ${jobId} has a credential, but a bd board needs none`);
    }
    const { sourceName } = config;
    const boardPath = (process.env[BD_IMPORT_ENV.boardRoot] ?? '').trim().replace(/\/+$/, '');
    if (!boardPath.startsWith('/')) {
      throw new Error(
        `import job ${jobId} cannot run: bd import is not configured on this server; ` +
          `the operator must set ${BD_IMPORT_ENV.boardRoot} to the board directory`,
      );
    }
    const bdCommand = (process.env[BD_IMPORT_ENV.bdCommand] ?? '').trim() || 'bd';
    if (!/^\S+$/.test(bdCommand)) {
      throw new Error(
        `import job ${jobId} cannot run: ${BD_IMPORT_ENV.bdCommand} must be a single word with no whitespace`,
      );
    }
    // Derived, not config: the rig gate makes every bd target uncapped, so the
    // reader maps the full source depth. (An old config.maxDepth is dropped -
    // it no longer does anything, and Infinity never rides in job config JSON.)
    const source: BdSourceConfig = {
      boardPath,
      bdCommand,
      maxDepth: bdImportTreeCap(),
      sourceName,
    };
    // The explicit partition binding (Root partition ruling 2026-11-15): the
    // sibling set is privileged server env in the same trust class as the
    // board address, validated fail-closed; the job's own partition is
    // resolved trusted from its target project's rig at first snapshot. An
    // absent env value leaves the reader on the historical strict single-rig
    // behavior (own = the board directory name, every other prefix foreign).
    const boardDir = boardPath.split('/').filter(Boolean).pop() ?? '';
    const siblingRigPrefixes = parseBdSiblingRigPrefixes(
      process.env[BD_IMPORT_ENV.siblingRigPrefixes] ?? '',
      boardDir,
    );
    if (siblingRigPrefixes.length > 0) {
      source.declaredPartitions = [boardDir, ...siblingRigPrefixes];
      source.resolveOwnPartition = () =>
        resolveBdJobOwnPartition(jobId, boardDir, siblingRigPrefixes);
    }
    return new BdReader(source);
  },
  // The bead identity stamp (Root pipeline decision, 2026-11-15): inside the import's
  // own transaction, after the row exists, attaching the card's rig token to the
  // ledger and the issue - the writer re-prefixes it, so the stamped bead id is
  // exactly the original bd id, and the full source id stays in the import mapping.
  // A project without a rig cannot hold a bead identity, so a bd import
  // into one fails closed; a refused stamp fails the whole transaction, never a
  // partial identity.
  afterIssueCreated: async (tx, { sourceId, projectId, localId }) => {
    const rows = (await tx.execute(RIG_FOR_PROJECT(projectId))) as unknown as {
      rig_id: number;
      prefix: string;
    }[];
    const rig = rows[0];
    if (!rig) {
      throw new Error(
        `bd import ${sourceId}: project ${projectId} has no rig, so its bead identity cannot be stamped`,
      );
    }
    const result = await importBeadIdentity(tx, {
      rigId: Number(rig.rig_id),
      localToken: beadLocalToken(rig.prefix, sourceId),
      issueId: localId,
    });
    if (!result.ok) {
      throw new Error(
        `bd import ${sourceId}: bead identity refused (${result.code}): ${result.message}`,
      );
    }
  },
  // The retained-row half of the same seam: a memory/note row never becomes an
  // issue; it becomes a tombstone ledger row (issue_id NULL), the durable record
  // that the row was imported and deliberately kept non-ticket.
  afterRetainedRow: async (tx, { sourceId, projectId, row }) => {
    // Studio 2026-11-15: only TRUE non-ticket rows stamp a tombstone. A real
    // ticket's ticket_metadata row rides the same durable sink for its source
    // values, but the ticket's own identity is already on its issue - a second
    // ledger row or an issue_id-null stamp here would be a second truth.
    if (row.retention !== 'tombstone_identity') return;
    const rows = (await tx.execute(RIG_FOR_PROJECT(projectId))) as unknown as {
      rig_id: number;
      prefix: string;
    }[];
    const rig = rows[0];
    if (!rig) {
      throw new Error(
        `bd import ${sourceId}: project ${projectId} has no rig, so its tombstone identity cannot be stamped`,
      );
    }
    const result = await importBeadIdentity(tx, {
      rigId: Number(rig.rig_id),
      localToken: beadLocalToken(rig.prefix, sourceId),
      issueId: null,
    });
    if (!result.ok) {
      throw new Error(
        `bd import ${sourceId}: tombstone identity refused (${result.code}): ${result.message}`,
      );
    }
  },
  // bd ids are dotted numbers, not a key-style identifier; cross-references use
  // the numeric head (Rewrite), not a project key.
  projectKey: () => null,
});

// The sources this build reads.
export function importSourceNames(): string[] {
  return [...IMPORT_SOURCES.keys()];
}

export interface ImportJobSource {
  id: number;
  source: string;
  config: Record<string, unknown>;
}

function definitionOf(job: ImportJobSource): StoredSourceDefinition {
  const definition = IMPORT_SOURCES.get(job.source);
  if (!definition) throw new Error(`import job ${job.id} has unsupported source "${job.source}"`);
  return definition;
}

export function readerForJob(job: ImportJobSource, credential: unknown): SourceReader {
  return definitionOf(job).buildReader(credential, job.config, job.id);
}

export function sourceProjectKeyForJob(job: ImportJobSource): string | null {
  return definitionOf(job).projectKey(job.config);
}

// The source's after-issue-created stamp, if it has one. The worker passes it to
// createLocalIssueAndRecord so it runs inside that function's transaction; sources
// without a hook return null and the row lands exactly as before.
export function afterIssueCreatedForJob(
  job: ImportJobSource,
):
  | ((
      tx: IdentityTransaction,
      context: { jobId: number; sourceId: string; projectId: number; localId: number },
    ) => Promise<void>)
  | null {
  return definitionOf(job).afterIssueCreated ?? null;
}

// The source's retained-row stamp, if it has one (bd: the tombstone); the worker
// runs it inside one import transaction after the last issue chunk.
export function afterRetainedRowForJob(
  job: ImportJobSource,
):
  | ((
      tx: IdentityTransaction,
      context: { jobId: number; sourceId: string; projectId: number; row: CanonicalRetainedRow },
    ) => Promise<void>)
  | null {
  return definitionOf(job).afterRetainedRow ?? null;
}
