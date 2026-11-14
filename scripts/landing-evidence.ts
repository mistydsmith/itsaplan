// scripts/landing-evidence.ts — sentinel-prod-8429 auto-lander unit 1 (R3, after Root's second RETURN).
// WHY pure: provable with no database, ref move or network. WHY every entry point validates: ten fail-open
// holes returned eligible:true while only the parsers checked. WHY refusals, not filters: dropping evidence
// is how an older PASS survived a newer RETURN.

export type VerdictDecision = 'PASS' | 'RETURN' | 'FAIL' | 'HOLD';

export interface LandingOutcome {
  name: string;
  passed: number;
  failed: number;
}

// candidateSha lands (40 lowercase hex); baseSha is what it was composed on, and must differ.
export interface LandingReceipt {
  id: string;
  itemKey: string;
  candidateSha: string;
  baseSha: string;
  author: string;
  allowedPaths: string[];
  namedTests: string[];
  outcomes: LandingOutcome[];
}

export interface ReviewVerdict {
  id: string;
  reviewer: string;
  sha: string;
  decision: VerdictDecision;
  sequence: number;
}

export type RefusalCode =
  | 'IDENTITY_MISSING'
  | 'ITEM_KEY_MISSING'
  | 'SUBJECT_MALFORMED'
  | 'SUBJECT_KEY_MISMATCH'
  | 'SHA_INVALID'
  | 'SHA_NOT_DISTINCT'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_FIELDS_MISSING'
  | 'RECEIPT_AMBIGUOUS'
  | 'EVIDENCE_ID_CONFLICT'
  | 'VERDICT_MISSING'
  | 'VERDICT_INVALID'
  | 'VERDICT_SEQUENCE_INVALID'
  | 'VERDICT_SEQUENCE_TIE'
  | 'VERDICT_SHA_MISMATCH'
  | 'VERDICT_NOT_PASS'
  | 'NOT_INDEPENDENT_REVIEWER'
  | 'NAMED_TEST_FAILED'
  | 'RECEIPT_OUTCOMES_MISMATCH'
  | 'ITEM_CANCELED'
  | 'ITEM_ARCHIVED';

export interface ItemState {
  itemKey: string;
  status?: string;
  archived?: boolean;
}

export interface LandingDecision {
  eligible: boolean;
  code?: RefusalCode;
  reason: string;
  partial: boolean;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
// Imported ledger tokens are verbatim non-whitespace, including hashes and multiple dots.
// Read the full subject key up to its delimiter; evaluateLanding checks the exact stored key.
const KEY_TOKEN = /^(\S+-\S+?)(?=:\s|\s+\(partial\)\s*:)/;
const FULL_REST = /^:\s+\S/;
const PARTIAL_REST = /^\s+\(partial\)\s*:\s+\S/i;
const ANY_PARTIAL = /\(partial\)/i;

export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value);
}

/** Identity ignores space and case, so ` DSH ` is the author; empty stays empty. */
export function normaliseIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

export function parseSubject(
  subject: unknown,
): { itemKey: string; partial: boolean } | RefusalCode {
  if (typeof subject !== 'string' || subject.trim() === '') return 'SUBJECT_MALFORMED';
  const text = subject.trim();
  const match = text.match(KEY_TOKEN);
  if (!match) return 'SUBJECT_MALFORMED';
  const itemKey = match[1];
  const rest = text.slice(itemKey.length);
  if (PARTIAL_REST.test(rest)) return { itemKey, partial: true };
  // Prose mentioning partial is not a marker: whether a landing completes cannot depend on a sentence.
  if (ANY_PARTIAL.test(rest)) return 'SUBJECT_MALFORMED';
  if (!FULL_REST.test(rest)) return 'SUBJECT_MALFORMED';
  return { itemKey, partial: false };
}

function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (!trimmed) return null;
    out.push(trimmed);
  }
  return out;
}

function asOutcomes(value: unknown): LandingOutcome[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: LandingOutcome[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const passed = row.passed;
    const failed = row.failed;
    if (!name) return null;
    if (typeof passed !== 'number' || !Number.isInteger(passed) || passed < 0) return null;
    if (typeof failed !== 'number' || !Number.isInteger(failed) || failed < 0) return null;
    if (passed + failed === 0) return null;
    out.push({ name, passed, failed });
  }
  return out;
}

