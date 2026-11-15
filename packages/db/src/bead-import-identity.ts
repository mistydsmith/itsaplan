import { sql } from 'drizzle-orm';
import { highestMintableRoot, sqlState, type IdentityTransaction } from './issue-identity';

// WHY this exists: the REST import path cannot express a historical identity. A card
// created over the API after the rig activates arrives with issue.bead_id NULL and no
// ledger row, which is a card with no past. A one-off bd import instead stamps the
// ledger directly, inside the caller's import transaction, with no client authority:
// the only caller is the controlled pre-activation import pipeline.
//
// Shape rules come from the schema (schema/app.ts, bead_identity) and the minted
// owner (issue-identity.ts), and none of them are relaxed here:
// - root and child stay NULL. The schema says NULL "only on an import": an import
//   keeps the exact source id text in local_token and invents no coordinates.
// - origin is 'imported' and is never rewritten into a minted shape; a token that is
//   already live in another form is a refusal, not an overwrite.
// - a retained non-ticket row (the bd memory rows) gets issue_id NULL, a tombstone:
//   "a live issue holds one identity; many tombstones hold none".
// - rig.next_root is moved above the highest numeric root the ledger now holds, so a
//   later mint cannot collide with an imported number. The rig is already locked FOR
//   UPDATE, so the advance is atomic with the stamp.

export type ImportIdentityRefusalCode =
  'invalid-argument' | 'missing-rig' | 'issue-not-ready' | 'conflict';

export interface ImportIdentityOk {
  ok: true;
  beadId: string;
  // True when the ledger already held exactly this identity for exactly this issue:
  // the import may be re-run over a partially imported board without double-stamping.
  alreadyPresent: boolean;
}

export interface ImportIdentityRefusal {
  ok: false;
  code: ImportIdentityRefusalCode;
  message: string;
}

export type ImportIdentityResult = ImportIdentityOk | ImportIdentityRefusal;

export interface ImportIdentityInput {
  rigId: number;
  // The exact source id, stored verbatim in local_token (e.g. '8363.1').
  localToken: string;
  // The created issue to attach the identity to; null stamps a tombstone for a
  // retained non-ticket row.
  issueId: number | null;
}

