import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client';

// The transaction half of DbExecutor. Allocation must join the caller's create
// transaction: the rig lock, the native sequence, the issue row and its ledger row all
// have to land or roll back together.
export type IdentityTransaction = Parameters<Parameters<DbExecutor['transaction']>[0]>[0];

export type AllocationRefusalCode =
  | 'invalid-argument'
  | 'parent-not-a-root'
  | 'missing-rig'
  | 'parent-without-identity'
  | 'parent-other-project'
  | 'parent-other-rig'
  | 'issue-not-ready'
  | 'conflict';

export interface BeadAllocation {
  rigId: number;
  prefix: string;
  root: number;
  child: number;
  localToken: string;
  beadId: string;
}

export interface AllocationOk {
  ok: true;
  allocation: BeadAllocation;
}

export interface AllocationRefusal {
  ok: false;
  code: AllocationRefusalCode;
  message: string;
}

export type AllocationResult = AllocationOk | AllocationRefusal;

// 'auto' takes a daughter when the parent is a root and a fresh root otherwise, which is
// the SPEC_R2 default. 'root' asks for a root even though a parent is supplied, for the
// epic/task hierarchies whose root number is independent of the parent. 'daughter'
// insists on a daughter and refuses when the parent cannot take one.
export type AllocationMode = 'auto' | 'root' | 'daughter';

export interface AllocateInput {
  rigId: number;
  // The project the new issue belongs to, used to prove a parent is in the same project.
  projectId: number;
  // Null for a plain root, set for a daughter. A parent that is itself a daughter gives
  // the new issue its own root and keeps the real parent link.
  parentId: number | null;
  // Defaults to 'auto'. Named so a caller that wants a root despite a parent does not
  // have to hope: an undeclared extra property is ignored, which would silently give a
  // daughter instead.
  mode?: AllocationMode;
}

// The SQLSTATE of a driver error, whether it arrives bare or wrapped in a cause.
function sqlState(error: unknown): string | undefined {
  const direct = (error as { code?: string }).code;
  if (direct) return direct;
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code;
}

// An imported row may carry its number only in local_token, because C1 permits NULL root and
// child. The token is the authoritative record, so the position is read from it: exact digits
// are a root at child 0, one dot of digits is a daughter, and a hash or a multidot token has
// no numeric position at all, which makes the child a fresh root. A title is never read.
function ledgerPosition(
  root: number | string | null,
  child: number | string | null,
  localToken: string,
): { root: number | null; child: number | null } {
  if (root !== null && child !== null) {
    return { root: Number(root), child: Number(child) };
  }
  if (/^[0-9]+$/.test(localToken)) return { root: Number(localToken), child: 0 };
  if (/^[0-9]+\.[0-9]+$/.test(localToken)) {
    const [rootPart, childPart] = localToken.split('.');
    return { root: Number(rootPart), child: Number(childPart) };
  }
  return { root: null, child: null };
}

