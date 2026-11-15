// scripts/landing-publish.ts — sentinel-prod-8429 (partial) auto-lander unit 4: the actual publisher.
// WHY it only composes owners: eligibility belongs to landing-evidence, Git facts to landing-git (which reads
// the subject from Git) and exclusion to landing-slot, so this file fixes only the order of the calls and the
// names of the endings. Nothing is invented, nothing is rolled back or forced, and no item is closed here,
// because item state has one writer by design: the final storage adapter, which does not exist yet.
import {
  evaluateBundle,
  parseReceipt,
  type ItemState,
  type LandingDecision,
  type LandingOutcome,
  type LandingReceipt,
  type RefusalCode,
} from './landing-evidence';
import {
  evaluateGitEligibility,
  execRunner,
  type GitCode,
  type GitDecision,
  type GitPolicy,
  type GitRunner,
} from './landing-git';
import { withLandingSlot, type SlotCode, type SlotDriver, type SlotOutcome } from './landing-slot';

export interface PublicationConfig {
  policy: GitPolicy;
  repoIdentity: string;
  remote: string;
  /** The one Misty-owned push URL that every push URL of that remote must equal exactly. */
  expectedPushURL: string;
}

export type PublishCode =
  | 'PUBLICATION_INVALID'
  | 'RECEIPT_UNATTRIBUTED'
  | 'PROOF_WRONG_CANDIDATE'
  | 'PROOF_NAMES_MISMATCH'
  | 'PROOF_FAILED'
  | 'EVIDENCE_CHANGED_AFTER_PROOF'
  | 'PUBLICATION_REMOTE_UNKNOWN'
  | 'PUSH_URL_MISMATCH'
  | 'SLOT_IDENTITY_MISSING'
  | 'SLOT_BUSY'
  | 'SLOT_ACQUISITION_FAILED'
  | 'SLOT_CALLBACK_FAILED'
  | 'CLEANUP_FAILED'
  | 'REF_CHANGED_AT_CAS'
  | 'REF_NOT_MOVED'
  | 'PUSH_FAILED'
  | 'REMOTE_READBACK_MISMATCH'
  | 'GIT_FAILED'
  | GitCode
  | RefusalCode;

export interface ProofRunInput {
  candidateSha: string;
  namedTests: readonly string[];
}

export interface ProofRunResult {
  candidateSha: string;
  outcomes: readonly LandingOutcome[];
}
/** Injected, so this module is provable without running a suite. */
export interface ProofRunner {
  run(input: ProofRunInput): Promise<ProofRunResult> | ProofRunResult;
}

export interface PublishInput {
  publication: PublicationConfig;
  item: ItemState;
  receipts: readonly unknown[];
  verdicts: readonly unknown[];
  slotDriver: SlotDriver;
  proofRunner: ProofRunner;
}

export interface PublishResult {
  published: boolean;
  landed: boolean;
  /** Carried from the reviewed subject: a partial candidate lands without completing the item. */
  partial: boolean;
  code?: PublishCode;
  reason: string;
  candidateSha?: string;
  targetRef?: string;
  remoteSha?: string;
  evidence?: LandingDecision;
  git?: GitDecision;
  slot?: SlotOutcome<unknown>;
  /** A slot release or close failure, reported beside the landing so it never reads as clean. */
  cleanup?: string;
}

function slotCode(code: SlotCode | undefined): PublishCode {
  if (code === 'REPO_IDENTITY_MISSING') return 'SLOT_IDENTITY_MISSING';
  if (code === 'ACQUISITION_FAILED') return 'SLOT_ACQUISITION_FAILED';
  if (code === 'RELEASE_FAILED') return 'CLEANUP_FAILED';
  return code === 'SLOT_BUSY' ? 'SLOT_BUSY' : 'SLOT_CALLBACK_FAILED';
}
const stop = (
  code: PublishCode,
  reason: string,
  extra: Partial<PublishResult> = {},
): PublishResult => ({
  published: false,
  landed: false,
  partial: false,
  code,
  reason,
  ...extra,
});

