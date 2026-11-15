// scripts/landing-record.test-fixtures.ts — sentinel-prod-8429 unit 5 test fixtures.
// WHY no global transaction queue: a queue serialised every transaction, so two concurrent calls could not
// interleave and a wrong ORDER inside the coordinator still looked correct. Root's third RETURN found exactly
// that. The fake now models what the adapter must do: a PER-ITEM lock, taken when the transaction first reads
// the item's row, held until the transaction ends, with transactions otherwise running concurrently.
//
// WHY an undo log instead of a snapshot: a snapshot restored the whole world, so a failing transaction could
// erase another transaction's committed row. Rollback now reverses only what this transaction wrote.
//
// WHAT THIS FAKE DOES NOT PROVE: it is not PostgreSQL. It shows that the coordinator's ORDER keeps the
// per-item lock across the replay lookup, the move and the append. The native adapter still owes a real
// FOR UPDATE behaviour and its own test, and landing-record.ts says so.

import type {
  CleanupObligationRow,
  FreshItem,
  LandingActivityRow,
  PriorActivity,
  RecordStorage,
  RecordTx,
} from './landing-record';

type ItemRow = { columnId: number | null } & Partial<Omit<FreshItem, 'columnId'>>;

export interface FakeStorage extends RecordStorage {
  activities: PriorActivity[];
  rows: LandingActivityRow[];
  cleanups: CleanupObligationRow[];
  items: Map<string, ItemRow>;
  /** Every transaction fails at this step. */
  failAt?: 'move' | 'append' | 'cleanup' | 'read';
  /** One transaction (1-based) fails at this step, so concurrency can be proved. */
  failOn?: { index: number; at: 'move' | 'append' | 'cleanup' };
  /** Makes the move lose its compare-and-set, as if another writer moved the row between read and move. */
  racesMove?: boolean;
  /** Highest number of transactions that were inside their body at the same time. */
  maxConcurrent: number;
  /** Highest number of transactions that held ONE item's lock at once; must never exceed 1. */
  maxPerItem: number;
  /** Resolves when a lock is released for the first time, so a late contender can be started on purpose. */
  firstRelease: Promise<void>;
  transactions: number;
  commits: number;
  rollbacks: number;
}

export interface FakeStorageOptions {
  /** How long the FIRST lock holder keeps the item, so a late contender can be started on purpose. */
  holdFirstMs?: number;
  activities?: PriorActivity[];
  items?: Record<string, ItemRow>;
  failAt?: FakeStorage['failAt'];
  failOn?: FakeStorage['failOn'];
  racesMove?: boolean;
}

export function fakeStorage(options: FakeStorageOptions = {}): FakeStorage {
  const state = {
    activities: [...(options.activities ?? [])],
    rows: [] as LandingActivityRow[],
    cleanups: [] as CleanupObligationRow[],
    items: new Map(Object.entries(options.items ?? {})),
    failAt: options.failAt,
    failOn: options.failOn,
    racesMove: options.racesMove ?? false,
    maxConcurrent: 0,
    maxPerItem: 0,
    firstRelease: Promise.resolve(),
    transactions: 0,
    commits: 0,
    rollbacks: 0,
  } as FakeStorage;

  // Per-item lock: waiters queue on the item's own key, and nothing else queues.
  const tails = new Map<string, Promise<void>>();
  const holders = new Map<string, number>();
  let live = 0;
  let acquisitions = 0;
  let released = false;
  let onFirstRelease: () => void = () => undefined;
  state.firstRelease = new Promise<void>((resolve) => {
    onFirstRelease = resolve;
  });

  const acquire = async (itemKey: string): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = tails.get(itemKey) ?? Promise.resolve();
    // WHY the chain advances by itself: each holder's release resolves its own promise, which is what the
    // next waiter is awaiting. Nothing may reset or overwrite it afterwards (see the finally block).
    tails.set(
      itemKey,
      prior.then(() => held),
    );
    await prior;
    holders.set(itemKey, (holders.get(itemKey) ?? 0) + 1);
    state.maxPerItem = Math.max(state.maxPerItem, holders.get(itemKey) as number);
    acquisitions += 1;
    // WHY only the first holder waits: the test needs the others queued behind a live lock holder, which is
    // how a late contender can be started after the first release instead of all four arriving at once.
    if (acquisitions === 1 && options.holdFirstMs) {
      await new Promise((resolve) => setTimeout(resolve, options.holdFirstMs));
    }
    return () => {
      holders.set(itemKey, (holders.get(itemKey) ?? 1) - 1);
      release();
      if (!released) {
        released = true;
        onFirstRelease();
      }
    };
  };

  state.transaction = async <T>(fn: (tx: RecordTx) => Promise<T>): Promise<T> => {
    state.transactions += 1;
    const ordinal = state.transactions;
    const failing = (step: 'move' | 'append' | 'cleanup'): boolean =>
      state.failAt === step || (state.failOn?.at === step && state.failOn.index === ordinal);
    live += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, live);
    const undo: Array<() => void> = [];
    const releases: Array<() => void> = [];
    let locked: string | null = null;

    const lock = async (itemKey: string): Promise<void> => {
      if (locked === itemKey) return;
      releases.push(await acquire(itemKey));
      locked = itemKey;
    };

    const tx: RecordTx = {
      async readActivities(itemKey) {
        if (state.failAt === 'read') throw new Error('read failed');
        return state.activities.filter((row) => row.payload?.itemKey === itemKey);
      },
      async readItem(itemKey): Promise<FreshItem | null> {
        // WHY here: this is the row the adapter locks, and the coordinator calls it first on purpose.
        await lock(itemKey);
        const found = state.items.get(itemKey);
        if (found === undefined) return null;
        return {
          columnId: found.columnId,
          projectId: found.projectId ?? 7,
          status: found.status ?? 'in_progress',
          archived: found.archived ?? false,
        };
      },
      async appendActivity(row) {
        if (failing('append')) throw new Error('append failed');
        const activity: PriorActivity = {
          kind: row.kind,
          payload: {
            activityId: row.payload.activityId,
            candidateSha: row.payload.candidateSha,
            itemKey: row.payload.itemKey,
          } as PriorActivity['payload'],
        };
        state.rows.push(row);
        state.activities.push(activity);
        undo.push(() => {
          state.rows.pop();
          state.activities.pop();
        });
      },
      async moveItem(itemKey, fromColumnId, toColumnId) {
        if (failing('move')) throw new Error('move failed');
        if (state.racesMove) return false;
        const current = state.items.get(itemKey);
        // The CAS: a different from-column means somebody else moved it first.
        if (current === undefined || current.columnId !== fromColumnId) return false;
        const before = { ...current };
        state.items.set(itemKey, { ...current, columnId: toColumnId });
        undo.push(() => state.items.set(itemKey, before));
        return true;
      },
      async recordCleanupObligation(row) {
        if (failing('cleanup')) throw new Error('cleanup failed');
        state.cleanups.push(row);
        undo.push(() => {
          state.cleanups.pop();
        });
      },
    };

    try {
      const value = await fn(tx);
      state.commits += 1;
      return value;
    } catch (error) {
      // WHY reverse order: a transaction undoes its own writes newest first, and touches nothing else.
      for (const step of undo.reverse()) step();
      state.rollbacks += 1;
      throw error;
    } finally {
      live -= 1;
      for (const release of releases) release();
      // WHY nothing resets tails here: an overwrite at release time drops the waiters already queued behind
      // this holder, so a late fourth contender walks in while the second still holds the item.
    }
  };

  return state;
}
