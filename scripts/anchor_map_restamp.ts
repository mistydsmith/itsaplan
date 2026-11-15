// Anchor-map landing restamp CLI (sentinel-prod-8428). This is the shipped
// hook body: lefthook's post-merge step (lefthook.yml) runs it after a merge
// lands in the checkout — including a merge that carries a drizzle migration.
// The ItsPlan auto lander (sentinel-prod-8429) coordinates on this same entry
// (restampIssuesForRange + commitRestampCheckpoint) instead of duplicating the
// sweep.
//
// Usage (from a checkout):
//   bun run scripts/anchor_map_restamp.ts --post-merge      # as the git hook runs it
//   bun run scripts/anchor_map_restamp.ts [--before <sha>] [--repo <path>]
//     [--boundary <file>] [--max-issues <n>] [--max-seconds <n>]
// Range: --before, else the recorded boundary (Output/anchor_maps/.last_landed)
// to HEAD; --post-merge additionally permits git's own ORIG_HEAD, the pre-merge
// tip git writes before the hook runs, so a checkout that has never stamped yet
// still gets its first real range. Without any truthful source the run reports
// and skips. Exit is always 0 for hook safety; the printed receipt states
// partial/failure/cap truthfully and names the range source and what happened to
// the checkpoint — a stamp that could not run is never counted as a success.

import {
  commitRestampCheckpoint,
  restampIssuesForRange,
  resolveLandedRange,
} from '../apps/api/src/modules/issues/anchor-restamp';

export async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const num = (name: string): number | undefined => {
    const raw = flag(name);
    return raw === null ? undefined : Number(raw);
  };
  const gitRepo = flag('repo') ?? process.cwd();
  const boundary = flag('boundary');
  if (boundary) process.env.ITSAPLAN_ANCHOR_BOUNDARY_FILE = boundary;

  let range;
  try {
    range = resolveLandedRange(
      flag('before'),
      gitRepo,
      argv.includes('--post-merge') ? 'post-merge' : 'none',
    );
  } catch (error) {
    console.log(
      `anchor restamp: SKIP (no readable git HEAD in ${gitRepo}: ${
        error instanceof Error ? error.message : String(error)
      }); nothing stamped`,
    );
    return 0;
  }
  if (!range) {
    console.log(
      'anchor restamp: SKIP (no truthful landed range: no --before, empty boundary file, not a post-merge hook); nothing stamped',
    );
    return 0;
  }
  const receipt = await restampIssuesForRange(range.before, range.after, gitRepo, {
    capIssues: num('max-issues'),
    capSeconds: num('max-seconds'),
  });
  // The checkpoint is awaited, and it only advances on a sweep that ran to
  // completion: a capped or failed sweep keeps the range pending with a cursor.
  const checkpoint = await commitRestampCheckpoint(receipt);
  const status = receipt.capped
    ? `CAPPED (${receipt.cap_reason})`
    : receipt.failed > 0
      ? `PARTIAL (${receipt.failed} failed${receipt.failed_reason ? `: ${receipt.failed_reason}` : ''})`
      : 'OK';
  console.log(
    `anchor restamp ${status}: range ${receipt.before.slice(0, 12)}..${receipt.after.slice(0, 12)} ` +
      `source=${range.source} checkpoint=${checkpoint} changed=${receipt.changed_files} ` +
      `candidates=${receipt.candidates} attempted=${receipt.attempted} stamped=${receipt.stamped} ` +
      `noop=${receipt.noop} failed=${receipt.failed}` +
      (receipt.resumed_after === null ? '' : ` resumed_after=${receipt.resumed_after}`),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
