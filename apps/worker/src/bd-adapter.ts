import { execFile } from 'node:child_process';
import { mapBdComments, mapBdSource, type BdCardView, type BdSourceSnapshot } from './bd-mapping';
import { partitionBdCards } from './bd-mapping-partitions';
import type {
  CanonicalAttachment,
  CanonicalChecklist,
  CanonicalComment,
  CanonicalCustomField,
  CanonicalCycle,
  CanonicalIssue,
  CanonicalIssueType,
  CanonicalLabel,
  CanonicalRelation,
  CanonicalState,
} from './canonical';
import type {
  AttachmentDownload,
  CanonicalRetainedRow,
  Page,
  SourceProject,
  SourceReader,
} from './reader';

// The unmapped-port note for a retained row's source content. Exported so the
// no-DB proofs can assert the exact bytes (Office RETURN3 D2: the body must be
// recoverable from the artifact, not just counted).
export const RETAINED_CONTENT_NOTE = 'retained non-ticket source content';

// The measured `bd export --all` JSONL record shapes (Root P0 2026-11-15
// baseline: 13,498 issues + 90 memories on sentinel-prod). A port boundary:
// the known fields are named, the catch-all keeps everything bd printed.
export interface BdExportIssueRecord extends BdCardView {
  _type: 'issue';
}

// Dolt memory records carry ONLY {_type, key, value} - no id, no issue_type.
export interface BdExportMemoryRecord {
  _type: 'memory';
  key: string;
  value: string;
}

// WHY this adapter is shaped the way it is: the import worker builds one reader
// per tick (import-worker.ts) and advances one bounded chunk of work per tick, so
// the reader may cache a whole-board snapshot in memory and it goes away with the
// tick. Root P0 (2026-11-15, measured FULL source contract): the whole board is
// ONE readonly `bd export --all` JSONL snapshot per tick - every issue record
// (all issue_types, closed included: bd list EXCLUDES closed by default) plus
// every Dolt memory record, with the complete comments and dependencies INLINE
// (6,134 issues carry comments, 6,407 carry dependencies). No per-card show
// crawl: `bd show --include-comments` carries no comments array at all on this
// bd revision (only comment_count), so the export is the ONLY complete snapshot.
// The measured board export is ~104MB, so the default runner's buffer is
// bounded at 256MiB (Root: above the known 103MB), never unbounded.
//
// The one command the adapter ever issues, read-only: `bd export --all`.
// The runner is an injected seam so the tests feed it captured export output
// and assert no other command shape ever leaves the adapter. bd reads no
// credential, so a bd job's credential must be empty; the registration below
// enforces that.

export type BdCommandRunner = (args: string[]) => Promise<string>;

// The default runner: bd in the board's own directory, read-only, no shell. A
// non-zero exit or a parse failure fails the tick; import-retry.ts decides
// whether the job retries. The buffer bounds the full-board export (the
// measured sentinel-prod export is ~104MB; Root bounded it at 256MiB).
function defaultBdRunner(boardPath: string): BdCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        args[0],
        args.slice(1),
        { cwd: boardPath, maxBuffer: 256 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(new Error(`bd ${args.slice(1).join(' ')} failed: ${err.message}`));
          else resolve(stdout);
        },
      );
    });
}

export interface BdSourceConfig {
  // The directory whose .beads store is the source board; bd runs there.
  boardPath: string;
  // The bd executable. Defaults to bd on PATH.
  bdCommand?: string;
  // The tree owner's cap for the target project; Number.POSITIVE_INFINITY for a
  // rig-gated project, which has no cap (issue-tree.ts).
  maxDepth?: number;
  // The name the job card shows; defaults to the board directory's name.
  sourceName?: string;
  // The board's full declared partition set (Root partition ruling 2026-11-15):
  // the primary partition (the board directory name) plus the declared sibling
  // rig prefixes. A card of a declared partition that is NOT this job's own is
  // preserved - never refused (the sibling job owns it) and never renamed; a
  // card outside the entire set still fails the strict mapper. Absent = the
  // historical strict single-rig behavior.
  declaredPartitions?: readonly string[];
  // The job's own partition, resolved TRUSTED (job -> project -> rig) by the
  // production factory and awaited exactly once with the first snapshot.
  // Absent = the own partition is the primary (the board directory name).
  resolveOwnPartition?: () => Promise<string>;
}

