// scripts/git-guard-rules.ts — sentinel-prod-8429 inventory rows 1 and 7, carried over from Sentinel's bead hooks.
//
// Row 1 is sentinel-prod/.beads/hooks/commit-msg (bead sentinel-prod-ky5e): every commit subject must name the
// bead, because isolation says WHERE code landed and the bead ID says WHY it exists. Row 7 is
// sentinel-prod/.beads/hooks/pre-rebase (2026-08-06 incident): the shared checkout commits forward only, so a
// rebase there rewrites history other lanes already built on.
//
// WHY pure: the rules decide from arguments only, so they are provable with no database, no network and no
// installed hook. Only the thin adapter at the bottom reads a file or asks git for a fact, and it hands the
// rules that fact as an explicit argument. Validating a supplied fact is not authenticating it, and a missing
// fact is a refusal, never an allow.
//
// WHY parity instead of a stricter rule: Sentinel accepted a subject by one regex, and ItsPlan lanes whose
// commits were legal yesterday must not be refused by the port. The accepted shape is kept character for
// character where the meaning matters, and every difference is named in a comment.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type GuardCode =
  | 'SUBJECT_MISSING'
  | 'BEAD_ID_MISSING'
  | 'CHECKOUT_FACT_MISSING'
  | 'SHARED_CHECKOUT_REBASE'
  | 'STAGE_UNKNOWN'
  | 'COMMIT_MSG_FILE_UNREADABLE';

export interface GuardRefusal {
  rule: string;
  code: GuardCode;
  /** Names what was refused, so the writer fixes the commit rather than guessing which hook fired. */
  message: string;
  /** The compliant form the writer can paste, never a lecture. */
  safe_form: string;
}

/** null means allowed. A refusal is never returned together with an allow. */
export type GuardDecision = GuardRefusal | null;

export interface CommitMsgInput {
  /** The first line of the commit message file, exactly what git hands the hook. */
  subject: string;
  /**
   * Misty's NO-JAM law from the Sentinel hook: this rule may never permanently block her, so the bypass
   * environment value is honoured. It arrives as an argument, never read from the environment here, so the
   * pure decision cannot be influenced by whatever the test runner happens to have exported.
   */
  beadIdBypass?: string | undefined;
}

export interface RebaseInput {
  /**
   * True when this checkout is a linked worktree of the shared repository, which is where a lane may rebase.
   * False is the shared checkout itself. undefined means the adapter could not prove which one it is.
   */
  linkedWorktree: boolean | undefined;
  /** Where the rebase would move the branch to, kept for the refusal text only. */
  onto?: string | null;
  /** The branch being rebased, kept for the refusal text only. */
  branch?: string | null;
}

/**
 * The bead ID shape the Sentinel hook accepted, copied exactly: a letter-led token with a dash and an
 * identifier, with an optional dotted child number, e.g. sentinel-prod-8429, sentinel-prod-8427.1, BD-4nm.
 * It is deliberately loose, and it is honest about being loose: "fix-1" would satisfy it, exactly as it
 * satisfied the Sentinel hook. Tightening it here would refuse commits the port is meant to accept.
 */
const BEAD_ID = /\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+(\.[0-9]+)?\b/;

function refuse(rule: string, code: GuardCode, message: string, safe_form: string): GuardRefusal {
  return { rule, code, message, safe_form };
}

/** Row 1: the bead-id commit-msg rule. */
export function beadIdDecision(input: CommitMsgInput): GuardDecision {
  if (input.beadIdBypass !== undefined && input.beadIdBypass !== '') return null;

  const subject = input.subject;
  if (subject.trim() === '') {
    return refuse(
      'commit-msg-bead-id',
      'SUBJECT_MISSING',
      'the commit message file carries no subject line to check',
      'write a subject that names the bead, e.g. "sentinel-prod-8429 (partial): add the guard rule"',
    );
  }

  // Machine-generated merge subjects are exempt, as they were in the Sentinel hook. The 2026-08-04 note in
  // that hook removed every other exemption because an autosave watcher abused them to fossilise other
  // agents' uncommitted work, so no other subject class is exempted here either.
  if (subject.startsWith('Merge ')) return null;

  if (BEAD_ID.test(subject)) return null;

  return refuse(
    'commit-msg-bead-id',
    'BEAD_ID_MISSING',
    `no bead ID found in the commit subject: ${subject}`,
    'put the bead ID first in the subject, e.g. "sentinel-prod-8429: add the guard rule". ' +
      'Not tied to a bead? Set BD_SKIP_BEAD_ID_CHECK=1 for this one commit.',
  );
}

/**
 * Row 7: the shared-checkout rebase refusal.
 *
 * The Sentinel hook sat in the shared tree and so refused unconditionally. Here the same lefthook file is
 * installed in lane worktrees too, so the rule has to say which checkout it is in, and the only fact that
 * says it is git's own answer about the directory layout. An unprovable fact refuses: a guard that allows on
 * an unknown is not a guard.
 */
