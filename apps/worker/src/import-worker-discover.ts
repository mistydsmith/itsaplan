// The Discover phase of the import worker (Root P0 2026-11-15 module-guard
// repair): snapshot every source id up front, writing import_record rows
// with no local mapping yet. Its own leaf so the worker monolith does not
// grow for the exported D2 witness seam; the phase body is byte-identical to
// the former import-worker.ts copy.
import type { SourceReader } from './reader';
import {
  advanceImportJobPhase,
  insertDiscoveredIds,
  saveImportJobCursor,
  saveImportJobSourceProject,
  type ClaimedImportJob,
} from './import-store';

// --- Discover: snapshot every source id up front, writing import_record rows
// with no local mapping yet. Plane's own pagination cursor is not a safe
// resumability anchor across a job that can span many ticks (see "Pagination"
// in docs/dev/plane-import-source-notes.md) — Create resumes from this
// snapshot instead, keyed on import_record's own id.

interface DiscoverCursor {
  subphase: 'meta' | 'issues';
  planeCursor: string | null;
}

// Exported for the 8363.1 whole-pipeline D2 witness (Root handoff 2026-11-15):
// Root's controlled one-off phase execution drives the EXISTING phases on a
// dedicated job; this export adds no second pipeline, no mock store and no
// background loop - the witness calls the same functions the worker calls.
export async function runDiscover(job: ClaimedImportJob, reader: SourceReader): Promise<void> {
  const cursor = job.cursor as Partial<DiscoverCursor>;
  if (cursor.subphase !== 'issues') {
    await saveImportJobSourceProject(job.id, await reader.describeSource());
    const [states, labels, cycles, customFields, issueTypes, initiatives] = await Promise.all([
      reader.listStates(),
      reader.listLabels(),
      reader.listCycles(),
      reader.listCustomFields(),
      reader.listIssueTypes?.() ?? [],
      reader.listInitiatives?.() ?? [],
    ]);
    await insertDiscoveredIds(
      job.id,
      'state',
      states.map((s) => s.sourceId),
    );
    await insertDiscoveredIds(
      job.id,
      'label',
      labels.map((l) => l.sourceId),
    );
    await insertDiscoveredIds(
      job.id,
      'cycle',
      cycles.map((c) => c.sourceId),
    );
    await insertDiscoveredIds(
      job.id,
      'custom_field',
      customFields.map((f) => f.sourceId),
    );
    await insertDiscoveredIds(
      job.id,
      'issue_type',
      issueTypes.map((t) => t.sourceId),
    );
    await insertDiscoveredIds(
      job.id,
      'initiative',
      initiatives.map((i) => i.sourceId),
    );
    const next: DiscoverCursor = { subphase: 'issues', planeCursor: null };
    await saveImportJobCursor(job.id, next);
    return;
  }

  const page = await reader.listIssues(cursor.planeCursor ?? null);
  await insertDiscoveredIds(
    job.id,
    'issue',
    page.items.map((i) => i.sourceId),
  );
  if (page.cursor === null) {
    await advanceImportJobPhase(job.id, 'create', {});
    return;
  }
  const next: DiscoverCursor = { subphase: 'issues', planeCursor: page.cursor };
  await saveImportJobCursor(job.id, next);
}