const brief = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
};
function validatePublication(publication: PublicationConfig): PublishResult | null {
  if (typeof publication !== 'object' || publication === null)
    return stop('PUBLICATION_INVALID', 'no publication config');
  if (typeof publication.repoIdentity !== 'string' || publication.repoIdentity.trim() === '')
    return stop('PUBLICATION_INVALID', 'no repository identity, so no landing slot exists');
  if (typeof publication.remote !== 'string' || publication.remote.trim() === '')
    return stop('PUBLICATION_INVALID', 'no publication remote was configured');
  const url = publication.expectedPushURL;
  if (typeof url !== 'string' || url.trim() === '' || /\s/.test(url.trim()))
    return stop('PUBLICATION_INVALID', `the expected push URL is not one URL: ${String(url)}`);
  return null;
}
function attributeReceipt(
  receipts: readonly unknown[],
): { receipt: LandingReceipt } | { refusal: string } {
  const parsed: LandingReceipt[] = [];
  for (const raw of receipts) {
    const receipt = parseReceipt(raw);
    if (typeof receipt === 'string')
      return { refusal: `a receipt is not valid evidence: ${receipt}` };
    parsed.push(receipt);
  }
  if (parsed.length === 0) return { refusal: 'no receipt was supplied' };
  const key = (row: LandingReceipt) =>
    JSON.stringify({ ...row, id: '', allowedPaths: [...row.allowedPaths].sort() });
  const [first] = parsed;
  for (const row of parsed)
    if (key(row) !== key(first))
      return { refusal: 'receipts in the bundle do not agree on the candidate facts' };
  return { receipt: first };
}
function pushURLs(
  runner: GitRunner,
  remote: string,
): { urls: string[] } | { refusal: PublishResult } {
  const out = runner.run(['remote', 'get-url', '--push', '--all', remote]);
  const urls = out.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (out.status !== 0 || urls.length === 0)
    return {
      refusal: stop(
        'PUBLICATION_REMOTE_UNKNOWN',
        `${remote} has no readable push URL: ${brief(out.stderr)}`,
      ),
    };
  return { urls };
}
/** WHY exact equality on every URL: several push URLs are tried in order, so one mirror leaks the landing. */
function checkPushURLs(publication: PublicationConfig, urls: string[]): PublishResult | null {
  const expected = publication.expectedPushURL.trim();
  const wrong = urls.filter((url) => url !== expected);
  if (wrong.length === 0) return null;
  return stop(
    'PUSH_URL_MISMATCH',
    `${wrong.length} of ${urls.length} push URL(s) for ${publication.remote} are not the configured Misty-owned URL: ${wrong.join(', ')}`,
  );
}
/** The named outcomes must match the receipt exactly, each passing, and survive the owner's own validation. */
function checkProofs(receipt: LandingReceipt, result: ProofRunResult): PublishResult | null {
  if (result.candidateSha !== receipt.candidateSha)
    return stop(
      'PROOF_WRONG_CANDIDATE',
      `the proofs ran on ${result.candidateSha}, the candidate is ${receipt.candidateSha}`,
    );
  const declared = new Set(receipt.namedTests);
  const reported = result.outcomes.map((outcome) => outcome.name);
  if (new Set(reported).size !== declared.size || reported.some((name) => !declared.has(name)))
    return stop(
      'PROOF_NAMES_MISMATCH',
      `named outcomes do not match the receipt: reported ${reported.join(', ') || 'none'}`,
    );
  // WHY the owner validates the shape: NaN, -1, a fraction or a duplicate name pass a hand-written compare.
  const shape = parseReceipt({ ...receipt, outcomes: result.outcomes });
  if (typeof shape === 'string')
    return stop(shape, `the proof outcomes are not valid evidence: ${shape}`);
  const bad = result.outcomes.filter((outcome) => outcome.failed > 0 || outcome.passed === 0);
  if (bad.length > 0)
    return stop(
      'PROOF_FAILED',
      `named proofs did not all pass on the candidate: ${bad
        .map((outcome) => `${outcome.name} ${outcome.passed} passed ${outcome.failed} failed`)
        .join(', ')}`,
    );
  return null;
}