export function parseReceipt(input: unknown): LandingReceipt | RefusalCode {
  if (typeof input !== 'object' || input === null) return 'RECEIPT_MISSING';
  const row = input as Record<string, unknown>;
  const candidateSha = typeof row.candidateSha === 'string' ? row.candidateSha.trim() : '';
  const baseSha = typeof row.baseSha === 'string' ? row.baseSha.trim() : '';
  if (!isFullSha(candidateSha) || !isFullSha(baseSha)) return 'SHA_INVALID';
  if (candidateSha === baseSha) return 'SHA_NOT_DISTINCT';
  const itemKey = typeof row.itemKey === 'string' ? row.itemKey.trim() : '';
  if (!itemKey) return 'ITEM_KEY_MISSING';
  const author = typeof row.author === 'string' ? row.author.trim() : '';
  if (!normaliseIdentity(author)) return 'IDENTITY_MISSING';
  const allowedPaths = asStrings(row.allowedPaths);
  const namedTests = asStrings(row.namedTests);
  const outcomes = asOutcomes(row.outcomes);
  if (!allowedPaths || !namedTests || !outcomes) return 'RECEIPT_FIELDS_MISSING';
  // WHY test-by-test: an aggregate outcome lets a missing result in; each named test needs its own.
  const declared = new Set(namedTests);
  if (declared.size !== namedTests.length) return 'RECEIPT_OUTCOMES_MISMATCH';
  if (new Set(outcomes.map((outcome) => outcome.name)).size !== outcomes.length) {
    return 'RECEIPT_OUTCOMES_MISMATCH';
  }
  for (const outcome of outcomes)
    if (!declared.has(outcome.name)) return 'RECEIPT_OUTCOMES_MISMATCH';
  if (outcomes.length !== declared.size) return 'RECEIPT_OUTCOMES_MISMATCH';
  const id =
    typeof row.id === 'string' && row.id.trim()
      ? row.id.trim()
      : `${itemKey}:${candidateSha}:receipt`;
  return {
    id,
    itemKey,
    candidateSha,
    baseSha,
    author,
    allowedPaths,
    namedTests,
    outcomes,
  };
}

export function parseVerdict(input: unknown): ReviewVerdict | RefusalCode {
  if (typeof input !== 'object' || input === null) return 'VERDICT_INVALID';
  const row = input as Record<string, unknown>;
  const sha = typeof row.sha === 'string' ? row.sha.trim().toLowerCase() : '';
  if (!isFullSha(sha)) return 'VERDICT_INVALID';
  const reviewer = typeof row.reviewer === 'string' ? row.reviewer.trim() : '';
  if (!normaliseIdentity(reviewer)) return 'IDENTITY_MISSING';
  const raw = typeof row.decision === 'string' ? row.decision.trim().toUpperCase() : '';
  if (raw !== 'PASS' && raw !== 'RETURN' && raw !== 'FAIL' && raw !== 'HOLD')
    return 'VERDICT_INVALID';
  // Every verdict uses its explicit transport sequence; array position is a different clock.
  const sequence = row.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || !Number.isFinite(sequence)) {
    return 'VERDICT_SEQUENCE_INVALID';
  }
  const id =
    typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `${reviewer}:${sha}:${sequence}`;
  return { id, reviewer, sha, decision: raw as VerdictDecision, sequence };
}

/** Collapses only *identical* repeats; a reused id with different content is a conflict. */
export function dedupeEvidence<T>(rows: readonly T[]): {
  rows: T[];
  conflict: boolean;
} {
  const byId = new Map<string, T>();
  let conflict = false;
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    const key = typeof id === 'string' ? id : '';
    const seen = byId.get(key);
    if (seen === undefined) byId.set(key, row);
    else if (JSON.stringify(seen) !== JSON.stringify(row)) conflict = true;
  }
  return { rows: [...byId.values()], conflict };
}

export function latestVerdict(
  verdicts: readonly ReviewVerdict[],
  sha: string,
): { verdict?: ReviewVerdict; tie: boolean } {
  const matching = verdicts.filter((verdict) => verdict.sha === sha);
  if (matching.length === 0) return { tie: false };
  let top = matching[0];
  let tie = false;
  for (const verdict of matching.slice(1)) {
    if (verdict.sequence > top.sequence) {
      top = verdict;
      tie = false;
    } else if (verdict.sequence === top.sequence) tie = true;
  }
  return { verdict: top, tie };
}

export interface LandingInput {
  item: ItemState;
  receipt: unknown;
  verdicts: readonly unknown[];
  subject: unknown;
}

