// How many records the Create, Link and attachment phases take per tick, by source.
//
// WHY the remote sources stay at 15: each issue costs several more requests to the source
// (comments, attachments, relations) against a budget of about 60 requests a minute, so the
// chunk stays well under the discover page size.
//
// WHY bd takes 250 (Root, sentinel-prod-8364, 2026-11-15): a bd board is a local export, read
// once per tick with no request budget. At 15 the full-export trial needed about 900 Create
// ticks and 900 Link ticks for 13,496 cards, and every tick re-read the whole 104 MB export.
// 250 cuts that to about 54 ticks a phase. The number is Root's ruling. It is not a measured
// ceiling, so measure a tick before raising it: the claim lease has to outlast one chunk.
//
// Only the chunk size differs. Phases, cursors, retries and the rows written are the same for
// every source, so a crashed tick resumes from the same cursor whatever the size.

const REMOTE_SOURCE_BATCH = 15;
const BD_SOURCE_BATCH = 250;

export function importBatchSize(source: string): number {
  return source === 'bd' ? BD_SOURCE_BATCH : REMOTE_SOURCE_BATCH;
}

// The same size, read off a claimed job. Short on purpose, so the call sites in
// import-worker.ts stay on one line and that file does not grow.
export function batchFor(job: { source: string }): number {
  return importBatchSize(job.source);
}
