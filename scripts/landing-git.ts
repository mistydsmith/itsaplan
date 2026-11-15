// scripts/landing-git.ts — sentinel-prod-8429 auto-lander unit 3: read-only Git eligibility.
// WHY read-only: it moves nothing. The process that runs git is landing-git-runner.ts.

import { parseSubject, type LandingReceipt } from './landing-evidence';
import { execRunner } from './landing-git-runner';

export { execRunner, sanitizedEnv } from './landing-git-runner';

export interface GitPolicy {
  repo: string;
  /** EXACT ref, e.g. refs/heads/main; a short name is refused rather than resolved to something else. */
  targetRef: string;
  /** Protected surfaces kept by hand: component-boundary prefix when it ends in '/', else substring. */
  excludedPathPatterns: string[];
}

export type GitCode =
  | 'POLICY_INVALID'
  | 'RECEIPT_INVALID'
  | 'SHA_INVALID'
  | 'CANDIDATE_MISSING'
  | 'BASE_MISSING'
  | 'CANDIDATE_IS_MERGE'
  | 'BASE_NOT_ANCESTOR'
  | 'TARGET_MISSING'
  | 'ALREADY_LANDED'
  | 'STALE_TARGET'
  | 'SUBJECT_INVALID'
  | 'EMPTY_FOOTPRINT'
  | 'PATHS_MISMATCH'
  | 'EXCLUDED_PATH'
  | 'AUTHORSHIP_TRAILER'
  | 'GIT_FAILED';

export interface GitFacts {
  candidateSha: string;
  baseSha: string;
  targetSha: string;
  subject: string;
  body: string;
  changedPaths: string[];
}

export interface GitDecision {
  eligible: boolean;
  code?: GitCode;
  reason: string;
  facts?: GitFacts;
}

export interface GitRunner {
  run(args: readonly string[]): { status: number; stdout: string; stderr: string };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const EXACT_REF = /^refs\/[A-Za-z0-9._/-]+$/;
const GLOB_LOOKING = /[*?[\]]/;
// WHY separate from the glob test: a caret, dollar or backslash is regex syntax, and a doubled slash is a
// malformed path; both must be refused with the normalized pattern named, never silently reinterpreted.
const REGEX_LOOKING = /[\\^$]/;

export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value);
}

function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
}

function refusal(code: GitCode, reason: string): GitDecision {
  return { eligible: false, code, reason };
}

// A slash-terminated pattern matches at a path-component boundary at any depth; otherwise a literal
// substring. Case-insensitive, and normalized for surrounding space, './' and leading slashes.
// WHY explicit normalisation: "/Legal/" and "Legal/ " looked protective and protected nothing.
export function normalisePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

export function matches(path: string, pattern: string): boolean {
  const target = path.toLowerCase();
  const needle = normalisePattern(pattern);
  if (!needle) return false;
  if (!needle.endsWith('/')) return target.includes(needle);
  return target.startsWith(needle) || target.includes('/' + needle);
}