/** The single eligibility decision, runtime-validating so a typed caller that hands junk refuses. */
export function evaluateLanding(input: LandingInput): LandingDecision {
  const subject = parseSubject(input.subject);
  const partial = typeof subject === 'object' && subject.partial;
  const refuse = (code: RefusalCode, reason: string): LandingDecision => ({
    eligible: false,
    code,
    reason,
    partial,
  });
  if (typeof subject !== 'object') {
    return refuse(
      'SUBJECT_MALFORMED',
      'the landed subject does not start with an item key and ":"',
    );
  }
  const status = (input.item.status ?? '').trim().toLowerCase();
  if (status === 'canceled' || status === 'cancelled') {
    return refuse('ITEM_CANCELED', 'item is canceled: terminal, and never a successful landing');
  }
  if (input.item.archived || status === 'archived') {
    return refuse('ITEM_ARCHIVED', 'item is archived: archived is not an eligibility state');
  }
  const receipt = parseReceipt(input.receipt);
  if (typeof receipt === 'string')
    return refuse(receipt, 'the landing receipt is not valid evidence');
  if (receipt.itemKey !== input.item.itemKey) {
    return refuse(
      'ITEM_KEY_MISSING',
      `receipt names ${receipt.itemKey}, item is ${input.item.itemKey}`,
    );
  }
  if (subject.itemKey !== receipt.itemKey) {
    return refuse(
      'SUBJECT_KEY_MISMATCH',
      `subject names ${subject.itemKey}, the receipt names ${receipt.itemKey}`,
    );
  }
  const failing = receipt.outcomes.filter((outcome) => outcome.failed > 0);
  if (failing.length > 0) {
    const detail = failing.map((outcome) => `${outcome.name} ${outcome.failed} failed`).join(', ');
    return refuse('NAMED_TEST_FAILED', `named tests did not all pass: ${detail}`);
  }
  const parsed: ReviewVerdict[] = [];
  for (const [index, raw] of input.verdicts.entries()) {
    const verdict = parseVerdict(raw);
    if (typeof verdict === 'string')
      return refuse(verdict, `verdict ${index + 1} is not valid evidence`);
    parsed.push(verdict);
  }
  const deduped = dedupeEvidence(parsed);
  if (deduped.conflict)
    return refuse('EVIDENCE_ID_CONFLICT', 'the same verdict id carries two facts');
  const newest = latestVerdict(deduped.rows, receipt.candidateSha);
  if (!newest.verdict)
    return refuse('VERDICT_MISSING', `no verdict names the candidate ${receipt.candidateSha}`);
  if (newest.tie)
    return refuse(
      'VERDICT_SEQUENCE_TIE',
      'two verdicts on the candidate share the newest sequence',
    );
  const verdict = newest.verdict;
  if (verdict.sha !== receipt.candidateSha) {
    return refuse(
      'VERDICT_SHA_MISMATCH',
      `verdict names ${verdict.sha}, receipt names ${receipt.candidateSha}`,
    );
  }
  if (normaliseIdentity(verdict.reviewer) === normaliseIdentity(receipt.author)) {
    return refuse(
      'NOT_INDEPENDENT_REVIEWER',
      `verdict is from the author ${verdict.reviewer}, not a reviewer`,
    );
  }
  if (verdict.decision !== 'PASS')
    return refuse('VERDICT_NOT_PASS', `newest verdict on ${verdict.sha} is ${verdict.decision}`);
  return {
    eligible: true,
    reason: partial
      ? `partial landing: record the receipt on ${receipt.itemKey}, leave it unfinished`
      : `full landing: complete ${receipt.itemKey}`,
    partial,
  };
}

/** Evaluates a bundle; competing receipts refuse instead of the first one winning. */
export function evaluateBundle(
  item: ItemState,
  subject: unknown,
  receipts: readonly unknown[],
  verdicts: readonly unknown[],
): LandingDecision {
  const parsedSubject = parseSubject(subject);
  const partial = typeof parsedSubject === 'object' && parsedSubject.partial;
  const refuse = (code: RefusalCode, reason: string): LandingDecision => ({
    eligible: false,
    code,
    reason,
    partial,
  });
  if (typeof parsedSubject !== 'object')
    return refuse('SUBJECT_MALFORMED', 'the landed subject is malformed');
  const parsed = receipts.map(parseReceipt);
  const bad = parsed.find((row) => typeof row === 'string');
  if (typeof bad === 'string') return refuse(bad, 'a receipt in the bundle is not valid evidence');
  const rows = parsed as LandingReceipt[];
  if (rows.length === 0) return refuse('RECEIPT_MISSING', 'no receipt in the bundle');
  const deduped = dedupeEvidence(rows);
  if (deduped.conflict)
    return refuse('EVIDENCE_ID_CONFLICT', 'the same receipt id carries two facts');
  // WHY semantic not id: receipts on one item and candidate that disagree about base, author, paths,
  // tests or outcomes contradict each other; first-wins lets a green receipt hide a failed one.
  const semantic = new Set(deduped.rows.map((row) => JSON.stringify({ ...row, id: '' })));
  if (semantic.size > 1) {
    return refuse('RECEIPT_AMBIGUOUS', `the bundle carries ${semantic.size} conflicting receipts`);
  }
  return evaluateLanding({ item, receipt: deduped.rows[0], verdicts, subject });
}
