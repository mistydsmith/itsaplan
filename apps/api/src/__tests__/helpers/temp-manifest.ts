import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A rule manifest a test owns: one CONFIG.json in its own fresh directory under the OS temp
// directory. remove() deletes that directory and nothing else. It never touches the shared CONFIG
// a test copied its pins from.
export interface TempManifest {
  path: string;
  remove: () => void;
}

const live = new Set<string>();
let exitHooked = false;

// A manifest that lasts for the whole test file. It is removed when the process exits, which is
// after the last case that reads it, whether the cases passed or not.
export function tempManifest(prefix: string, content: unknown): TempManifest {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'CONFIG.json');
  writeFileSync(path, JSON.stringify(content));
  live.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const left of live) rmSync(left, { recursive: true, force: true });
    });
  }
  return {
    path,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
      live.delete(dir);
    },
  };
}

// A manifest that lasts for one call. It is removed when run settles, including when run throws.
export async function withTempManifest<T>(
  prefix: string,
  content: unknown,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const manifest = tempManifest(prefix, content);
  try {
    return await run(manifest.path);
  } finally {
    manifest.remove();
  }
}
