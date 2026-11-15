// Anchor-map stamp (sentinel-prod-8428): an issue whose body names code anchors
// (path:line-range or path::Symbol@hash12) gets its symbol + line-anchor map
// stamped onto its feed as a system-actor activity entry. The shared
// sentinel-prod tool (tools/anchor_map.py, one implementation — no second copy)
// computes the map against the ItsPlan checkout; this module only extracts the
// anchors, runs the tool, writes the map file, and records the receipt.
//
// Gates (8364 tracker rules): the stamp runs OFF the write path, after the
// issue has committed — a stamp failure never blocks, rolls back or even
// delays the issue. A system-actor activity entry (kind 'activity', no user)
// never reaches an agent by mention and never edits the issue body.
//
// Shared-tool contract (sentinel-prod-8427, the prerequisite): the tool is
// invoked as `<python> -B <tool> --repo <mapRepo> [--anchor <ref>]...` and
// prints one JSON document: files[] = {path, blob_sha, lines, symbols[],
// drift[] = {anchor, symbol, status, new}}, virtual_targets[] = {target,
// anchored_files[]}. The config below names WHICH checkout, interpreter and
// tool file are used; each is read at call time, and an environment override
// is configuration for the operator (a lane pointing the stamp at another
// checkout), not an approval gate — there is no validation ceremony.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { recordActivity } from './activity';

// Same anchor grammar the shared tool matches: a repo path with a code
// extension, optionally a :line or :line-range, plus path::Symbol@hash12 refs.
const LINE_ANCHOR =
  /(?:[A-Za-z0-9_.~/-]*[A-Za-z0-9_-])\.(?:py|js|ts|tsx|jsx)(?![A-Za-z0-9])(?::\d+(?:-\d+)?)/g;
const SYMBOL_ANCHOR =
  /(?:[A-Za-z0-9_.~/-]*[A-Za-z0-9_-])\.[A-Za-z0-9_]*::([A-Za-z_][A-Za-z0-9_.]*)(?:@([0-9a-f]{12}))?/g;

// Config (A4 item 5): the sanctioned shared-tool interpreter, not a bare
// `python3`. Override with ITSAPLAN_ANCHOR_MAP_PYTHON.
export const SANCTIONED_PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';
// The canonical shared tool on the sentinel-prod master checkout; override
// with ITSAPLAN_ANCHOR_MAP_TOOL for a proof run.
export const CANONICAL_ANCHOR_TOOL = '/Users/misty/sentinel/sentinel-prod/tools/anchor_map.py';

export function extractAnchorRefs(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINE_ANCHOR)) out.add(m[0]);
  for (const m of body.matchAll(SYMBOL_ANCHOR)) out.add(m[0]);
  return [...out].sort();
}

export interface AnchorMapFile {
  path: string;
  blob_sha: string;
  lines: number;
  symbols: { qualname: string; start: number; end: number; body_hash: string }[];
  drift: { anchor: string; symbol: string | null; status: string; old?: string; new?: string }[];
}

export interface AnchorMapDoc {
  files: AnchorMapFile[];
  virtual_targets: { target: string; anchored_files: string[] }[];
}

// The checkout the map is computed against (and where map files are stored).
// Default is THIS checkout's root, resolved from this module's own location by
// walking up to the directory that holds both apps/api and packages/db (a git
// worktree has .git as a file, so the layout, not .git, is the marker). With no
// override this is the repository root, so git paths, the map store under
// Output/anchor_maps and scripts/anchor_map_restamp.ts all resolve inside the
// same tree. ITSAPLAN_ANCHOR_MAP_REPO overrides it as configuration.
export function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'apps', 'api')) && existsSync(path.join(dir, 'packages', 'db')))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not a recognizable checkout layout: fall back to this module's own up-four
  // (apps/api/src/<module>/file -> repository root) rather than a wrong 'src'.
  return path.resolve(import.meta.dir, '../../../..');
}

export function mapRepo(): string {
  return process.env.ITSAPLAN_ANCHOR_MAP_REPO ?? repoRoot();
}

export function anchorMapTool(): string {
  return process.env.ITSAPLAN_ANCHOR_MAP_TOOL ?? CANONICAL_ANCHOR_TOOL;
}

export function anchorMapPython(): string {
  return process.env.ITSAPLAN_ANCHOR_MAP_PYTHON ?? SANCTIONED_PYTHON;
}