// WHY before anything runs: a missing repo, blank pattern or glob must refuse rather than throw, and an
// empty policy would silently automate every protected surface.
export function validatePolicy(policy: unknown): GitDecision | null {
  if (typeof policy !== 'object' || policy === null)
    return refusal('POLICY_INVALID', 'no policy was supplied');
  const row = policy as Record<string, unknown>;
  if (typeof row.repo !== 'string' || row.repo.trim() === '')
    return refusal('POLICY_INVALID', 'no repository');
  if (typeof row.targetRef !== 'string' || !EXACT_REF.test(row.targetRef)) {
    return refusal(
      'POLICY_INVALID',
      `the policy target is not an exact ref: ${String(row.targetRef)}`,
    );
  }
  const patterns = row.excludedPathPatterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return refusal(
      'POLICY_INVALID',
      'the policy protects no paths, so every surface would be automated',
    );
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.trim() === '')
      return refusal('POLICY_INVALID', 'blank pattern');
    if (GLOB_LOOKING.test(pattern))
      return refusal('POLICY_INVALID', `pattern ${pattern} looks like a glob`);
    // WHY these refuse rather than being interpreted: a caret, a dollar sign or a backslash means
    // the operator wrote a regular expression, and quietly reading it as a literal would protect
    // something other than what they asked for. A doubled slash is a malformed path, not a deeper
    // prefix, so it refuses too instead of being collapsed.
    if (REGEX_LOOKING.test(pattern)) {
      return refusal(
        'POLICY_INVALID',
        `pattern ${normalisePattern(pattern)} looks like a regular expression`,
      );
    }
    if (normalisePattern(pattern).includes('//')) {
      return refusal(
        'POLICY_INVALID',
        `pattern ${normalisePattern(pattern)} contains a doubled slash`,
      );
    }
    if (!normalisePattern(pattern))
      return refusal('POLICY_INVALID', `pattern ${pattern} names nothing after /`);
  }
  return null;
}

// WHY the receipt is validated too: `allowedPaths = 7` threw, and a string became one reason per character.
export function validateReceipt(receipt: unknown): GitDecision | null {
  if (typeof receipt !== 'object' || receipt === null)
    return refusal('RECEIPT_INVALID', 'no receipt was supplied');
  const row = receipt as Record<string, unknown>;
  if (typeof row.itemKey !== 'string' || row.itemKey.trim() === '') {
    return refusal('RECEIPT_INVALID', 'the receipt names no item key');
  }
  const paths = row.allowedPaths;
  if (!Array.isArray(paths) || paths.length === 0)
    return refusal('RECEIPT_INVALID', 'no declared path list');
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim() === '')
      return refusal('RECEIPT_INVALID', 'blank declared path');
  }
  if (!isFullSha(row.candidateSha) || !isFullSha(row.baseSha)) {
    return refusal('SHA_INVALID', 'the receipt does not carry two full 40-hex SHAs');
  }
  return null;
}

// WHY leading whitespace counts and only these two keys are banned: an indented trailer is the same
// trailer, while a blacklist of every Generated-by phrasing would refuse honest messages.
const TRAILER = /^[ \t]*(co-authored-by|claude-session)[ \t]*:/im;
const CLAUDE_IDENTITY = /claude|anthropic/i;

export function hasAuthorshipTrailer(message: string): boolean {
  return new RegExp(TRAILER.source, TRAILER.flags).test(message);
}

type ReceiptFacts = Pick<LandingReceipt, 'allowedPaths' | 'itemKey'> & {
  candidateSha: string;
  baseSha: string;
};

// 'land' judges a candidate that has not landed. 'published-exact-tip' judges one that has, for the
// retry of a failed record: the target must be exactly the candidate, and every other check still runs.
export type GitEligibilityMode = 'land' | 'published-exact-tip';