// The source carries no credential: the board is a local path the operator
// configured on the job.
export type BdCredential = Record<string, never>;

export class BdReader implements SourceReader {
  private readonly config: BdSourceConfig;
  private readonly run: BdCommandRunner;
  private snapshot: BdSourceSnapshot | null = null;
  // Single-flight export (Root P0 2026-11-15, FULL_PIPELINE_D2_R1): the frozen
  // contract is ONE readonly `bd export --all` per reader/tick. The promise is
  // set BEFORE the first await, so concurrent methods racing through
  // loadSnapshot (runDiscover's Promise.all) all await the SAME export
  // instead of each starting their own; a failure evicts the promise and
  // resets the partial cards/comments/memories so a retry re-exports cleanly.
  private snapshotPromise: Promise<BdSourceSnapshot> | null = null;
  // The export's memory records (the only non-issue records): carried as
  // retained rows, never tickets, never bead ids.
  private memories: BdExportMemoryRecord[] = [];
  private readonly cards = new Map<string, BdCardView>();
  private readonly comments = new Map<string, CanonicalComment[]>();

  constructor(config: BdSourceConfig, run: BdCommandRunner | null = null) {
    this.config = config;
    this.run = run ?? defaultBdRunner(config.boardPath);
  }

  // The tree cap this reader maps with - exposed so the production-factory
  // proofs can assert the derived uncapped value without shelling out to bd
  // (Studio 2026-11-15 GO: a pure-function Infinity test alone proves nothing
  // about the factory path).
  get treeCap(): number {
    // The production factory always sets this (bdImportTreeCap); a directly
    // constructed reader without a cap maps at the pure mapper's default of 8.
    return this.config.maxDepth ?? 8;
  }