function refuse(code: AllocationRefusalCode, message: string): AllocationRefusal {
  return { ok: false, code, message };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function token(root: number, child: number): string {
  return child === 0 ? `${root}` : `${root}.${child}`;
}

// The highest numeric root anyone has ever held on this rig. An imported row may carry
// its number in local_token with root left NULL, which C1 permits, so the text component
// is read too. A hash or multidot-only token contributes nothing, because its first
// component is not all digits.
const HIGHEST_MINTABLE_ROOT = sql`
  GREATEST(
    COALESCE((SELECT MAX(root) FROM bead_identity
               WHERE rig_id = $1 AND root IS NOT NULL), 0),
    COALESCE((SELECT MAX(split_part(local_token, '.', 1)::int) FROM bead_identity
               WHERE rig_id = $1
                 AND root IS NULL
                 AND split_part(local_token, '.', 1) ~ '^[0-9]+$'), 0)
  )`;

// The highest child under one root, including tombstones and imported descendants that
// stored no numeric child or no root at all. An imported '1.9' arrives with root and child
// NULL, so the token text is read whenever the columns are absent, and its first component
// has to name this root for the row to count.
function highestChild(rigId: number, root: number) {
  return sql`
    SELECT COALESCE(MAX(
      CASE
        WHEN child IS NOT NULL AND root = ${root} THEN child
        WHEN child IS NULL AND root = ${root} AND split_part(local_token, '.', 2) ~ '^[0-9]+$'
          THEN split_part(local_token, '.', 2)::int
        WHEN root IS NULL AND split_part(local_token, '.', 1) = ${`${root}`}
          AND split_part(local_token, '.', 2) ~ '^[0-9]+$'
          THEN split_part(local_token, '.', 2)::int
      END
    ), 0) AS highest
    FROM bead_identity WHERE rig_id = ${rigId}
  `;
}

// Locks the rig and decides the next token. The lock is taken before anything else in the
// create transaction, so two concurrent creates cannot read the same high-water mark.
// Nothing is written to the ledger here: the row is inserted, already attached, once the
// issue exists, because a NULL link can never be reattached afterwards.
export async function allocateBeadToken(
  tx: IdentityTransaction,
  input: AllocateInput,
): Promise<AllocationResult> {
  const { rigId, projectId, parentId } = input;
  const mode = input.mode ?? 'auto';
  if (!positiveInteger(rigId))
    return refuse('invalid-argument', 'rigId must be a positive integer.');
  if (!positiveInteger(projectId)) {
    return refuse('invalid-argument', 'projectId must be a positive integer.');
  }
  if (parentId !== null && !positiveInteger(parentId)) {
    return refuse('invalid-argument', 'parentId must be a positive integer or null.');
  }
  if (mode !== 'auto' && mode !== 'root' && mode !== 'daughter') {
    return refuse('invalid-argument', `mode must be auto, root or daughter, not ${String(mode)}.`);
  }
  if (mode === 'daughter' && parentId === null) {
    return refuse('invalid-argument', 'mode daughter needs a parentId.');
  }

  const rigRows = (await tx.execute(
    sql`SELECT prefix, next_root FROM rig WHERE id = ${rigId} FOR UPDATE`,
  )) as unknown as { prefix: string; next_root: number | string }[];
  const rig = rigRows[0];
  if (!rig) return refuse('missing-rig', `Rig ${rigId} does not exist.`);

  let root: number;
  let child = 0;

  if (parentId === null) {
    const [highest] = (await tx.execute(
      sql`SELECT ${HIGHEST_MINTABLE_ROOT} AS highest, (SELECT next_root FROM rig WHERE id = ${rigId}) AS next_root`,
    )) as unknown as { highest: number | string; next_root: number | string }[];
    root = Math.max(Number(highest.highest) + 1, Number(highest.next_root), 1);
  } else {
    // The parent's identity comes from the ledger by issue id. A title is never parsed:
    // a title is text a person can edit, and the ledger is the record.
    const parentRows = (await tx.execute(
      sql`SELECT bi.root, bi.child, bi.local_token, bi.rig_id, i.project_id
            FROM bead_identity bi
            JOIN issue i ON i.id = bi.issue_id
           WHERE bi.issue_id = ${parentId}`,
    )) as unknown as {
      root: number | string | null;
      child: number | string | null;
      local_token: string;
      rig_id: number | string;
      project_id: number | string;
    }[];
    const parent = parentRows[0];
    if (!parent) {
      return refuse(
        'parent-without-identity',
        `Parent ${parentId} holds no bead identity, so it cannot take a daughter.`,
      );
    }
    if (Number(parent.project_id) !== projectId) {
      return refuse('parent-other-project', `Parent ${parentId} is not in project ${projectId}.`);
    }
    if (Number(parent.rig_id) !== rigId) {
      return refuse('parent-other-rig', `Parent ${parentId} belongs to another rig.`);
    }

    const position = ledgerPosition(parent.root, parent.child, parent.local_token);
    const parentRoot = position.root;
    const parentChild = position.child;
    const canTakeDaughter = parentRoot !== null && parentChild === 0;
    if (mode === 'daughter' && !canTakeDaughter) {
      return refuse(
        'parent-not-a-root',
        `Parent ${parentId} cannot take a daughter; it is not a root with a numeric number.`,
      );
    }
    if (mode === 'root' || !canTakeDaughter) {
      // An imported hash or multidot parent, or a parent that is already a daughter: the
      // new issue takes its own root and keeps the real parent link. No two-part token is
      // ever invented beyond a child of a root.
      const [highest] = (await tx.execute(
        sql`SELECT ${HIGHEST_MINTABLE_ROOT} AS highest, (SELECT next_root FROM rig WHERE id = ${rigId}) AS next_root`,
      )) as unknown as { highest: number | string; next_root: number | string }[];
      root = Math.max(Number(highest.highest) + 1, Number(highest.next_root), 1);
    } else {
      root = parentRoot;
      const [childRow] = (await tx.execute(highestChild(rigId, parentRoot))) as unknown as {
        highest: number | string;
      }[];
      child = Math.max(Number(childRow.highest), 0) + 1;
    }
  }

  // The counter only ever moves forward, which is what the C1 guard checks on update.
  await tx.execute(
    sql`UPDATE rig SET next_root = GREATEST(next_root, ${root + 1}) WHERE id = ${rigId}`,
  );

  const localToken = token(root, child);
  return {
    ok: true,
    allocation: {
      rigId,
      prefix: rig.prefix,
      root,
      child,
      localToken,
      beadId: `${rig.prefix}-${localToken}`,
    },
  };
}

export interface AttachInput {
  allocation: BeadAllocation;
  issueId: number;
}

// Inserts the ledger row already attached to the issue. The issue must already carry the
// matching bead_id, because a row that disagrees with its issue would be a second truth
// about one card, and the C1 guard forbids fixing that later by reattaching.
export async function attachBeadIdentity(
  tx: IdentityTransaction,
  input: AttachInput,
): Promise<AllocationResult> {
  const { allocation, issueId } = input;
  if (!positiveInteger(issueId))
    return refuse('invalid-argument', 'issueId must be a positive integer.');

  const issueRows = (await tx.execute(
    sql`SELECT bead_id FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as { bead_id: string | null }[];
  const issue = issueRows[0];
  if (!issue) return refuse('issue-not-ready', `Issue ${issueId} does not exist.`);
  if (issue.bead_id !== allocation.beadId) {
    return refuse(
      'issue-not-ready',
      `Issue ${issueId} carries bead_id ${issue.bead_id ?? 'none'}, not ${allocation.beadId}.`,
    );
  }

  // A duplicate token or a second ledger row for one issue is an expected refusal, so it
  // runs inside a savepoint: the violation rolls back to that point and the caller's
  // transaction stays usable. The driver wraps the code one level down in `cause`, so both
  // shapes are read.
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(
        sql`INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
            VALUES (${allocation.rigId}, ${allocation.localToken}, ${allocation.root},
                    ${allocation.child}, 'minted', ${issueId})`,
      );
    });
  } catch (error) {
    if (sqlState(error) === '23505') {
      return refuse(
        'conflict',
        `Token ${allocation.localToken} or issue ${issueId} is already in the ledger.`,
      );
    }
    throw error;
  }
  return { ok: true, allocation };
}
