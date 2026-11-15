// apps/api/src/modules/issues/landing-proof-runner.ts — sentinel-prod-8429 atom E: the real named proof runner.
// WHY it exists: scripts/landing-publish.ts validates proof outcomes but refuses to run anything itself, so until now every
// landing proof came from a fake. A landing whose proofs were never executed is a fabricated PASS, which is the one failure
// this whole programme exists to stop.
//
// WHAT MAY DECIDE A COMMAND: the host, at construction, through one argv map from an exact named test to an argv array. A
// name the host did not configure THROWS - so a receipt, a request body or a lane name can never introduce a command, and no
// string ever reaches a shell: spawn is called with shell: false and the argv array verbatim.
//
// WHY HEAD is checked twice: a proof that ran while the checkout was on a different commit is evidence about another tree.
// Before the first run and after the last, HEAD must equal the candidate the receipt names, or the run refuses.
//
// WHY the exit is the whole record: the outcome carries passed 1 / failed 0 for exit 0 and passed 0 / failed 1 otherwise,
// including a signalled child, so the CLI's existing PROOF_FAILED compare cannot be satisfied by a count this file invented.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

import type { LandingOutcome } from '../../../../../scripts/landing-evidence';
import type {
  ProofRunner,
  ProofRunInput,
  ProofRunResult,
} from '../../../../../scripts/landing-publish';

/** A named proof as the host configured it: an argv array, never a shell string. */
export type ProofArgvMap = Readonly<Record<string, readonly string[]>>;

export interface ProofExit {
  /** The child's exit code, or null when it was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnResult extends ProofExit {
  stdout: string;
  stderr: string;
}

/** Injection seam, so the runner is provable without starting a process. */
export type ProofSpawn = (argv: readonly string[], cwd: string) => Promise<SpawnResult>;

export interface LandingProofRunnerOptions {
  /** Absolute path of the checkout the proofs run in. Never request-supplied. */
  repo: string;
  /** Host configuration: exact named test -> argv. */
  argvByTest: ProofArgvMap;
  /** Read once at construction and used unchanged for every child. */
  env?: NodeJS.ProcessEnv;
  /** Test seams. Production omits both. */
  spawn?: ProofSpawn;
  head?: (repo: string) => string;
  /** Where a child's output goes when a proof fails; defaults to discarding it. */
  writeErr?: (text: string) => void;
}

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** The repository's HEAD, read through git's own argv - no shell, so nothing in a path can be interpreted. */
function gitHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function realSpawn(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, env, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Builds the ProofRunner the publish layer calls.
 *
 * WHY the configuration is validated at construction: a proof map with an empty argv, a non-array argv or a blank command is
 * a host mistake, and a landing that discovered it after taking the slot would have to release the slot to report it.
 */
export function createLandingProofRunner(options: LandingProofRunnerOptions): ProofRunner {
  if (blank(options.repo)) throw new Error('proof runner: an absolute repository path is required');
  if (typeof options.repo === 'string' && !options.repo.startsWith('/'))
    throw new Error(`proof runner: the repository path must be absolute, got '${options.repo}'`);
  const names = Object.keys(options.argvByTest ?? {});
  if (names.length === 0) throw new Error('proof runner: no named proof commands were configured');
  for (const name of names) {
    const argv = options.argvByTest[name];
    if (!Array.isArray(argv) || argv.length === 0)
      throw new Error(`proof runner: the command for '${name}' must be a non-empty argv array`);
    for (const part of argv) {
      if (blank(part))
        throw new Error(`proof runner: the command for '${name}' has a blank argument`);
      // WHY no metacharacter check: argv is handed to execve verbatim, so ';', '$' or '>' inside an argument are DATA. A
      // blacklist would refuse a legitimate `python -c "..."` or a test name containing one, without making anything safer.
    }
  }

  // WHY a copy: a retained process.env would let a later writer change the environment of a proof that was configured at
  // start-up, and two landings could then run under different environments.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const spawnProof = options.spawn ?? ((argv, cwd) => realSpawn(argv, cwd, env));
  const head = options.head ?? gitHead;
  const writeErr = options.writeErr ?? (() => undefined);

  return {
    async run(input: ProofRunInput): Promise<ProofRunResult> {
      const before = head(options.repo);
      if (before !== input.candidateSha) {
        throw new Error(
          `proof runner: the checkout is on ${before || '(no HEAD)'}, the candidate is ${input.candidateSha}`,
        );
      }

      const outcomes: LandingOutcome[] = [];
      for (const name of input.namedTests) {
        const argv = options.argvByTest[name];
        // WHY a throw and not a skip: skipping would leave the receipt's name unreported, and the CLI would then report a
        // names mismatch - when the truth is that the host never configured this test.
        if (argv === undefined) {
          throw new Error(`proof runner: no host-configured command for the named test '${name}'`);
        }
        const result = await spawnProof(argv, options.repo);
        const ok = result.code === 0;
        if (!ok) {
          const why =
            result.signal === null ? `exit ${String(result.code)}` : `signal ${result.signal}`;
          writeErr(`proof runner: '${name}' failed with ${why}\n${result.stderr.slice(-4000)}`);
        }
        outcomes.push({ name, passed: ok ? 1 : 0, failed: ok ? 0 : 1 });
      }

      const after = head(options.repo);
      if (after !== input.candidateSha) {
        throw new Error(
          `proof runner: the checkout moved during the proofs, from ${input.candidateSha} to ${after || '(no HEAD)'}; the outcomes are not about that candidate`,
        );
      }

      return { candidateSha: input.candidateSha, outcomes };
    },
  };
}