  // The ONE command the adapter issues: a readonly full-board export. JSONL,
  // one record per line; blank lines between records are tolerated (bd prints
  // none today - the contract is one JSON object per non-blank line). Every
  // _type:'issue' record is a native issue regardless of issue_type; only
  // _type:'memory' records are retained (Root P0 2026-11-15).
  private async bdExportAll(): Promise<{ cards: BdCardView[]; memories: BdExportMemoryRecord[] }> {
    const out = await this.run([this.config.bdCommand ?? 'bd', 'export', '--all']);
    const cards: BdCardView[] = [];
    const memories: BdExportMemoryRecord[] = [];
    for (const [i, line] of out.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        throw new Error(
          `bd export --all line ${i + 1} is not a JSON object; the tick fails closed`,
        );
      }
      if (record._type === 'issue') {
        const card = record as unknown as BdCardView;
        if (typeof card.id !== 'string' || !card.id) {
          throw new Error(
            `bd export --all line ${i + 1} is an issue record without an id; the tick fails closed`,
          );
        }
        // The api bdBoardExport enforces the same contract: an issue without a
        // nonempty string status cannot be mapped to a state, so the tick
        // fails closed instead of mapping undefined (Root 2026-11-15).
        if (typeof card.status !== 'string' || !card.status) {
          throw new Error(
            `bd export --all line ${i + 1} is an issue record without a status; the tick fails closed`,
          );
        }
        cards.push(card);
      } else if (record._type === 'memory') {
        const mem = record as unknown as BdExportMemoryRecord;
        if (typeof mem.key !== 'string' || !mem.key) {
          throw new Error(
            `bd export --all line ${i + 1} is a memory record without a key; the tick fails closed`,
          );
        }
        memories.push(mem);
      }
      // Any other _type (a future bd revision) fails closed rather than being
      // silently dropped: the contract is issues AND memories, nothing else.
      else {
        throw new Error(
          `bd export --all line ${i + 1} carries an unknown _type ` +
            `(${String(record._type)}); the tick fails closed rather than dropping records`,
        );
      }
    }
    return { cards, memories };
  }

  // The job's own partition prefix (Root partition ruling 2026-11-15), set
  // exactly once with the snapshot by loadSnapshot: the production factory's
  // trusted resolver (job -> project -> rig) when bound, else the primary.
  private ownPartition: string | null = null;

  private loadSnapshot(): Promise<BdSourceSnapshot> {
    if (this.snapshotPromise) return this.snapshotPromise;
    const promise = (async () => {
      const boardDir = this.config.boardPath.split('/').filter(Boolean).pop() ?? '';
      // The trusted rig prefix is the board directory's name: bd ids are
      // <repo>-<number> and the operator pointed BD_IMPORT_BOARD_ROOT at this
      // repo's directory (server config, never request input). The job's own
      // partition is the primary unless the production factory resolved its
      // target project's rig to a declared sibling partition. The mapper
      // derives every card's local token from it - a card that does not carry
      // it fails the mapping loudly (Root, 8363.1: explicit trusted binding).
      this.ownPartition = this.config.resolveOwnPartition
        ? await this.config.resolveOwnPartition()
        : boardDir;
      const { cards, memories } = await this.bdExportAll();
      this.memories = memories;
      // The explicit partition scope (Root partition ruling 2026-11-15): the
      // classification is the partition leaf's (bd-mapping-partitions.ts);
      // absent binding = historical strict single prefix, byte-for-byte.
      const declared = [...new Set(this.config.declaredPartitions ?? [boardDir])];
      const partition = partitionBdCards(cards, this.ownPartition, declared);
      for (const card of partition.own) this.cards.set(card.id, card);
      this.snapshot = mapBdSource([...partition.own, ...partition.outsideDeclared], {
        maxDepth: this.config.maxDepth,
        rigPrefix: this.ownPartition,
      });
      return this.snapshot;
    })();
    promise.catch(() => {
      // Evict on failure: a retry must re-export from scratch, never observe
      // a poisoned or half-filled snapshot (partial cards/comments/memories).
      this.snapshotPromise = null;
      this.snapshot = null;
      this.ownPartition = null;
      this.memories = [];
      this.cards.clear();
      this.comments.clear();
    });
    this.snapshotPromise = promise;
    return promise;
  }

  async describeSource(): Promise<SourceProject> {
    const name =
      this.config.sourceName ??
      this.config.boardPath.split('/').filter(Boolean).pop() ??
      'bd board';
    return { name, url: null };
  }

  async listStates(): Promise<CanonicalState[]> {
    return (await this.loadSnapshot()).states;
  }

  async listLabels(): Promise<CanonicalLabel[]> {
    return (await this.loadSnapshot()).labels;
  }

  async listIssueTypes(): Promise<CanonicalIssueType[]> {
    const snap = await this.loadSnapshot();
    // The exact source issue_type names, machine-bound by the actual input -
    // never translated. The worker's existing materialize seam creates one
    // native issue_type row per exact name (reused by
    // unique(project_id, name)) and Create binds issue.type_id to it, so the
    // operational kind survives: an epic is created as an epic.
    const names = [...new Set(snap.issues.map((i) => i.typeSourceId ?? ''))].filter(Boolean).sort();
    return names.map((name) => ({ sourceId: name, name }));
  }

  async listCycles(): Promise<CanonicalCycle[]> {
    return [];
  }

  async listCustomFields(): Promise<CanonicalCustomField[]> {
    return [];
  }

  // The board is read in one shot (bd list has no stable pagination cursor and the
  // worker re-reads per tick anyway), so the whole snapshot is one page, like the
  // Trello adapter's single 1000-card page.
  async listIssues(): Promise<Page<CanonicalIssue>> {
    const snap = await this.loadSnapshot();
    return { items: snap.issues, cursor: null };
  }

  async getIssue(sourceId: string): Promise<CanonicalIssue> {
    const snap = await this.loadSnapshot();
    const issue = snap.issues.find((i) => i.sourceId === sourceId);
    if (!issue) throw new Error(`bd card ${sourceId} is not a ticket in this board snapshot`);
    return issue;
  }

  async listIssueRelations(issueSourceId: string): Promise<CanonicalRelation[]> {
    const snap = await this.loadSnapshot();
    // A card appears at both ends of its edges; the worker dedupes per issue.
    return snap.relations.filter(
      (r) => r.sourceIssueSourceId === issueSourceId || r.targetIssueSourceId === issueSourceId,
    );
  }

  // Comments come INLINE from the export record (present-only-when-non-empty);
  // there is no show crawl - and `bd show --include-comments` would not help:
  // this bd revision's show carries no comments array at all, only
  // comment_count (measured 2026-11-15).
  async listIssueComments(issueSourceId: string): Promise<CanonicalComment[]> {
    const cached = this.comments.get(issueSourceId);
    if (cached) return cached;
    await this.loadSnapshot();
    const card = this.cards.get(issueSourceId);
    if (!card) throw new Error(`bd card ${issueSourceId} is not in this board snapshot`);
    const mapped = mapBdComments(card.id, card.comments);
    this.comments.set(issueSourceId, mapped);
    return mapped;
  }

  async listIssueAttachments(): Promise<CanonicalAttachment[]> {
    return [];
  }

  // The retained rows: the export's memory records (the ONLY non-issue
  // records), plus each real ticket's metadata row. Root P0 2026-11-15:
  // memories carry EXACT key/value under the source namespace memory:<key> -
  // they NEVER become bead ids and NEVER get a tombstone (the hook stamps
  // only retention 'tombstone_identity'; the generic bead tombstone primitive
  // stays for true bead retention, which this source has none of). The
  // export carries everything inline, so no show crawl and no per-row fetch.
  async listRetainedRows(): Promise<CanonicalRetainedRow[]> {
    const snap = await this.loadSnapshot();
    const out: CanonicalRetainedRow[] = [];
    // Board-level memory records are retained by the PRIMARY partition job
    // ALONE (Root partition ruling 2026-11-15): a sibling partition's job
    // retains only its own partition's ticket metadata and must not re-stamp
    // the board's memories under a second job's receipt.
    const boardDir = this.config.boardPath.split('/').filter(Boolean).pop() ?? '';
    for (const mem of this.ownPartition === boardDir ? this.memories : []) {
      // The memory's source content is the exact key/value pair - carried
      // verbatim through the unmapped port so the artifact digest covers the
      // body: two distinct memory values never collapse to the same durable
      // artifact. Fixed field order keeps it deterministic.
      out.push({
        sourceId: `memory:${mem.key}`,
        title: mem.key,
        retention: 'memory_key',
        reason:
          'Dolt memory record: exact key/value retained under the source namespace, never a bead id',
        unmapped: [
          { field: 'key', value: mem.key, note: RETAINED_CONTENT_NOTE },
          { field: 'value', value: mem.value, note: RETAINED_CONTENT_NOTE },
          { field: 'raw', value: JSON.stringify(mem), note: RETAINED_CONTENT_NOTE },
        ],
      });
    }
    // Studio 2026-11-15 RETURN: a real ticket's unmapped source values
    // (assignee token, out-of-range priority, notes, unknown fields) and its
    // EXACT original title have no production consumer - the non-ticket-only
    // artifact preserves none of them. Each real ticket therefore rides the
    // SAME durable sink as a distinct ticket_metadata row: full source id,
    // the exact original title + alreadyPrefixed (the native title cannot
    // distinguish source-prefixed from importer-prefixed), and the ticket's
    // unmapped source values. These rows NEVER stamp a tombstone (the hook
    // skips non-tombstone retentions) and never create a second ledger row -
    // the ticket's own identity is already on its issue.
    for (const issue of snap.issues) {
      const title = snap.retainedTitles.find((t) => t.sourceId === issue.sourceId);
      // `originalTitle`/`alreadyPrefixed` are OMITTED (not undefined) when the
      // title is absent so the durable artifact carries no phantom keys.
      out.push({
        sourceId: issue.sourceId,
        title: title?.originalTitle ?? issue.title,
        retention: 'ticket_metadata',
        reason: 'real ticket: source metadata retained durably, no tombstone',
        ...(title
          ? { originalTitle: title.originalTitle, alreadyPrefixed: title.alreadyPrefixed }
          : {}),
        unmapped: [
          ...snap.unmapped
            .filter((f) => f.bdId === issue.sourceId)
            .map((f) => ({ field: f.field, value: f.value, note: f.note })),
          {
            field: 'raw',
            value: JSON.stringify(this.cards.get(issue.sourceId) ?? {}),
            note: RETAINED_CONTENT_NOTE,
          },
        ],
      });
    }
    return out;
  }

  async listIssueChecklists(): Promise<CanonicalChecklist[]> {
    return [];
  }

  async resolveAttachmentDownload(): Promise<AttachmentDownload> {
    throw new Error('bd sources carry no attachments');
  }
}