type Preflight =
  | { ok: true; receipt: LandingReceipt; git: GitDecision; evidence: LandingDecision }
  | { ok: false; refusal: PublishResult };
/** Everything that must hold before a ref is touched; WHY twice: the in-slot call re-proves the state. */
function preflight(input: PublishInput, runner: GitRunner): Preflight {
  const attribution = attributeReceipt(input.receipts);
  if ('refusal' in attribution)
    return { ok: false, refusal: stop('RECEIPT_UNATTRIBUTED', attribution.refusal) };
  const { receipt } = attribution;
  const targetRef = input.publication.policy.targetRef;
  const git = evaluateGitEligibility(
    input.publication.policy,
    {
      candidateSha: receipt.candidateSha,
      baseSha: receipt.baseSha,
      itemKey: receipt.itemKey,
      allowedPaths: receipt.allowedPaths,
    },
    runner,
  );
  const base = { candidateSha: receipt.candidateSha, targetRef };
  if (!git.eligible || !git.facts)
    return { ok: false, refusal: stop(git.code ?? 'GIT_FAILED', git.reason, { ...base, git }) };
  // WHY the subject comes from Git: a caller-supplied one could be described two ways.
  const evidence = evaluateBundle(input.item, git.facts.subject, input.receipts, input.verdicts);
  if (!evidence.eligible)
    return {
      ok: false,
      refusal: stop(evidence.code ?? 'RECEIPT_INVALID', evidence.reason, {
        ...base,
        git,
        evidence,
        partial: evidence.partial,
      }),
    };
  const urls = pushURLs(runner, input.publication.remote);
  if ('refusal' in urls) return { ok: false, refusal: urls.refusal };
  const urlRefusal = checkPushURLs(input.publication, urls.urls);
  if (urlRefusal) return { ok: false, refusal: urlRefusal };
  return { ok: true, receipt, git, evidence };
}
/** What the proofs were run against. WHY one string: comparing fields one by one is how one gets forgotten. */
const flightOf = (receipt: LandingReceipt, p: PublicationConfig): string =>
  JSON.stringify([
    receipt.candidateSha,
    receipt.baseSha,
    receipt.itemKey,
    receipt.author,
    [...receipt.allowedPaths].sort(),
    [...receipt.namedTests].sort(),
    p.policy?.targetRef,
    p.remote,
    p.expectedPushURL,
    p.repoIdentity,
    [...(p.policy?.excludedPathPatterns ?? [])].sort(),
  ]);

