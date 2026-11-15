// pause-cancel-redaction.test.ts — the F1 pause/cancel redaction proof,
// parent side (Root msg_ff6952f9de7e, 2026-11-15).
//
// WHY this file exists separately from the proof: bun's mock.module rewrites
// the import graph process-globally and mock.restore() does not undo the
// rewrite, so the five handler-level cases (which must install @repo/db /
// @repo/auth / service / access / projects stubs before the real route table
// loads) live in pause-cancel-redaction.proof.ts. That file is NOT collected
// by bun test's *.test.ts glob; this file is the only unit-set member that
// touches it, and it runs it as a CHILD `bun test` process. The parent/full
// test process therefore never installs the stubs - structurally, and
// provably: the post-test sentinel below proves this process still holds the
// REAL modules after the child run, with no database required.
//
// The child proves the behavior (all five cases, unchanged) and the
// zero-connection evidence (exactly one memoized noteSeen write per distinct
// user, every other client operation fail-closed). This process proves the
// isolation: the real @repo/db client builds a query object (the stub throws
// on select()), and the real service and auth exports are intact.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

// Set before the @repo/db import below (the module validates them on load);
// never overwrites a real environment.
process.env.DATABASE_URL ??= 'postgres://unit-test:unit-test@127.0.0.1:5433/unit-test';
process.env.APP_URL ??= 'http://127.0.0.1:4000';
process.env.API_URL ??= 'http://127.0.0.1:3000';

function runProofInChildProcess(): Promise<{ code: number | null; stderr: string }> {
  // process.execPath is the bun binary under which this suite runs, so the
  // child uses the same runtime; the cwd derived from import.meta.url is this
  // file's directory so the proof's relative '../../index' import resolves
  // exactly as when bun collected it.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const selected = process.execArgv.find((arg) => arg.startsWith('--tsconfig-override='));
  const flags = selected
    ? [`--tsconfig-override=${resolve(selected.slice('--tsconfig-override='.length))}`]
    : [];

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...flags, '--no-env-file', 'test', './pause-cancel-redaction.proof.ts'],
      { cwd: here, timeout: 120_000, env: process.env },
      (error, _stdout, stderr) => {
        // bun test writes the per-test lines and the "N pass / M fail"
        // summary to stderr; exit code 1 is a test failure, not a spawn
        // failure - report it like a result.
        if (error && typeof error.code === 'number') {
          resolve({ code: error.code, stderr });
        } else if (error) {
          reject(error);
        } else {
          resolve({ code: 0, stderr });
        }
      },
    );
  });
}

describe('F1 pause/cancel redaction proof, isolated in a child test process', () => {
  test('the five handler-level cases pass in a separate process', async () => {
    const { code, stderr } = await runProofInChildProcess();
    expect(stderr).toContain('5 pass');
    expect(stderr).toContain('0 fail');
    expect(code).toBe(0);
  });

  test('post-test sentinel: this process still holds the REAL modules (no stubs installed, no DB)', async () => {
    // Runs after the child in this describe block: if any mock.module had
    // leaked into the parent process, @repo/db would be the fail-closed stub
    // and db.select() would throw 'no-database stub'. The real drizzle
    // client builds a query object with a .from builder - pure SQL
    // construction, no socket, no connection attempt (Root 2026-11-15: a
    // caught error is still a connection attempt, so no query is executed).
    const realDb = await import('@repo/db');
    let query: unknown;
    expect(() => {
      query = realDb.db.select();
    }).not.toThrow();
    expect(typeof (query as { from?: unknown }).from).toBe('function');

    // The real service and auth exports are intact functions (the stubbed
    // variants existed only in the child process's module graph).
    const realService = await import('../../service');
    const realAuth = await import('@repo/auth');
    expect(typeof realService.pauseImportJob).toBe('function');
    expect(typeof realAuth.getSessionFromHeaders).toBe('function');
  });
});
