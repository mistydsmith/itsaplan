// scripts/landing-git.test.ts — sentinel-prod-8429 auto-lander unit 3 (R3). Real Git facts from a temporary
// BARE repo built with hash-object, mktree, commit-tree and update-ref; no worktree, hooks or network.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEY,
  POLICY_INVALID_CASES,
  cleanupFixtures,
  code,
  decide,
  fixture,
  pair,
  policy,
  receiptFor,
} from './landing-git.test-fixtures';
import {
  evaluateGitEligibility,
  execRunner,
  hasAuthorshipTrailer,
  matches,
  sanitizedEnv,
  type GitPolicy,
} from './landing-git';

afterEach(cleanupFixtures);

describe('a clean candidate lands', () => {
  it('accepts the declared path, keeps a spaced path whole, and permits a multi-commit chain', () => {
    const one = pair('scripts/a.ts', 'code', `${KEY}: add a script`);
    const decision = decide(one.repo, one.candidate, one.base, ['scripts/a.ts']);
    expect([decision.eligible, decision.facts?.changedPaths, decision.facts?.subject]).toEqual([
      true,
      ['scripts/a.ts'],
      `${KEY}: add a script`,
    ]);

    const spaced = pair('docs/a file with spaces.ts', 'code', `${KEY}: spaced path`);
    expect(
      decide(spaced.repo, spaced.candidate, spaced.base, ['docs/a file with spaces.ts']).facts
        ?.changedPaths,
    ).toEqual(['docs/a file with spaces.ts']);

    const { repo, commit, setRef } = fixture();
    const base = commit('README.md', 'x', 'root');
    const first = commit('a.ts', 'a', `${KEY}: first`, [base]);
    const tip = commit('b.ts', 'b', `${KEY}: second`, [first]);
    setRef('refs/heads/main', base);
    const chain = decide(repo, tip, base, ['a.ts', 'b.ts']);
    expect(chain.eligible).toBe(true);
    expect(chain.facts?.changedPaths).toEqual(['a.ts', 'b.ts']);
  });
});

