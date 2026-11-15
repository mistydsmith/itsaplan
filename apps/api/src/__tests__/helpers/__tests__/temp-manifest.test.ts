// The temp manifest helper removes what it made: after a call that throws, after remove(), and at
// process exit for a file-lifetime manifest. No database.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { tempManifest, withTempManifest } from '../temp-manifest';

describe('temp manifest cleanup', () => {
  it('removes the per-call manifest when the callback throws', async () => {
    let seen = '';
    const failed = withTempManifest('temp-manifest-test-', { a: 1 }, async (path) => {
      seen = path;
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
      throw new Error('the case failed');
    });
    await expect(failed).rejects.toThrow('the case failed');
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('removes the per-call manifest when the callback returns', async () => {
    const path = await withTempManifest('temp-manifest-test-', {}, async (given) => given);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('removes only its own directory, and a second remove is harmless', () => {
    const first = tempManifest('temp-manifest-test-', {});
    const second = tempManifest('temp-manifest-test-', {});
    first.remove();
    first.remove();
    expect(existsSync(dirname(first.path))).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    second.remove();
  });

  it('removes a file-lifetime manifest when the process exits after a failure', () => {
    const helper = join(import.meta.dir, '..', 'temp-manifest.ts');
    const script = `const { tempManifest } = await import(${JSON.stringify(helper)});
      console.log(tempManifest('temp-manifest-test-', {}).path);
      throw new Error('the file failed');`;
    const child = Bun.spawnSync([process.execPath, '-e', script]);
    const path = child.stdout.toString().trim();
    expect(child.exitCode).not.toBe(0);
    expect(path).toEndWith('CONFIG.json');
    expect(existsSync(dirname(path))).toBe(false);
  });
});
