// apps/api/src/modules/issues/__tests__/unit/landing-proof-runner.test.ts — sentinel-prod-8429 atom E focus.
// WHY injection and not mock.module: process-global mocks would answer in every other suite in the worker. The child process
// and HEAD are parameters here, so nothing leaks and no real process starts.
//
// WHAT IT PROVES: only host-configured argv can run; an unconfigured name throws instead of running something; HEAD must be the
// candidate before and after; and the outcomes are the children's REAL exits, including a signalled child.

import { describe, expect, it } from 'bun:test';

import {
  createLandingProofRunner,
  type ProofSpawn,
  type SpawnResult,
} from '../../landing-proof-runner';

const CANDIDATE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

const ARGV = {
  'unit-a': ['bun', 'test', 'a.test.ts'],
  'unit-b': ['bun', 'test', 'b.test.ts'],
} as const;

/** Records every spawn and answers from a queue of exits. */
function recordingSpawn(exits: Array<Partial<SpawnResult>>): {
  spawn: ProofSpawn;
  calls: Array<{ argv: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  let index = 0;
  return {
    calls,
    spawn: async (argv, cwd) => {
      calls.push({ argv, cwd });
      const next = exits[index] ?? { code: 0 };
      index += 1;
      return { stdout: '', stderr: '', code: 0, signal: null, ...next };
    },
  };
}

const runner = (
  over: Partial<Parameters<typeof createLandingProofRunner>[0]> = {},
  heads: string[] = [CANDIDATE, CANDIDATE],
) => {
  let position = 0;
  const head = () => heads[Math.min(position++, heads.length - 1)] as string;
  return createLandingProofRunner({
    repo: '/tmp/repo',
    argvByTest: ARGV,
    env: {} as NodeJS.ProcessEnv,
    head,
    ...over,
  });
};

describe('only the host can decide what runs', () => {
  it('runs the configured argv verbatim, in the repository, for each named test in order', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0 }, { code: 0 }]);
    const result = await runner({ spawn }).run({
      candidateSha: CANDIDATE,
      namedTests: ['unit-b', 'unit-a'],
    });
    expect(calls.map((call) => call.argv)).toEqual([
      ['bun', 'test', 'b.test.ts'],
      ['bun', 'test', 'a.test.ts'],
    ]);
    expect(calls.every((call) => call.cwd === '/tmp/repo')).toBe(true);
    expect(result.candidateSha).toBe(CANDIDATE);
    expect(result.outcomes).toEqual([
      { name: 'unit-b', passed: 1, failed: 0 },
      { name: 'unit-a', passed: 1, failed: 0 },
    ]);
  });

  it('refuses a name the host did not configure, and runs nothing for it', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0 }]);
    const subject = runner({ spawn });
    await expect(
      subject.run({ candidateSha: CANDIDATE, namedTests: ['unit-a', 'rm -rf /'] }),
    ).rejects.toThrow(/no host-configured command for the named test 'rm -rf \/'/);
    expect(calls).toHaveLength(1);
  });
});

describe('a proof is only about the candidate', () => {
  it('refuses before running anything when HEAD is not the candidate', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0 }]);
    await expect(
      runner({ spawn }, [OTHER, OTHER]).run({ candidateSha: CANDIDATE, namedTests: ['unit-a'] }),
    ).rejects.toThrow(new RegExp(`the checkout is on ${OTHER}`));
    expect(calls).toHaveLength(0);
  });

  it('refuses when the checkout moves during the proofs, even if every child exited zero', async () => {
    const { spawn } = recordingSpawn([{ code: 0 }]);
    await expect(
      runner({ spawn }, [CANDIDATE, OTHER]).run({
        candidateSha: CANDIDATE,
        namedTests: ['unit-a'],
      }),
    ).rejects.toThrow(/the checkout moved during the proofs/);
  });
});

describe('the outcome is the real exit', () => {
  it('records a failing exit as failed, not as a pass', async () => {
    const { spawn } = recordingSpawn([{ code: 2 }]);
    const result = await runner({ spawn }).run({ candidateSha: CANDIDATE, namedTests: ['unit-a'] });
    expect(result.outcomes).toEqual([{ name: 'unit-a', passed: 0, failed: 1 }]);
  });

  it('records a child killed by a signal as failed', async () => {
    const { spawn } = recordingSpawn([{ code: null, signal: 'SIGKILL' }]);
    const result = await runner({ spawn }).run({ candidateSha: CANDIDATE, namedTests: ['unit-a'] });
    expect(result.outcomes).toEqual([{ name: 'unit-a', passed: 0, failed: 1 }]);
  });

  it('writes the child stderr where a failure can be read, and never claims a pass', async () => {
    const lines: string[] = [];
    const { spawn } = recordingSpawn([{ code: 1, stderr: 'boom' }]);
    const result = await runner({ spawn, writeErr: (text) => lines.push(text) }).run({
      candidateSha: CANDIDATE,
      namedTests: ['unit-a'],
    });
    expect(result.outcomes[0]?.failed).toBe(1);
    expect(lines.join('\n')).toContain("'unit-a' failed with exit 1");
    expect(lines.join('\n')).toContain('boom');
  });
});

describe('a misconfigured host fails at construction, not mid-landing', () => {
  it('refuses an empty map, a blank argv and a non-absolute repo', () => {
    expect(() => createLandingProofRunner({ repo: '/tmp/repo', argvByTest: {} })).toThrow(
      /no named proof commands were configured/,
    );
    expect(() => createLandingProofRunner({ repo: '/tmp/repo', argvByTest: { a: [] } })).toThrow(
      /must be a non-empty argv array/,
    );
    expect(() => createLandingProofRunner({ repo: 'repo', argvByTest: ARGV })).toThrow(
      /must be absolute/,
    );
    // Shell-looking characters are data, not a command: a legitimate `python -c` argument must be configurable.
    expect(() =>
      createLandingProofRunner({
        repo: '/tmp/repo',
        argvByTest: { a: ['python3', '-c', 'print(1); $HOME'] },
      }),
    ).not.toThrow();
  });
});
