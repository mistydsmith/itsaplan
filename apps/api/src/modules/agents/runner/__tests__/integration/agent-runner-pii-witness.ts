// 8429 row 29, B — D2 owned-row one-case witness for the ACTUAL takeNextRun.
// Successor to the 2d7d4b27 witness: repairs the three witnessed defects
// (D1 attempts bookkeeping, D2 pull/claim handoff is not an HTTP POST, D3 cleanup
// protection before the first setup mutation); the source gate is frozen untouched.
//
// Standalone fixture source, NOT a test module: it imports nothing from the test rig,
// never calls resetDb, is never picked up by `bun test` and is never loaded by the
// API preload. It runs only when invoked explicitly against the rig database:
//
//   cd apps/api
//   DATABASE_URL=... BETTER_AUTH_SECRET=... \
//     bun run src/modules/agents/runner/__tests__/integration/agent-runner-pii-witness.ts
//
// One owned case, fixture-only. Honest scope: takeNextRun is the PULL/CLAIM half of
// delivery — it constructs and returns the framed claim; it sends no HTTP request.
// This witness proves the claim handoff, not an HTTP POST:
//   control — the production takeNextRun refuses the owned PII-bearing run before
//             framing (owner seam says the lane is local-only) and returns no claim.
//             The run row is permanently failed with the owner's words: the claim's
//             own bookkeeping set attempts to 1, and the failed status takes the row
//             out of the claim's reach for good — that terminal state is the
//             no-retry proof, not an untouched attempts column.
//   mutant  — one targeted mutation: the actual gate call removed from a throwaway
//             copy of the real service source (the B-test idiom); the re-queued
//             owned run is claimed through the copy and the forbidden framed claim,
//             carrying the owned PII task text, is returned.
//
// Safety: cleanup protection is entered before the first setup mutation. Every row
// the witness touches is one it created, all named w29_*; each created id is tracked
// the moment it is created, and a partial-creation failure removes only the ids this
// invocation created (exact ids, never a prefix sweep, never an upsert). Unrelated
// row counts are captured before the first mutation and asserted equal after cleanup
// (an aggregate guard, not byte-level proof). The synthetic owner answer and rule
// manifest are temp-dir fixtures; the environment, the owner seam and the temp files
// are restored independently of any failed DB cleanup.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { aiAgent, agentRun, db, project, team, user, workspace } from '@repo/db';
import { checkTrackerRules } from '@repo/db/tracker-rules';
import { setPiiAdmissionOwner } from '../../../core/pii-admission';
import { getRunnerAgent, takeNextRun } from '../../service';

const PREFIX = 'w29';
const BOT_USER_ID = `${PREFIX}bot-user`;
const BOT_USERNAME = `${PREFIX}bot`;
const seenOps: Record<string, unknown>[] = [];
const OWNER_MESSAGE = 'unknown-privacy work may not be routed to a cloud lane';
// The owned run's task text: a client matter, i.e. PII-bearing.
const RUN_PROMPT = 'Draft the lease renewal for the Smith family property file.';
// The gate block exactly as landed (comment through the refusal branch), so the
// mutation severs the ACTUAL production call, not a stand-in.
const GATE =
  /[ ]{2}\/\/ Outbound PII admission \(8429 row 29, B\):[\s\S]*?[ ]{2}if \(!admission\.ok\) \{\n[ ]{4}await markRunFailed\(row\.id, admission\.message\);\n[ ]{4}return null;\n[ ]{2}\}\n/;

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '[ok]' : '[FAIL]'} ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures += 1;
}

interface Owned {
  workspaceId: number | null;
  teamId: number | null;
  // The bot user's id, held only once THIS invocation's insert returned it: cleanup
  // deletes the user only then, so a preexisting collision or an earlier setup failure
  // never issues a foreign fixed-ID delete. Cleared after the cleanup that used it.
  userId: string | null;
  projectId: number | null;
  agentId: number | null;
  runId: number | null;
}

// Removes exactly the ids this invocation created, newest FK first. An individual
// delete failure is logged and does not skip the remaining ids.
async function deleteOwned(owned: Owned): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    [
      'agent_run',
      async () =>
        owned.runId === null ? null : db.delete(agentRun).where(eq(agentRun.id, owned.runId)),
    ],
    [
      'ai_agent',
      async () =>
        owned.agentId === null ? null : db.delete(aiAgent).where(eq(aiAgent.id, owned.agentId)),
    ],
    [
      'project',
      async () =>
        owned.projectId === null ? null : db.delete(project).where(eq(project.id, owned.projectId)),
    ],
    [
      'team',
      async () => (owned.teamId === null ? null : db.delete(team).where(eq(team.id, owned.teamId))),
    ],
    [
      'user',
      async () => (owned.userId === null ? null : db.delete(user).where(eq(user.id, owned.userId))),
    ],
    [
      'workspace',
      async () =>
        owned.workspaceId === null
          ? null
          : db.delete(workspace).where(eq(workspace.id, owned.workspaceId)),
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.log(`[cleanup] ${name} delete failed (logged, not skipped)`, err);
      failures += 1;
    }
  }
}

