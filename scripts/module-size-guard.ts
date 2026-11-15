// scripts/module-size-guard.ts — sentinel-prod-8429 inventory row 2: the 400-line module rule at pre-commit, carried
// from sentinel-prod/tools/pylint_module_size_gate.py (LIMIT = 400, and its sentinel-prod-1534 ratchet).
//
// WHAT it judges: the STAGED blob of every staged source file, never the working copy, because the staged blob is
// what the commit records. A file may be 399 lines on disk and 401 in the index, and the commit gets the 401.
//
// The rule, per file:
//   - new file, or a file at most 400 lines at HEAD: the staged blob must be at most 400 lines.
//   - file already over 400 lines at HEAD: it may stay the same or shrink. Growth is refused. WHY: an old long
//     module must be split by extraction, and refusing every edit to it would block the fixes that shrink it.
//     HEAD is the baseline, so there is no baseline file to keep and no census to run.
//   - a deleted file is not judged. A renamed file is compared with its old path at HEAD.
//
// SCOPE DIFFERENCE FROM SENTINEL, intended: Sentinel exempted tests. Here tests are judged too, because the
// migration rule (Root, 2026-11-15) holds new test leaves to 400 lines as well.
//
// It fails closed: if git cannot list the staged files or cannot print a blob, the commit is refused with a named
// code. It reads no environment value and has no bypass of its own.

import { spawnSync } from 'node:child_process';

export const LIMIT = 400;
export const MODULE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'] as const;
const RULE = 'module-size-400';

export type SizeCode =
  | 'MODULE_TOO_LONG'
  | 'MODULE_GREW'
  | 'STAGED_LIST_UNKNOWN'
  | 'STAGED_BLOB_UNREADABLE'
  | 'BASE_BLOB_UNREADABLE';

export interface SizeRefusal {
  rule: string;
  code: SizeCode;
  message: string;
  /** The compliant form the writer can act on. */
  safe_form: string;
}

export interface StagedPath {
  path: string;
  /** The path this file has at HEAD, or null for a file HEAD does not hold. */
  basePath: string | null;
}

function refuse(code: SizeCode, message: string, safe_form: string): SizeRefusal {
  return { rule: RULE, code, message, safe_form };
}

export function inScope(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || path.lastIndexOf('/') > dot) return false;
  return (MODULE_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1));
}

/** Lines as an editor numbers them: a final line with no newline still counts. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return text.endsWith('\n') ? lines : lines + 1;
}

/**
 * Parses `git diff --cached --name-status -z -M --diff-filter=ACMRT`. A rename or copy record carries two paths.
 * A type change (T) is judged like a modification, so a symlink turned into a regular file is not skipped.
 * null means the output is not in that form, and the caller refuses.
 */
export function parseStaged(raw: string): StagedPath[] | null {
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const staged: StagedPath[] = [];
  for (let at = 0; at < fields.length;) {
    const status = fields[at] ?? '';
    const kind = status[0];
    if (kind === 'A' || kind === 'M' || kind === 'T') {
      const path = fields[at + 1];
      if (path === undefined || path === '') return null;
      staged.push({ path, basePath: kind === 'A' ? null : path });
      at += 2;
    } else if (kind === 'R' || kind === 'C') {
      const from = fields[at + 1];
      const path = fields[at + 2];
      if (from === undefined || from === '' || path === undefined || path === '') return null;
      // A copy leaves its source in place, so the copy is a new file. A rename keeps the old file's baseline.
      staged.push({ path, basePath: kind === 'R' ? from : null });
      at += 3;
    } else return null;
  }
  return staged;
}