export function rebaseDecision(input: RebaseInput): GuardDecision {
  if (input.linkedWorktree === undefined) {
    return refuse(
      'shared-checkout-rebase',
      'CHECKOUT_FACT_MISSING',
      'git did not answer which checkout this is, so the rebase guard cannot tell shared from lane worktree',
      'run the rebase inside your own worktree: git worktree add ../<your-name> HEAD && git -C ../<your-name> rebase ...',
    );
  }

  if (input.linkedWorktree === true) return null;

  const onto = input.onto ?? 'the named upstream';
  const branch = input.branch ?? 'the checked-out branch';
  return refuse(
    'shared-checkout-rebase',
    'SHARED_CHECKOUT_REBASE',
    `rebase refused in the shared checkout: ${branch} would be rewritten onto ${onto} where other lanes are already building`,
    'commit forward here, or rebase in your own worktree: ' +
      'git worktree add ../<your-name> HEAD && git -C ../<your-name> rebase <upstream>',
  );
}

// ---------------------------------------------------------------------------------------------
// Adapter only: everything below is the hook's hands, not the rule. Kept out of the exported rules so a test
// can prove the rules without a repository, and prove the adapter's exit codes in a scratch repository.
// ---------------------------------------------------------------------------------------------

export const GUARD_STAGES = ['commit-msg', 'pre-rebase'] as const;
export type GuardStage = (typeof GUARD_STAGES)[number];

export function parseStage(argv: readonly string[]): GuardStage | null {
  return (GUARD_STAGES as readonly string[]).includes(argv[0] ?? '')
    ? (argv[0] as GuardStage)
    : null;
}

/** The refusal text a git hook must print on stderr, one block, with the code and the compliant form. */
export function refusalText(refusal: GuardRefusal): string {
  return [
    `${refusal.rule}: ${refusal.message}`,
    '',
    `  Code: ${refusal.code}`,
    `  Compliant form: ${refusal.safe_form}`,
    '',
  ].join('\n');
}

export interface AdapterDeps {
  readFile: (path: string) => string;
  /** git's own answers, injected so the adapter is testable without a repository. */
  runGit: (args: readonly string[]) => { ok: boolean; out: string };
  env: Record<string, string | undefined>;
  writeErr: (text: string) => void;
  /** Which checkout this is, by git's own directory layout. */
  detectLinkedWorktree: () => boolean | undefined;
}

export function runStage(stage: GuardStage, argv: readonly string[], deps: AdapterDeps): number {
  if (stage === 'commit-msg') {
    const messageFile = argv[1];
    if (!messageFile) {
      deps.writeErr(
        refusalText(
          refuse(
            'commit-msg-bead-id',
            'COMMIT_MSG_FILE_UNREADABLE',
            'the hook was called with no commit message file to read',
            'call it the way the hook does: bun run scripts/git-guard-rules.ts commit-msg "{0}"',
          ),
        ),
      );
      return 1;
    }
    let text: string;
    try {
      text = deps.readFile(messageFile);
    } catch {
      deps.writeErr(
        refusalText(
          refuse(
            'commit-msg-bead-id',
            'COMMIT_MSG_FILE_UNREADABLE',
            `the commit message file could not be read: ${messageFile}`,
            're-run the commit; if the editor left no message file, write the subject on the command line',
          ),
        ),
      );
      return 1;
    }
    const refusal = beadIdDecision({
      subject: text.split('\n')[0] ?? '',
      beadIdBypass: deps.env.BD_SKIP_BEAD_ID_CHECK,
    });
    if (refusal === null) return 0;
    deps.writeErr(refusalText(refusal));
    return 1;
  }

  const refusal = rebaseDecision({
    linkedWorktree: deps.detectLinkedWorktree(),
    onto: argv[1] ?? null,
    branch: gitBranch(deps),
  });
  if (refusal === null) return 0;
  deps.writeErr(refusalText(refusal));
  return 1;
}

function gitBranch(deps: AdapterDeps): string | null {
  const branch = deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch.ok && branch.out !== '' ? branch.out : null;
}

/** Shared checkout has its own .git directory; a linked worktree points at the common one. */
export function linkedWorktreeFromGit(runGit: AdapterDeps['runGit']): boolean | undefined {
  const gitDir = runGit(['rev-parse', '--git-dir']);
  const commonDir = runGit(['rev-parse', '--git-common-dir']);
  if (!gitDir.ok || !commonDir.ok) return undefined;
  if (gitDir.out === '' || commonDir.out === '') return undefined;
  return gitDir.out !== commonDir.out;
}

/** 0 allow, 1 refusal, 2 the hook was called wrong. Lefthook treats any non-zero exit as a failed hook. */
export function main(argv: readonly string[], deps: AdapterDeps): number {
  const stage = parseStage(argv);
  if (stage === null) {
    deps.writeErr(`usage: bun run scripts/git-guard-rules.ts <${GUARD_STAGES.join('|')}> [args]\n`);
    return 2;
  }
  return runStage(stage, argv, deps);
}

// Only the shipped CLI wires the real filesystem and git; the rules above stay reachable as pure imports.
if (import.meta.main) {
  const spawnGit = (args: readonly string[]): { ok: boolean; out: string } => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
  };
  process.exit(
    main(process.argv.slice(2), {
      readFile: (path) => readFileSync(path, 'utf8'),
      runGit: spawnGit,
      env: process.env,
      writeErr: (text) => {
        process.stderr.write(text);
      },
      detectLinkedWorktree: () => linkedWorktreeFromGit(spawnGit),
    }),
  );
}