describe('shape, ancestry and target refusals', () => {
  it('refuses a short SHA before running any git command', () => {
    let calls = 0;
    const runner = {
      run() {
        calls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const refused = evaluateGitEligibility(
      policy('/nonexistent'),
      receiptFor('bad', 'nope', ['a']),
      runner,
    );
    expect(code(refused)).toBe('SHA_INVALID');
    expect(calls).toBe(0);
  });

  it('refuses merge, orphan, empty footprint, stale target, already landed, missing SHAs and mismatch', () => {
    const f = fixture();
    const base = f.commit('README.md', 'x', 'root');
    const left = f.commit('l.ts', 'l', `${KEY}: left`, [base]);
    const right = f.commit('r.ts', 'r', `${KEY}: right`, [base]);
    const merge = f.commit('m.ts', 'm', `${KEY}: merge`, [left, right]);
    const orphan = f.commit('o.ts', 'o', `${KEY}: other`, []);
    f.setRef('refs/heads/main', base);
    expect([
      code(decide(f.repo, merge, base, ['m.ts'])),
      code(decide(f.repo, orphan, base, ['o.ts'])),
    ]).toEqual(['CANDIDATE_IS_MERGE', 'BASE_NOT_ANCESTOR']);

    const same = pair('README.md', 'x', `${KEY}: no change`);
    expect(code(decide(same.repo, same.candidate, same.base, ['README.md']))).toBe(
      'EMPTY_FOOTPRINT',
    );
    expect(
      code(
        decide(same.repo, same.candidate, same.base, ['README.md'], {
          targetRef: 'refs/heads/nope',
        }),
      ),
    ).toBe('TARGET_MISSING');
    const absent = '0'.repeat(40);
    expect(code(decide(same.repo, absent, same.base, ['README.md']))).toBe('CANDIDATE_MISSING');
    expect(code(decide(same.repo, same.candidate, absent, ['README.md']))).toBe('BASE_MISSING');

    const moved = f.commit('moved.ts', 'm', `${KEY}: moved`, [base]);
    const onMoved = f.commit('scripts/moved.ts', 'code', `${KEY}: on moved`, [moved]);
    f.setRef('refs/heads/main', moved);
    const stale = decide(f.repo, onMoved, base, ['scripts/moved.ts']);
    expect(code(stale)).toBe('STALE_TARGET');
    expect(stale.reason).toContain(moved);
    f.setRef('refs/heads/main', onMoved);
    expect(code(decide(f.repo, onMoved, base, ['scripts/moved.ts']))).toBe('ALREADY_LANDED');

    const wrong = pair('s.ts', 's', 'p-9999: other item');
    expect(code(decide(wrong.repo, wrong.candidate, wrong.base, ['s.ts']))).toBe('SUBJECT_INVALID');
    const extra = pair('s.ts', 's', `${KEY}: one file`);
    const mismatch = decide(extra.repo, extra.candidate, extra.base, ['s.ts', 'not-changed.ts']);
    expect(code(mismatch)).toBe('PATHS_MISMATCH');
    expect(mismatch.reason).toContain('declared but unchanged');
    expect(decide(extra.repo, extra.candidate, extra.base, ['README.md']).reason).toContain(
      'changed but not declared',
    );
  });
});

describe('the exclusion policy is configured, never built in', () => {
  it('protects a path case-insensitively and refuses glob syntax', () => {
    const filing = pair('Legal/pleading.md', 'p', `${KEY}: a pleading`);
    const paths = ['Legal/pleading.md'];
    expect(
      decide(filing.repo, filing.candidate, filing.base, paths, {
        excludedPathPatterns: ['templates/'],
      }).eligible,
    ).toBe(true);
    const refused = decide(filing.repo, filing.candidate, filing.base, paths, {
      excludedPathPatterns: ['legal/'],
    });
    expect(code(refused)).toBe('EXCLUDED_PATH');
    expect(refused.reason).toContain('Legal/pleading.md');
  });

  it('refuses missing, blank, empty, glob and regex-looking policies before any git call', () => {
    let calls = 0;
    const runner = {
      run() {
        calls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    for (const [bad, expected] of POLICY_INVALID_CASES) {
      const decision = evaluateGitEligibility(
        bad as GitPolicy,
        receiptFor('1'.repeat(40), '2'.repeat(40), ['a.ts']),
        runner,
      );
      expect(code(decision)).toBe('POLICY_INVALID');
      expect(decision.reason).toContain(expected);
    }
    expect(calls).toBe(0);
  });
});

describe('the child environment is isolated and unknown states are failures', () => {
  it('strips routing overrides, pins config isolation, and never mutates the caller', () => {
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = '/somewhere/else';
    const env = sanitizedEnv();
    for (const name of [
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_EXEC_PATH',
    ])
      expect(env[name]).toBeUndefined();
    expect([
      env.GIT_CONFIG_NOSYSTEM,
      env.GIT_CONFIG_GLOBAL,
      env.GIT_CONFIG_SYSTEM,
      env.GIT_OPTIONAL_LOCKS,
    ]).toEqual(['1', '/dev/null', '/dev/null', '0']);
    expect(process.env.GIT_DIR).toBe('/somewhere/else');
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  });

  it('answers about the configured repository while GIT_DIR points at another one', () => {
    const savedDir = process.env.GIT_DIR;
    delete process.env.GIT_DIR;
    const first = pair('a.ts', 'a', `${KEY}: add`);
    const second = fixture();
    second.setRef('refs/heads/main', second.commit('only.ts', 'o', 'other repo'));
    process.env.GIT_DIR = second.repo;
    try {
      const decision = decide(first.repo, first.candidate, first.base, ['a.ts']);
      expect(decision.eligible).toBe(true);
      expect(decision.facts?.changedPaths).toEqual(['a.ts']);
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
    }
  });

  it('reports GIT_FAILED for a missing repository, a dead runner and an unreadable diff', () => {
    const missing = join(tmpdir(), `landing-git-absent-${Date.now()}`);
    const gone = evaluateGitEligibility(
      policy(missing),
      receiptFor('1'.repeat(40), '2'.repeat(40), ['a.ts']),
      execRunner(missing),
    );
    expect(code(gone)).toBe('GIT_FAILED');
    expect(gone.reason).toContain('not readable');

    const dead = { run: () => ({ status: 127, stdout: '', stderr: 'git: command not found' }) };
    expect(
      code(
        evaluateGitEligibility(
          policy('/r'),
          receiptFor('1'.repeat(40), '2'.repeat(40), ['a.ts']),
          dead,
        ),
      ),
    ).toBe('GIT_FAILED');

    const sha = (n: number) => String(n).repeat(40);
    let ancestry = 0;
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const stub = {
      run(args: readonly string[]) {
        if (args[0] === 'rev-parse')
          return ok(args.includes('--git-dir') ? '.git\n' : `${sha(2)}\n`);
        if (args[0] === 'rev-list') return ok(`${sha(1)}\n`);
        if (args[0] === 'merge-base')
          return { status: ++ancestry === 1 ? 0 : 1, stdout: '', stderr: '' };
        if (args[0] === 'show') return ok(`${KEY}: x\n`);
        return { status: 128, stdout: '', stderr: 'diff failed' };
      },
    };
    expect(
      code(evaluateGitEligibility(policy('/r'), receiptFor(sha(1), sha(2), ['a.ts']), stub)),
    ).toBe('GIT_FAILED');
  });
});

describe('authorship is checked across the whole landed range', () => {
  it('refuses a bad tip, a bad intermediate message, and a Claude identity', () => {
    const { repo, commit, setRef } = fixture();
    const base = commit('README.md', 'x', 'root');
    const bad = commit(
      'b.ts',
      'b',
      `${KEY}: first\n\nCo-Authored-By: Claude <noreply@anthropic.test>`,
      [base],
    );
    const tip = commit('t.ts', 't', `${KEY}: second`, [bad]);
    setRef('refs/heads/main', base);
    const decision = decide(repo, tip, base, ['b.ts', 't.ts']);
    expect(code(decision)).toBe('AUTHORSHIP_TRAILER');
    expect(decision.reason).toContain('1 landed message');

    const session = pair('t.ts', 't', `${KEY}: with trailer\n\nClaude-Session: abc`);
    expect(code(decide(session.repo, session.candidate, session.base, ['t.ts']))).toBe(
      'AUTHORSHIP_TRAILER',
    );

    for (const message of [
      'b\n\n   Co-Authored-By: X <x@y>',
      'b\n\n\tco-authored-by: X <x@y>',
      'b\n\nCLAUDE-SESSION: s',
    ])
      expect(hasAuthorshipTrailer(message)).toBe(true);
    expect(hasAuthorshipTrailer('body mentions co-authored-by in prose')).toBe(false);

    const one = pair('t.ts', 't', `${KEY}: clean message`);
    const runner = {
      run(args: readonly string[]) {
        if (args[0] === 'log')
          return {
            status: 0,
            stdout: `${KEY}: clean message\x1fClaude <noreply@anthropic.test>|X <x@y>\x1e`,
            stderr: '',
          };
        return execRunner(one.repo).run(args);
      },
    };
    expect(
      code(
        evaluateGitEligibility(
          policy(one.repo),
          receiptFor(one.candidate, one.base, ['t.ts']),
          runner,
        ),
      ),
    ).toBe('AUTHORSHIP_TRAILER');
  });
});

it('refuses a nested gated file, keeps Legalese and NotLegal clear, and writes no trace', () => {
  const nested = pair('apps/api/Legal/pleading.md', 'p', `${KEY}: a nested pleading`);
  expect(
    code(decide(nested.repo, nested.candidate, nested.base, ['apps/api/Legal/pleading.md'])),
  ).toBe('EXCLUDED_PATH');
  const library = pair('sentinel/Law Library/reviewed.json', 'x', `${KEY}: a reviewed file`);
  const gated = { excludedPathPatterns: ['Law Library/'] };
  expect(
    code(
      decide(
        library.repo,
        library.candidate,
        library.base,
        ['sentinel/Law Library/reviewed.json'],
        gated,
      ),
    ),
  ).toBe('EXCLUDED_PATH');
  const legalese = pair('Legalese/notes.md', 'n', `${KEY}: notes`);
  expect(
    code(decide(legalese.repo, legalese.candidate, legalese.base, ['Legalese/notes.md'])),
  ).not.toBe('EXCLUDED_PATH');

  const one = pair('c.ts', 'c', `${KEY}: child`);
  const trace = join(tmpdir(), `landing-git-trace-${Date.now()}.txt`);
  const saved = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    const decision = decide(one.repo, one.candidate, one.base, ['c.ts']);
    expect(decision.eligible).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = saved;
  }
  expect(existsSync(trace)).toBe(false);
});

describe('adversarial: the returned defects stay fixed', () => {
  it('a null policy and a malformed receipt refuse instead of throwing', () => {
    const receipt = receiptFor('1'.repeat(40), '2'.repeat(40), ['a.ts']);
    expect(() => evaluateGitEligibility(null as unknown as GitPolicy, receipt)).not.toThrow();
    expect(code(evaluateGitEligibility(null as unknown as GitPolicy, receipt))).toBe(
      'POLICY_INVALID',
    );

    const runner = { run: () => ({ status: 0, stdout: '', stderr: '' }) };
    expect(
      code(evaluateGitEligibility(policy('/r'), { ...receipt, allowedPaths: 7 } as never, runner)),
    ).toBe('RECEIPT_INVALID');
    const stringy = evaluateGitEligibility(
      policy('/r'),
      { ...receipt, allowedPaths: 'a.ts' } as never,
      runner,
    );
    expect(code(stringy)).toBe('RECEIPT_INVALID');
    expect(stringy.reason).not.toContain('a, .');
  });

  it('turns a 128 from the target resolve into GIT_FAILED and normalises protective patterns', () => {
    const one = pair('c.ts', 'c', `${KEY}: child`);
    const runner = {
      run(args: readonly string[]) {
        if (
          args[0] === 'rev-parse' &&
          args.includes('--verify') &&
          String(args[3]).startsWith('refs/')
        )
          return { status: 128, stdout: '', stderr: 'fatal: needed a single revision' };
        return execRunner(one.repo).run(args);
      },
    };
    expect(
      code(
        evaluateGitEligibility(
          policy(one.repo),
          receiptFor(one.candidate, one.base, ['c.ts']),
          runner,
        ),
      ),
    ).toBe('GIT_FAILED');

    expect(matches('Legal/pleading.md', 'Legal/ ')).toBe(true);
    expect(matches('apps/api/Legal/pleading.md', 'legal/')).toBe(true);
    expect(matches('apps/api/Legal/pleading.md', '/Legal/')).toBe(true);
    expect(matches('sentinel/Law Library/reviewed.json', 'Law Library/')).toBe(true);
    expect(matches('apps/api/Legal/x.md', 'apps/api/legal/')).toBe(true);
    expect([matches('Legalese/x.md', 'legal/'), matches('NotLegal/x.md', 'legal/')]).toEqual([
      false,
      false,
    ]);
    const filing = pair('Legal/pleading.md', 'p', `${KEY}: a pleading`);
    for (const pattern of ['/Legal/', 'Legal/ '])
      expect(
        code(
          decide(filing.repo, filing.candidate, filing.base, ['Legal/pleading.md'], {
            excludedPathPatterns: [pattern],
          }),
        ),
      ).toBe('EXCLUDED_PATH');
  });
});
