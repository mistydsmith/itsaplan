// 8364 D3 U2 — the shared authoritative pre-allocation identity snapshot.
//
// The future writer calls this BEFORE the allocator reserves a number, inside the caller's
// own create transaction, while it holds the rig -> board -> project -> issue locks. It reads
// the actual pre-state the owner rule needs to pick the next id: the rig's prefix and root
// high-water mark, every id the rig has ever held, and the parent's truthful id.
//
// It reads only. It never reserves, updates or inserts, so calling it changes nothing, and it
// reads the counter before the allocator moves next_root, so the facts are the actual
// pre-allocation state. Every read goes through the SAME executor the caller supplied (the
// pool or the caller's transaction), so a caller inside a transaction observes its own
// uncommitted rig/identity state.
//
// Trust: the caller supplies real server ids (rigId, projectId, parentIssueId) resolved by
// the future writer, and this function re-checks those associations through the same
// executor. It authenticates no client field, accepts no caller-supplied prefix/counter/id
// array, and makes no grant, close or routing decision. It is reusable from the API and a
// separate worker, so it imports no API type.
//
// The root high-water mark is next_root - 1: the rig column stores the NEXT number to hand
// out, while the owner's water is the highest number already used (its _next_root adds one).
// That converts the column's own meaning; it is never subtraction from a claimed candidate.

import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client';

// Refusal codes for a snapshot whose inputs do not hold together on the database. These are
// data-integrity refusals (a missing rig, a mismatched association), never policy.
export const ID_FACTS_REFUSAL_CODES = [
  'invalid-argument',
  'missing-rig',
  'missing-project',
  'project-rig-mismatch',
  'parent-without-identity',
  'parent-other-project',
  'parent-other-rig',
] as const;

export type IdFactsRefusalCode = (typeof ID_FACTS_REFUSAL_CODES)[number];

// One minimal typed refusal. @repo/db cannot import an API error type, so each caller maps
// this to its own response. It carries a code and a message and nothing policy-shaped: no
// policy transport or framework is added here.
export class IdFactsRefusal extends Error {
  readonly code: IdFactsRefusalCode;

  constructor(code: IdFactsRefusalCode, message: string) {
    super(message);
    this.name = 'IdFactsRefusal';
    this.code = code;
  }
}

export function isIdFactsRefusal(value: unknown): value is IdFactsRefusal {
  return value instanceof IdFactsRefusal;
}

// The pre-allocation facts the owner rule evaluates before a number is reserved.
export interface IdFactsSnapshot {
  // The rig's prefix, exactly as stored.
  rig_prefix: string;
  // Every id the rig has ever held, as `${prefix}-${local_token}`: roots and daughters alike,
  // minted and imported, tombstones and unattached rows. No archive/tombstone filter, no limit.
  existing_ids: string[];
  // The highest root number the rig's counter already used: next_root - 1.
  root_high_water: number;
  // The parent's truthful bead id (canonical, hash, named or multidot), or null for a root.
  parent_id: string | null;
}

export interface SnapshotIdFactsInput {
  // The rig whose ids this project takes; must be a real rig id.
  rigId: number;
  // The project the new issue belongs to; verifies it is actually gated by rigId.
  projectId: number;
  // The parent issue when this is a daughter, else null.
  parentIssueId: number | null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Reads the pre-allocation identity facts through the caller's executor. See the file header
// for the trust model: server-resolved ids in, actual pre-state out, no writes, no policy.
export async function snapshotIdFacts(
  executor: DbExecutor,
  input: SnapshotIdFactsInput,
): Promise<IdFactsSnapshot> {
  const { rigId, projectId, parentIssueId } = input;
  if (!positiveInteger(rigId))
    throw new IdFactsRefusal('invalid-argument', 'rigId must be a positive integer.');
  if (!positiveInteger(projectId))
    throw new IdFactsRefusal('invalid-argument', 'projectId must be a positive integer.');
  if (parentIssueId !== null && !positiveInteger(parentIssueId))
    throw new IdFactsRefusal(
      'invalid-argument',
      'parentIssueId must be a positive integer or null.',
    );

  // The rig: prefix and counter. Read before the allocator moves next_root and through the
  // caller's executor, so the observed counter is the actual pre-state this caller sees.
  const rigRows = (await executor.execute(
    sql`SELECT prefix, next_root FROM rig WHERE id = ${rigId}`,
  )) as unknown as { prefix: string; next_root: number | string }[];
  const rig = rigRows[0];
  if (!rig) throw new IdFactsRefusal('missing-rig', `Rig ${rigId} does not exist.`);

  // The project must exist and be gated by exactly this rig: the association the caller
  // claims is re-checked against the stored rig_id, not trusted.
  const projectRows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId}`,
  )) as unknown as { rig_id: number | string | null }[];
  const project = projectRows[0];
  if (!project) throw new IdFactsRefusal('missing-project', `Project ${projectId} does not exist.`);
  if (project.rig_id === null || Number(project.rig_id) !== rigId)
    throw new IdFactsRefusal(
      'project-rig-mismatch',
      `Project ${projectId} is not gated by rig ${rigId}.`,
    );

  // Every id the rig has ever held, including tombstones and imported rows, with no filter
  // and no limit, so a number is never handed out twice.
  const tokenRows = (await executor.execute(
    sql`SELECT local_token FROM bead_identity WHERE rig_id = ${rigId}`,
  )) as unknown as { local_token: string }[];
  const existing_ids = tokenRows.map((row) => `${rig.prefix}-${row.local_token}`);

  // The parent, when this is a daughter: its truthful id read by issue id, with its project
  // and rig re-checked so a cross-project or cross-rig parent is refused, not borrowed. The
  // id is the stored local_token verbatim, so a canonical, hash, named or multidot parent is
  // never erased.
  let parent_id: string | null = null;
  if (parentIssueId !== null) {
    const parentRows = (await executor.execute(
      sql`SELECT bi.local_token, bi.rig_id, i.project_id
            FROM bead_identity bi
            JOIN issue i ON i.id = bi.issue_id
           WHERE bi.issue_id = ${parentIssueId}`,
    )) as unknown as {
      local_token: string;
      rig_id: number | string;
      project_id: number | string;
    }[];
    const parent = parentRows[0];
    if (!parent)
      throw new IdFactsRefusal(
        'parent-without-identity',
        `Parent ${parentIssueId} holds no bead identity, so it cannot be a parent here.`,
      );
    if (Number(parent.project_id) !== projectId)
      throw new IdFactsRefusal(
        'parent-other-project',
        `Parent ${parentIssueId} is not in project ${projectId}.`,
      );
    if (Number(parent.rig_id) !== rigId)
      throw new IdFactsRefusal(
        'parent-other-rig',
        `Parent ${parentIssueId} belongs to another rig.`,
      );
    parent_id = `${rig.prefix}-${parent.local_token}`;
  }

  return {
    rig_prefix: rig.prefix,
    existing_ids,
    root_high_water: Number(rig.next_root) - 1,
    parent_id,
  };
}