// Decides whether Git facts allow this candidate to land, in the order an operator would ask, with a named
// code and a bounded reason for every refusal and no meaning inferred from an unknown exit code.
export function evaluateGitEligibility(
  policy: GitPolicy,
  receipt: ReceiptFacts,
  runner?: GitRunner,
  mode: GitEligibilityMode = 'land',
): GitDecision {
  // WHY the runner is built after validation: a default parameter is evaluated before the body, so
  // `runner = execRunner(policy.repo)` crashed on a null policy instead of returning POLICY_INVALID.
  const policyRefusal = validatePolicy(policy);
  if (policyRefusal) return policyRefusal;
  const receiptRefusal = validateReceipt(receipt);
  if (receiptRefusal) return receiptRefusal;
  const git = runner ?? execRunner(policy.repo);
  const { candidateSha, baseSha } = receipt;
  const run = (args: string[]) => git.run(args);
  // 1 is absent and anything else is a real failure, so absence is never inferred from 128.
  const exists = (sha: string): boolean | null => {
    const out = run(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return out.status === 0 ? true : out.status === 1 ? false : null;
  };
  const parentsOf = (sha: string): number | null => {
    const out = run(['rev-list', '--parents', '-n', '1', sha]);
    if (out.status !== 0) return null;
    const fields = out.stdout.split('\n')[0]?.trim().split(' ').filter(Boolean) ?? [];
    return fields.length === 0 ? null : Math.max(0, fields.length - 1);
  };
  const ancestor = (a: string, b: string): boolean | null => {
    const out = run(['merge-base', '--is-ancestor', a, b]);
    return out.status === 0 ? true : out.status === 1 ? false : null;
  };
  // WHY --quiet: 1 means the ref is absent, while 128 means git could not answer.
  const resolve = (ref: string): string | null | 'error' => {
    const out = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (out.status === 1) return null;
    if (out.status !== 0) return 'error';
    const sha = out.stdout.trim();
    return isFullSha(sha) ? sha : 'error';
  };

  // WHY the repository is checked before any object question: a nonexistent or refused repository also
  // answers 128, so without this an unreadable repo looks like an absent commit.
  if (run(['rev-parse', '--git-dir']).status !== 0) {
    return refusal('GIT_FAILED', `the repository ${policy.repo} is not readable by git`);
  }

  const candidatePresent = exists(candidateSha);
  if (candidatePresent === null) {
    const detail = brief(
      git.run(['rev-parse', '--verify', '--quiet', `${candidateSha}^{commit}`]).stderr,
    );
    return refusal('GIT_FAILED', `git could not answer whether the candidate exists: ${detail}`);
  }
  if (!candidatePresent)
    return refusal('CANDIDATE_MISSING', `candidate ${candidateSha} is not a commit`);

  const basePresent = exists(baseSha);
  if (basePresent === null)
    return refusal('GIT_FAILED', 'git could not answer whether the base exists');
  if (!basePresent) return refusal('BASE_MISSING', `base ${baseSha} is not a commit`);

  const parents = parentsOf(candidateSha);
  if (parents === null) return refusal('GIT_FAILED', 'git could not count the candidate parents');
  if (parents > 1)
    return refusal(
      'CANDIDATE_IS_MERGE',
      `candidate ${candidateSha} is a merge of ${parents} parents`,
    );

  const contains = ancestor(baseSha, candidateSha);
  if (contains === null) return refusal('GIT_FAILED', 'git could not compare base and candidate');
  // WHY ancestry and not direct parenthood: a reviewed chain of commits lands as one candidate.
  if (!contains)
    return refusal(
      'BASE_NOT_ANCESTOR',
      `candidate ${candidateSha} does not contain base ${baseSha}`,
    );

  const resolved = resolve(policy.targetRef);
  if (resolved === null)
    return refusal('TARGET_MISSING', `target ${policy.targetRef} does not resolve`);
  if (resolved === 'error')
    return refusal('GIT_FAILED', `git could not resolve ${policy.targetRef}`);
  const targetSha = resolved;
  const landed = ancestor(candidateSha, targetSha);
  if (landed === null)
    return refusal('GIT_FAILED', 'git could not tell whether the candidate already landed');
  // WHY only these two refusals differ by mode: a published candidate is by definition in the target and
  // the target is no longer the base. The subject, path, exclusion and authorship checks below are the
  // reviewed landing's own facts and hold for it after the publish exactly as before.
  const publishedTip = mode === 'published-exact-tip' && targetSha === candidateSha;
  if (landed && !publishedTip)
    return refusal('ALREADY_LANDED', `candidate ${candidateSha} is already in ${policy.targetRef}`);
  if (mode === 'published-exact-tip' && !publishedTip) {
    return refusal(
      'STALE_TARGET',
      `target ${policy.targetRef} is ${targetSha}, not the published candidate ${candidateSha}`,
    );
  }

  // WHY stale target refuses: the receipt and verdict were written against one base; a moved target means
  // the reviewed sha no longer describes what would land, so a fresh exact-sha PASS is needed.
  if (!publishedTip && targetSha !== baseSha) {
    return refusal(
      'STALE_TARGET',
      `target ${policy.targetRef} is ${targetSha}, the receipt base is ${baseSha}`,
    );
  }

  const shown = run(['show', '-s', '--format=%s%x00%b', candidateSha]);
  if (shown.status !== 0) return refusal('GIT_FAILED', 'git could not read the candidate message');
  const [rawSubject = '', body = ''] = shown.stdout.split('\x00');
  const message = { subject: rawSubject.trim(), body: body.trim() };
  const subject = parseSubject(message.subject);
  if (typeof subject !== 'object')
    return refusal('SUBJECT_INVALID', 'the candidate subject does not start with the item key');
  if (subject.itemKey !== receipt.itemKey) {
    return refusal(
      'SUBJECT_INVALID',
      `subject names ${subject.itemKey}, the receipt names ${receipt.itemKey}`,
    );
  }

  const diff = run(['diff', '--name-only', '--no-renames', '-z', baseSha, candidateSha]);
  if (diff.status !== 0) return refusal('GIT_FAILED', 'git could not list the changed paths');
  const paths = diff.stdout.split('\0').filter((entry) => entry !== '');
  if (paths.length === 0) return refusal('EMPTY_FOOTPRINT', 'the candidate changes no path');
  const declared = new Set(receipt.allowedPaths);
  const undeclared = paths.filter((path) => !declared.has(path));
  const unmatched = [...declared].filter((path) => !paths.includes(path));
  if (undeclared.length > 0 || unmatched.length > 0) {
    const parts = [];
    if (undeclared.length > 0) parts.push(`changed but not declared: ${undeclared.join(', ')}`);
    if (unmatched.length > 0) parts.push(`declared but unchanged: ${unmatched.join(', ')}`);
    return refusal('PATHS_MISMATCH', parts.join('; '));
  }

  // WHY policy rather than a built-in list: manual, gated and legal surfaces belong to the operator.
  const excluded = paths.filter((path) =>
    policy.excludedPathPatterns.some((pattern) => matches(path, pattern)),
  );
  if (excluded.length > 0)
    return refusal('EXCLUDED_PATH', `policy keeps these paths by hand: ${excluded.join(', ')}`);

  const log = run(['log', '--format=%B%x1f%an <%ae>|%cn <%ce>%x1e', `${baseSha}..${candidateSha}`]);
  if (log.status !== 0) return refusal('GIT_FAILED', 'git could not read the landed commits');
  const entries = log.stdout
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [msg = '', identity = ''] = entry.split('\x1f');
      return { message: msg.trim(), identity: identity.trim() };
    });
  // WHY identities too: a clean message from a prohibited author is still prohibited authorship.
  const prohibited = entries.filter((entry) => CLAUDE_IDENTITY.test(entry.identity));
  if (prohibited.length > 0) {
    return refusal(
      'AUTHORSHIP_TRAILER',
      `${prohibited.length} landed commit(s) carry a Claude identity`,
    );
  }
  const offenders = entries.filter((entry) => hasAuthorshipTrailer(entry.message));
  if (offenders.length > 0) {
    return refusal(
      'AUTHORSHIP_TRAILER',
      `${offenders.length} landed message(s) carry a Co-Authored-By or Claude-Session trailer`,
    );
  }

  return {
    eligible: true,
    reason: publishedTip
      ? `candidate ${candidateSha} is the tip of ${policy.targetRef} with ${paths.length} declared path(s)`
      : `candidate ${candidateSha} may land on ${policy.targetRef} with ${paths.length} declared path(s)`,
    facts: {
      candidateSha,
      baseSha,
      targetSha,
      subject: message.subject,
      body: message.body,
      changedPaths: paths,
    },
  };
}
