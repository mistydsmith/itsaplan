// The bd source's partition machinery (Root partition ruling 2026-11-15): the
// trusted job -> project -> rig resolver, the sibling-set parser, the target
// rig acceptance, and the pure card classification that decides which cards a
// bound reader owns (mapped) and which fall through to the strict mapper
// (outside every declared partition). A leaf of its own so the adapter and
// the registration monolith stay within the module size guard (Root P0
// 2026-11-15). Everything here is pure except the resolver's two trusted
// queries; the db client loads lazily INSIDE the resolver so this module
// stays loadable with no database client at all.
import { sql } from 'drizzle-orm';

// One query for the rig's identity: the project's rig id AND the rig's prefix, the
// two values the bd hooks need before any identity statement runs. An empty result
// means the project has no rig - fail closed, never a partial identity.
export const RIG_FOR_PROJECT = (projectId: number) =>
  sql`SELECT p.rig_id, r.prefix FROM project p JOIN rig r ON r.id = p.rig_id WHERE p.id = ${projectId}`;

// The explicit sibling partition set (Root partition ruling 2026-11-15): the
// privileged worker server env BD_IMPORT_SIBLING_RIG_PREFIXES carries the
// board's OTHER declared rig prefixes as an exact comma-separated list (this
// board: b). The PRIMARY partition is always the configured board directory
// name. An absent or empty value preserves the historical strict single-rig
// behavior. The list is validated fail-closed: an empty entry, a duplicate,
// the primary itself, or two configured prefixes where one is a strict
// prefix of the other (a card could carry both) is refused rather than
// silently selected. Pure: exported for the partition regression.
export function parseBdSiblingRigPrefixes(raw: string, primaryPartition: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const out: string[] = [];
  for (const entry of trimmed.split(',')) {
    const prefix = entry.trim();
    if (prefix === '') {
      throw new Error(
        `BD_IMPORT_SIBLING_RIG_PREFIXES ${JSON.stringify(raw)} carries an empty entry; ` +
          `refused rather than silently selected`,
      );
    }
    if (prefix === primaryPartition) {
      throw new Error(
        `BD_IMPORT_SIBLING_RIG_PREFIXES ${JSON.stringify(raw)} names the primary partition ` +
          `${primaryPartition} as a sibling; refused rather than silently selected`,
      );
    }
    if (out.includes(prefix)) {
      throw new Error(
        `BD_IMPORT_SIBLING_RIG_PREFIXES ${JSON.stringify(raw)} declares ${prefix} more than ` +
          `once; refused rather than silently selected`,
      );
    }
    out.push(prefix);
  }
  const all = [primaryPartition, ...out];
  for (const a of all)
    for (const b of all)
      if (a !== b && b.startsWith(`${a}-`)) {
        throw new Error(
          `BD_IMPORT_SIBLING_RIG_PREFIXES is ambiguous: ${a} is a strict prefix of ${b}, so a ` +
            `card could carry both; refused rather than silently selected`,
        );
      }
  return out;
}

// The acceptance of a resolved target rig (Root partition ruling 2026-11-15):
// ONLY the primary partition or an explicitly declared sibling is accepted;
// anything else - including an empty prefix - is refused rather than
// silently selected. Pure: exported so the partition regression covers the
// refusal without a database (the resolver's two trusted queries wrap this).
export function acceptBdPartition(
  ownPartition: string,
  primaryPartition: string,
  siblingPartitions: readonly string[],
): string {
  if (ownPartition === '') {
    throw new Error(`the bd target rig is empty; refused rather than silently selected`);
  }
  if (ownPartition !== primaryPartition && !siblingPartitions.includes(ownPartition)) {
    throw new Error(
      `the bd target rig ${ownPartition} is neither the primary partition ` +
        `${primaryPartition} nor a declared sibling (${siblingPartitions.join(', ')}); ` +
        `refused rather than silently selected`,
    );
  }
  return ownPartition;
}

// The job's own partition, resolved EXCLUSIVELY from the job's target
// project's rig (Root partition ruling 2026-11-15): job -> import_job
// .project_id -> project.rig_id -> rig.prefix, the same trusted
// RIG_FOR_PROJECT query the identity hooks already use. Only the primary or
// an explicitly declared sibling is accepted; anything else - including a
// vanished job row or a project with no rig - fails closed.
const IMPORT_JOB_PROJECT_ID = (jobId: number) =>
  sql`SELECT project_id FROM import_job WHERE id = ${jobId}`;

export async function resolveBdJobOwnPartition(
  jobId: number,
  primaryPartition: string,
  siblingPartitions: readonly string[],
): Promise<string> {
  // The db client loads LAZILY here (not at module top): this module must stay
  // loadable with no database client at all - the @repo/db client refuses to
  // load without a connection string, and the bd registration, the unbound
  // (no-sibling-env) readers and every no-DB test need no database to refuse
  // a job. Only a bound partition job - which needs a DB to run anyway - ever
  // pays the load.
  const { db } = await import('@repo/db');
  const jobRows = (await db.execute(IMPORT_JOB_PROJECT_ID(jobId))) as unknown as {
    project_id: number;
  }[];
  const projectId = jobRows[0]?.project_id;
  if (typeof projectId !== 'number') {
    throw new Error(
      `import job ${jobId} cannot run: its import_job row is gone; the bd partition ` +
        `binding fails closed`,
    );
  }
  const rigRows = (await db.execute(RIG_FOR_PROJECT(projectId))) as unknown as {
    rig_id: number;
    prefix: string;
  }[];
  const own = rigRows[0]?.prefix;
  if (typeof own !== 'string') {
    throw new Error(
      `import job ${jobId} cannot run: its target project has no rig, so its bd ` +
        `partition cannot be bound`,
    );
  }
  return acceptBdPartition(own, primaryPartition, siblingPartitions);
}

// The pure card classification for a bound reader (Root partition ruling
// 2026-11-15): a card of the job's OWN partition is mapped; a card of ANOTHER
// declared partition is preserved (excluded from the mapper's input - never
// refused, never renamed); a card outside the entire declared set goes to
// the strict mapper, which refuses it loudly. The configured prefixes were
// already validated fail-closed by the production factory, so a card carries
// at most one declared prefix. Pure: exported for the partition regression.
export interface BdCardClassification<T> {
  own: T[];
  outsideDeclared: T[];
}

export function partitionBdCards<T extends { id: string }>(
  cards: readonly T[],
  ownPartition: string,
  declaredPartitions: readonly string[],
): BdCardClassification<T> {
  const own: T[] = [];
  const outsideDeclared: T[] = [];
  const ownMarker = `${ownPartition}-`;
  for (const card of cards) {
    if (card.id.startsWith(ownMarker)) {
      own.push(card);
      continue;
    }
    const holder = declaredPartitions.find(
      (p) => p !== ownPartition && card.id.startsWith(`${p}-`),
    );
    if (holder) continue; // preserved for the sibling job; not this job's snapshot
    outsideDeclared.push(card);
  }
  return { own, outsideDeclared };
}