export function mapStoreDir(issueId: number): string {
  return path.join(mapRepo(), 'Output', 'anchor_maps', `issue-${issueId}`);
}

// The receipt text the feed shows: map path, sha256, per-file blob shas, DRIFT
// lines and the migration virtual target.
export function stampText(doc: AnchorMapDoc, mapPath: string, mapSha: string): string {
  const lines: string[] = [`anchor map ${mapPath} sha256=${mapSha}`];
  for (const f of doc.files) {
    lines.push(
      `  ${f.path} blob ${f.blob_sha.slice(0, 12)} ${f.lines} lines ${f.symbols.length} symbols`,
    );
    for (const d of f.drift) {
      lines.push(
        `  DRIFT ${f.path}: ${d.anchor} -> ${d.symbol ?? 'no-symbol'} ${d.status} now ${d.new ?? '-'}`,
      );
    }
  }
  for (const v of doc.virtual_targets) {
    lines.push(
      `  VIRTUAL-TARGET ${v.target} (shared chain key for: ${v.anchored_files.join(', ')})`,
    );
  }
  return lines.join('\n');
}

function runTool(anchors: string[], timeoutMs: number): Promise<AnchorMapDoc> {
  const args = [
    '-B',
    anchorMapTool(),
    '--repo',
    mapRepo(),
    ...anchors.flatMap((a) => ['--anchor', a]),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      anchorMapPython(),
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout) as AnchorMapDoc);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

// Exact normalized file references named in a body: full repo-relative paths,
// one per match, './' stripped. Used by the landing restamp to compare against
// `git diff --name-only` output EXACTLY (A4 item 3): a changed tools/a.py must
// not hit a body naming tools/a.py.bak or tests/tools/a.py, and a body naming
// 'mod_a.pyx' must not hit the changed 'mod_a.py'.
export function fileRefs(body: string): string[] {
  const re = /(?<![\w./~-])([A-Za-z0-9_][A-Za-z0-9_.~/-]*\.(?:py|tsx?|jsx?))(?![\w.])/g;
  const out = new Set<string>();
  for (const m of body.matchAll(re)) out.add(m[1].replace(/^(\.\/)+/, ''));
  return [...out].sort();
}

// Outcome of one stamp attempt, told apart by kind so a stamp that could not
// run is never counted as a noop (A4 R2 item 4).
export type StampOutcome =
  | { status: 'stamped'; text: string }
  | { status: 'no_anchors' }
  | { status: 'no_map' }
  | { status: 'failed'; reason: string };

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `shared tool ${path.basename(anchorMapTool())}: ${message.replace(/\n/g, ' ')}`.slice(
    0,
    200,
  );
}

// Stamps the anchor map of one issue body. no_anchors: the body names no path
// anchor. no_map: the shared tool ran and resolved no file. failed: the shared
// tool was missing, exited nonzero, timed out or printed something unparseable,
// with the reason carried. The call itself never throws: a failed stamp cannot
// block or roll back the issue write that used it.
export async function stampIssueAnchors(
  issueId: number,
  body: string,
  options: { timeoutMs?: number } = {},
): Promise<StampOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const anchors = extractAnchorRefs(body);
  if (anchors.length === 0) return { status: 'no_anchors' };
  let doc: AnchorMapDoc;
  try {
    doc = await runTool(anchors, timeoutMs);
  } catch (error) {
    return { status: 'failed', reason: failureReason(error) };
  }
  if (!doc.files.length) return { status: 'no_map' };
  try {
    const mapJson = JSON.stringify(doc, null, 2);
    const sha = createHash('sha256').update(mapJson).digest('hex');
    const dir = mapStoreDir(issueId);
    mkdirSync(dir, { recursive: true });
    const mapPath = path.join(dir, `${sha.slice(0, 16)}.json`);
    writeFileSync(mapPath, mapJson);
    const text = stampText(doc, mapPath, sha);
    await recordActivity(issueId, [{ action: 'anchor_map_stamped', subject: { value: text } }], {
      system: 'AnchorMap',
    });
    return { status: 'stamped', text };
  } catch (error) {
    // The map itself could not be stored or recorded: a failure, not a noop.
    return { status: 'failed', reason: failureReason(error) };
  }
}