// Creates the owned fixture, tracking each id the moment it is created; a failure
// part-way removes only the ids already created and rethrows.
async function createOwned(): Promise<Owned> {
  const owned: Owned = {
    workspaceId: null,
    teamId: null,
    userId: null,
    projectId: null,
    agentId: null,
    runId: null,
  };
  try {
    const [ws] = await db
      .insert(workspace)
      .values({ name: `${PREFIX}-owned` })
      .returning({ id: workspace.id });
    owned.workspaceId = ws.id;
    const [tm] = await db
      .insert(team)
      .values({ workspaceId: ws.id, name: `${PREFIX}-team` })
      .returning({ id: team.id });
    owned.teamId = tm.id;
    // Plain insert, no upsert: a preexisting collision throws and the partial cleanup
    // removes only what this invocation created.
    const [usr] = await db
      .insert(user)
      .values({
        id: BOT_USER_ID,
        name: `${PREFIX} Bot`,
        email: `${PREFIX}bot+witness@w29.invalid`,
        emailVerified: true,
      })
      .returning({ id: user.id });
    // Ownership of the fixed id is recorded only now that the insert returned it:
    // before this line the id may be a preexisting foreign row, and cleanup must not
    // touch it.
    owned.userId = usr.id;
    const [proj] = await db
      .insert(project)
      .values({ teamId: tm.id, key: `${PREFIX.toUpperCase()}`, name: `${PREFIX} project` })
      .returning({ id: project.id });
    owned.projectId = proj.id;
    const [ag] = await db
      .insert(aiAgent)
      .values({
        teamId: tm.id,
        userId: usr.id,
        username: BOT_USERNAME,
        kind: 'external',
        // NULL: an agent a runner drains. takeNextRun is the claim, not a push.
        invocationUrl: null,
      })
      .returning({ id: aiAgent.id });
    owned.agentId = ag.id;
    const [run] = await db
      .insert(agentRun)
      .values({
        agentId: ag.id,
        projectId: proj.id,
        prompt: RUN_PROMPT,
        trigger: 'manual',
        status: 'pending',
        nextAttemptAt: new Date(),
      })
      .returning({ id: agentRun.id });
    owned.runId = run.id;
    return owned;
  } catch (err) {
    await deleteOwned(owned);
    throw err;
  }
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [
    'workspace',
    'team',
    '"user"',
    'project',
    'ai_agent',
    'agent_run',
    'issue',
    'issue_activity',
    'agent_chat_message',
  ]) {
    const rows = await db.execute(sql`select count(*)::int as n from ${sql.raw(table)}`);
    out[table] = Number((rows[0] as { n: number | string })['n']);
  }
  return out;
}