/** One file, one answer. `baseLines` null means HEAD does not hold the file. */
export function sizeDecision(file: {
  path: string;
  stagedLines: number;
  baseLines: number | null;
}): SizeRefusal | null {
  const { path, stagedLines, baseLines } = file;
  if (stagedLines <= LIMIT) return null;
  if (baseLines !== null && baseLines > LIMIT) {
    if (stagedLines <= baseLines) return null;
    return refuse(
      'MODULE_GREW',
      `${path} is already over ${LIMIT} lines at HEAD (${baseLines}) and the staged version grows it to ${stagedLines}`,
      `move code out into a sibling file of at most ${LIMIT} lines, so ${path} stays at ${baseLines} lines or fewer`,
    );
  }
  return refuse(
    'MODULE_TOO_LONG',
    `${path} is ${stagedLines} lines in the staged version; the limit is ${LIMIT}` +
      (baseLines === null ? '' : ` (it is ${baseLines} at HEAD)`),
    `split it into sibling files of at most ${LIMIT} lines each, then stage and commit again`,
  );
}

export interface SizeGuardDeps {
  /** `out` is git's stdout byte for byte, because the line count depends on the final newline. */
  runGit: (args: readonly string[]) => { ok: boolean; out: string };
  writeErr: (text: string) => void;
}

export function refusalText(refusal: SizeRefusal): string {
  return [
    `BLOCKED (${refusal.rule}): ${refusal.message}`,
    '',
    `  Code: ${refusal.code}`,
    `  Compliant form: ${refusal.safe_form}`,
    '',
  ].join('\n');
}

/** Every staged source file is judged, so one commit reports all its refusals at once. */
export function stagedRefusals(deps: SizeGuardDeps): SizeRefusal[] {
  const listed = deps.runGit([
    'diff',
    '--cached',
    '--name-status',
    '-z',
    '-M',
    '--diff-filter=ACMRT',
  ]);
  const staged = listed.ok ? parseStaged(listed.out) : null;
  if (staged === null) {
    return [
      refuse(
        'STAGED_LIST_UNKNOWN',
        'git did not list the staged files, so the guard cannot tell what this commit records',
        're-run inside the repository (git diff --cached --name-status must answer)',
      ),
    ];
  }
  const refusals: SizeRefusal[] = [];
  for (const { path, basePath } of staged) {
    if (!inScope(path)) continue;
    const blob = deps.runGit(['cat-file', 'blob', `:${path}`]);
    if (!blob.ok) {
      refusals.push(
        refuse(
          'STAGED_BLOB_UNREADABLE',
          `git could not print the staged version of ${path}, so its length is unknown`,
          `make the staged file readable (git cat-file blob ":${path}" must answer), then commit again`,
        ),
      );
      continue;
    }
    const stagedLines = countLines(blob.out);
    // The HEAD version matters only for a file over the limit, so a short file costs one git call.
    if (stagedLines <= LIMIT) continue;
    let baseLines: number | null = null;
    if (basePath !== null) {
      const base = deps.runGit(['cat-file', 'blob', `HEAD:${basePath}`]);
      if (!base.ok) {
        refusals.push(
          refuse(
            'BASE_BLOB_UNREADABLE',
            `${path} is ${stagedLines} lines staged, and git could not print ${basePath} at HEAD, so the guard ` +
              'cannot tell an old long file from a new one',
            `make the HEAD version readable (git cat-file blob "HEAD:${basePath}" must answer), then commit again`,
          ),
        );
        continue;
      }
      baseLines = countLines(base.out);
    }
    const refusal = sizeDecision({ path, stagedLines, baseLines });
    if (refusal !== null) refusals.push(refusal);
  }
  return refusals;
}

/** 0 allow, 1 refusal. Lefthook treats any non-zero exit as a failed hook, which stops the commit. */
export function runSizeGuard(deps: SizeGuardDeps): number {
  const refusals = stagedRefusals(deps);
  for (const refusal of refusals) deps.writeErr(`${refusalText(refusal)}\n`);
  return refusals.length === 0 ? 0 : 1;
}

// Only the shipped CLI runs real git; the rule above is reachable as pure imports.
if (import.meta.main) {
  process.exit(
    runSizeGuard({
      // The environment is passed through unchanged: during a commit git names the index being committed there.
      runGit: (args) => {
        const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: Infinity });
        return { ok: result.status === 0, out: result.stdout ?? '' };
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    }),
  );
}