function targetNow(runner: GitRunner, targetRef: string): string | null {
  const out = runner.run(['rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`]);
  const sha = out.stdout.trim();
  return out.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function publishLanding(
  input: PublishInput,
  runner?: GitRunner,
): Promise<PublishResult> {
  const invalid = validatePublication(input.publication);
  if (invalid) return invalid;
  // WHY built after validation: a default parameter runs before the body and would crash instead of refuse.
  const git = runner ?? execRunner(input.publication.policy.repo);
  const outside = preflight(input, git);
  if (!outside.ok) return outside.refusal;
  const { receipt, evidence } = outside;
  const { candidateSha, baseSha } = receipt;
  const targetRef = input.publication.policy.targetRef;
  const remote = input.publication.remote;
  const provedFlight = flightOf(receipt, input.publication);
  const carry = (result: PublishResult): PublishResult => ({
    ...result,
    partial: result.partial || evidence.partial,
    candidateSha: result.candidateSha ?? candidateSha,
    targetRef: result.targetRef ?? targetRef,
  });
  if (input.proofRunner === undefined || typeof input.proofRunner.run !== 'function')
    return carry(stop('PUBLICATION_INVALID', 'no named proof runner was configured'));
  // WHY proofs run outside the slot: a suite takes minutes, and no ref can move while it runs.
  let proofResult: ProofRunResult;
  try {
    // WHY a copy: the runner is caller code, and an array passed by reference can be spliced inside the await.
    proofResult = await input.proofRunner.run({
      candidateSha,
      namedTests: [...receipt.namedTests],
    });
  } catch (error) {
    return carry(stop('PROOF_FAILED', `the named proof runner threw: ${brief(String(error))}`));
  }
  const proofRefusal = checkProofs(receipt, proofResult);
  if (proofRefusal) return carry(proofRefusal);
  const inner = async (): Promise<PublishResult> => {
    const inside = preflight(input, git);
    if (!inside.ok) return inside.refusal;
    // WHY the flight is compared again: the await is a window, and a receipt or publication swapped inside it
    // would let this recheck approve a different flight than the one proved. A newer verdict still wins through
    // preflight; a different candidate, path list, test list or target refuses with nothing written.
    if (flightOf(inside.receipt, input.publication) !== provedFlight)
      return stop(
        'EVIDENCE_CHANGED_AFTER_PROOF',
        'the receipt or the publication config changed while the proofs ran, so nothing is moved',
      );
    const moved = (code: PublishCode, reason: string, extra: Partial<PublishResult> = {}) =>
      stop(code, reason, {
        candidateSha,
        targetRef,
        evidence,
        git: inside.git,
        partial: evidence.partial,
        ...extra,
      });
    const before = targetNow(git, targetRef);
    // WHY the base SHA is the old value: it is the CAS precondition; without it a race would be overwritten.
    const cas = git.run(['update-ref', targetRef, candidateSha, baseSha]);
    if (cas.status !== 0)
      return moved(
        'REF_CHANGED_AT_CAS',
        `the target moved between the recheck and the move (was ${before ?? 'absent'}): ${brief(cas.stderr)}`,
      );
    if (targetNow(git, targetRef) !== candidateSha)
      return moved('REF_NOT_MOVED', `after the move ${targetRef} does not carry ${candidateSha}`);
    // WHY the SHA on the left: it publishes the reviewed object itself. One remote, one ref, no force.
    const push = git.run(['push', '--porcelain', remote, `${candidateSha}:${targetRef}`]);
    if (push.status !== 0)
      return moved(
        'PUSH_FAILED',
        `landed locally as ${candidateSha}, but the push to ${remote} failed: ${brief(push.stderr || push.stdout)}`,
        { landed: true },
      );
    const listed = git.run(['ls-remote', remote, targetRef]);
    if (listed.status !== 0)
      return moved(
        'REMOTE_READBACK_MISMATCH',
        `the push reported success, but ${remote} could not be read back: ${brief(listed.stderr)}`,
        { landed: true },
      );
    const readback =
      listed.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((fields) => fields[1] === targetRef)?.[0] ?? null;
    // WHY the exact SHA and not the exit code: only the readback says what the remote holds.
    if (readback !== candidateSha)
      return moved(
        'REMOTE_READBACK_MISMATCH',
        `${remote} reports ${readback ?? 'no ref'} at ${targetRef}, not ${candidateSha}`,
        { landed: true, remoteSha: readback ?? undefined },
      );
    return {
      published: true,
      landed: true,
      partial: evidence.partial,
      reason: evidence.partial
        ? `published ${candidateSha} to ${remote} ${targetRef}; the (partial) marker stands, so the item is not complete`
        : `published ${candidateSha} to ${remote} ${targetRef}`,
      candidateSha,
      targetRef,
      remoteSha: readback,
      evidence,
      git: inside.git,
    };
  };
  const slot = await withLandingSlot(input.slotDriver, input.publication.repoIdentity, inner);
  if (!slot.acquired)
    return carry(
      stop(
        slotCode(slot.code),
        `the landing slot was not held, so nothing was moved: ${brief(String(slot.error ?? slot.code))}`,
        { slot: slot as SlotOutcome<unknown> },
      ),
    );
  const produced =
    slot.value !== undefined
      ? (slot.value as PublishResult)
      : carry(
          stop('SLOT_CALLBACK_FAILED', `the slot callback failed: ${brief(String(slot.error))}`),
        );
  const result: PublishResult = { ...produced, slot: slot as SlotOutcome<unknown> };
  if (!slot.cleanup) return result;
  // WHY both facts survive: the landing may be published and the stuck slot is still a failure.
  return {
    ...result,
    code: 'CLEANUP_FAILED',
    cleanup: slot.cleanup,
    reason: `${result.reason}; the landing slot did not clean up: ${slot.cleanup}`,
  };
}