async function main(): Promise<void> {
  // Capture the environment before any mutation; the outer try guarantees the
  // restore even when a later setup step fails.
  const prior: Record<string, string | undefined> = {};
  for (const key of ['TRACKER_RULES_PYTHON', 'TRACKER_RULES_OWNER', 'TRACKER_RULES_MANIFEST']) {
    prior[key] = process.env[key];
  }
  let dir: string | null = null;
  let mutantPath: string | null = null;
  const owned: Owned = {
    workspaceId: null,
    teamId: null,
    userId: null,
    projectId: null,
    agentId: null,
    runId: null,
  };
  const before = await counts();
  try {
    dir = mkdtempSync(join(tmpdir(), 'pii-admission-d2-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pythonSha256: 'a'.repeat(64),
        fileSha256: { '/usr/bin/python3': 'a'.repeat(64) } as Record<string, string>,
        routing: {
          lanes: {
            [BOT_USERNAME]: { execution: 'cloud' },
            'local-lane': { execution: 'local' },
          },
          grants: [],
        },
      }),
    );
    const stubOwner = join(dir, 'owner.py');
    writeFileSync(stubOwner, '# synthetic seam: never executed, the seam replaces the owner\n');
    for (const [key, value] of Object.entries({
      TRACKER_RULES_PYTHON: '/usr/bin/python3',
      TRACKER_RULES_OWNER: stubOwner,
      TRACKER_RULES_MANIFEST: manifestPath,
    })) {
      process.env[key] = value;
    }
    setPiiAdmissionOwner(async (_config, op) => {
      seenOps.push(op);
      return { ok: false, code: 'tracker-rules-nonzero-exit', message: OWNER_MESSAGE };
    });
    const created = await createOwned();
    Object.assign(owned, created);
    console.log('[fixture] owned rows', JSON.stringify(owned));

    const servicePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'service.ts');
    const source = readFileSync(servicePath, 'utf8');
    check('gate block present in production source', source.match(GATE) !== null);
    const mutated = source.replace(GATE, '');
    check('mutation severs the production source', mutated !== source);
    mutantPath = join(dirname(servicePath), `service.mutant-witness-${process.pid}.ts`);
    writeFileSync(mutantPath, mutated);

    // CONTROL: the production takeNextRun on the owned PII-bearing run.
    const agent = (await getRunnerAgent(BOT_USER_ID))!;
    const control = await takeNextRun(agent);
    check('control: no claim handed out (null)', control === null, JSON.stringify(control));
    const [ctl] = await db
      .select({
        status: agentRun.status,
        lastError: agentRun.lastError,
        attempts: agentRun.attempts,
      })
      .from(agentRun)
      .where(eq(agentRun.id, owned.runId!));
    check(
      'control: run failed permanently with the owner\u2019s words',
      ctl.status === 'failed' && ctl.lastError === OWNER_MESSAGE,
      JSON.stringify(ctl),
    );
    // D1: the claim's own bookkeeping incremented attempts before admission, and
    // markRunFailed does not undo that; the no-retry proof is the terminal failed
    // state, which the claim's WHERE clause no longer reaches.
    check(
      'control: first claim bookkeeping recorded (attempts 1, terminal failed)',
      ctl.attempts === 1,
      `attempts=${ctl.attempts}`,
    );
    // Re-queue the owned run for the counterfactual: it is ours.
    await db
      .update(agentRun)
      .set({ status: 'pending', lastError: null, attempts: 0, nextAttemptAt: new Date() })
      .where(eq(agentRun.id, owned.runId!));
    // MUTANT: the same owned claim through the copy with the actual gate call removed.
    const mutant = await import(pathToFileURL(mutantPath).href);
    const forbidden = await mutant.takeNextRun((await getRunnerAgent(BOT_USER_ID))!);
    // D2: takeNextRun returns the framed claim; it does not POST. The forbidden
    // handoff is the returned claim carrying the owned PII task text.
    check(
      'mutant: the severed gate hands out the forbidden framed claim',
      forbidden !== null && typeof forbidden === 'object',
      JSON.stringify(forbidden)?.slice(0, 80) ?? 'null',
    );
    check(
      'mutant: the owned PII task text left the server in the claim',
      forbidden !== null &&
        (forbidden as { prompt?: string }).prompt?.includes(RUN_PROMPT) === true,
      JSON.stringify((forbidden as { prompt?: string } | null)?.prompt?.slice(0, 120)),
    );
  } finally {
    // Each resource is restored independently; a failed DB cleanup does not skip the
    // environment, the seam or the temp files.
    if (mutantPath) {
      try {
        rmSync(mutantPath, { force: true });
      } catch (err) {
        console.log('[cleanup] mutant file removal failed (logged, not skipped)', err);
      }
    }
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setPiiAdmissionOwner(checkTrackerRules);
    await deleteOwned(owned);
    owned.userId = null;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.log('[cleanup] temp dir removal failed (logged, not skipped)', err);
      }
    }
    try {
      const after = await counts();
      check(
        'unrelated rows untouched: every table count back to the baseline (aggregate guard)',
        JSON.stringify(before) === JSON.stringify(after),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      );
    } catch (err) {
      console.log('[cleanup] final count comparison failed (logged, not skipped)', err);
      failures += 1;
    }
    // Terminal lifecycle (repair authorized by Root after run 1): the postgres-js
    // pool the shared db client keeps open otherwise holds the event loop after the
    // last assertion, so an error path exits only under an external SIGTERM (run 1
    // WITNESS_PIPELINE_EXIT=143). This finally already runs on both the success and
    // error paths; closing the pool last - after every DB assertion above - lets the
    // process exit with its own exitCode. House convention: end with a timeout so a
    // wedged pool rejects into this log instead of hanging (landing-slot-driver).
    try {
      await db.$client.end({ timeout: 10 });
    } catch (err) {
      console.log('[cleanup] db pool close failed (logged, not skipped)', err);
      // D1 (Office STATIC-RETURN-R1): a rejected pool close is a failed lifecycle
      // cleanup, so it must count as a failure or the success tail would print
      // PASS with default exit 0 after the checks had all passed.
      failures += 1;
    }
  }
  console.log(failures === 0 ? '[witness] PASS' : `[witness] FAIL (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[witness] error', err);
  process.exitCode = 1;
});