function refuse(code: ImportIdentityRefusalCode, message: string): ImportIdentityRefusal {
  return { ok: false, code, message };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Mirrors the schema check bead_identity_local_token_check ('^[^[:space:]]+$'): a
// token is non-empty text without whitespace. The database is the final authority.
function validToken(token: string): boolean {
  return typeof token === 'string' && /^\S+$/.test(token);
}

// The counter only ever moves forward, which is what the C1 guard checks on update.
// highestMintableRoot(rigId) is the owner's parameterized helper (issue-identity.ts):
// it binds its own rig_id, so this standalone SELECT cannot leave a placeholder unbound,
// and it reads imported numeric tokens too, so one statement covers both shapes.
async function advanceNextRoot(tx: IdentityTransaction, rigId: number): Promise<void> {
  const [highest] = (await tx.execute(
    sql`SELECT ${highestMintableRoot(rigId)} AS highest`,
  )) as unknown as { highest: number | string }[];
  await tx.execute(
    sql`UPDATE rig SET next_root = GREATEST(next_root, ${Number(highest.highest) + 1}) WHERE id = ${rigId}`,
  );
}

export async function importBeadIdentity(
  tx: IdentityTransaction,
  input: ImportIdentityInput,
): Promise<ImportIdentityResult> {
  const { rigId, localToken, issueId } = input;
  if (!positiveInteger(rigId))
    return refuse('invalid-argument', 'rigId must be a positive integer.');
  if (!validToken(localToken)) {
    return refuse(
      'invalid-argument',
      'localToken must be non-empty text without whitespace; it is the exact source id.',
    );
  }
  if (issueId !== null && !positiveInteger(issueId)) {
    return refuse(
      'invalid-argument',
      'issueId must be a positive integer or null (null stamps a tombstone).',
    );
  }

  // Lock the rig before anything else, the same way allocation does: the prefix is
  // read here and the next_root advance below must not race a concurrent mint.
  const rigRows = (await tx.execute(
    sql`SELECT prefix, next_root FROM rig WHERE id = ${rigId} FOR UPDATE`,
  )) as unknown as { prefix: string; next_root: number | string }[];
  const rig = rigRows[0];
  if (!rig) return refuse('missing-rig', `Rig ${rigId} does not exist.`);

  const beadId = `${rig.prefix}-${localToken}`;

  let stampIssue = false;
  if (issueId !== null) {
    const issueRows = (await tx.execute(
      sql`SELECT bead_id FROM issue WHERE id = ${issueId} FOR UPDATE`,
    )) as unknown as { bead_id: string | null }[];
    const issue = issueRows[0];
    if (!issue) return refuse('issue-not-ready', `Issue ${issueId} does not exist.`);
    // An issue that already carries a DIFFERENT identity is a second truth about one
    // card; the minted owner forbids repairing that, and an import must not do it either.
    if (issue.bead_id !== null && issue.bead_id !== beadId) {
      return refuse(
        'conflict',
        `Issue ${issueId} already carries bead_id ${issue.bead_id}, not ${beadId}.`,
      );
    }
    // The minted flow stamps the issue before the ledger row exists, because a row
    // that disagrees with its issue would be a second truth. The import does the same.
    if (issue.bead_id === null) stampIssue = true;
  }

  let alreadyPresent = false;
  try {
    // ONE savepoint covers stamp + ledger row + counter advance. An expected conflict
    // must roll back everything this operation did - including the issue stamp - or a
    // caller that commits would leave a card stamped with an identity its ledger does
    // not hold (Root, 8363.1 review, 2026-11-15): a second truth about one card. The
    // savepoint keeps the conflict a refusal return, not a throw, and the caller's
    // transaction stays usable afterwards.
    await tx.transaction(async (sp) => {
      if (stampIssue) {
        await sp.execute(sql`UPDATE issue SET bead_id = ${beadId} WHERE id = ${issueId}`);
      }
      await sp.execute(
        sql`INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
            VALUES (${rigId}, ${localToken}, NULL, NULL, 'imported', ${issueId})`,
      );
      await advanceNextRoot(sp, rigId);
    });
  } catch (error) {
    if (sqlState(error) !== '23505') throw error;
    // The savepoint has rolled back the stamp, the row and the counter; the caller's
    // transaction is untouched apart from the locks it still holds. A duplicate is an
    // expected refusal: read what is already there and decide between an idempotent
    // re-run and a real conflict. The driver wraps the code one level down in `cause`,
    // which sqlState reads.
    const existing = (await tx.execute(
      sql`SELECT rig_id, local_token, issue_id FROM bead_identity
          WHERE rig_id = ${rigId} AND local_token = ${localToken}`,
    )) as unknown as {
      rig_id: number | string;
      local_token: string;
      issue_id: number | string | null;
    }[];
    const row = existing[0];
    const rowIssueId = row?.issue_id == null ? null : Number(row.issue_id);
    if (row && rowIssueId === issueId) {
      alreadyPresent = true;
      // The re-run found what an earlier pass left behind. The counter is still moved
      // forward so a later mint skips the imported number; the move is a no-op when the
      // first pass already made it, because the counter only ever moves forward.
      await advanceNextRoot(tx, rigId);
    } else {
      return refuse(
        'conflict',
        row
          ? `Token ${localToken} is already in the ledger attached to ${rowIssueId === null ? 'no issue' : `issue ${rowIssueId}`}.`
          : `Issue ${issueId} already holds another bead identity.`,
      );
    }
  }

  return { ok: true, beadId, alreadyPresent };
}
