// 8429 row 29, B — D2 owned-row one-case witness for the ACTUAL takeNextRun.
//
// Standalone fixture source, NOT a test module: it imports nothing from the test rig,
// never calls resetDb, is never picked up by `bun test` and is never loaded by the
// API preload. It runs only when invoked explicitly against the rig database:
//
//   cd apps/api
//   DATABASE_URL=... BETTER_AUTH_SECRET=... \
//     bun run src/modules/agents/runner/__tests__/integration/agent-runner-pii-witness.ts
//
// One owned case, fixture-only:
//   control — the production takeNextRun refuses the owned PII-bearing run before
//             framing (owner seam says the lane is local-only), fails the run
//             permanently with the owner's words, and the in-process sink receives
//             nothing.
//   mutant  — one targeted mutation: the actual gate call removed from a throwaway
//             copy of the real service source (the B-test idiom); the re-queued
//             owned run is claimed through the copy and the forbidden framed prompt
//             POSTs to the owned in-process sink, carrying the owned prompt text.
//
// Safety: every row it touches is one it created, all named w29_*; unrelated row
// counts are captured before the run and asserted equal after the finally-cleanup,
// which deletes every owned row. The synthetic owner answer and rule manifest are
// written to a temp dir and the TRACKER_RULES_* environment is restored on exit.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { aiAgent, agentRun, project, team, user, workspace } from '@repo/db';
import { checkTrackerRules } from '@repo/db/tracker-rules';
import { setPiiAdmissionOwner } from '../../../core/pii-admission';
import { getRunnerAgent, takeNextRun } from '../../service';

const PREFIX = 'w29';
const BOT_USER_ID = `${PREFIX}bot-user`;
const BOT_USERNAME = `${PREFIX}bot`;
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
  workspaceId: number;
  teamId: number;
  projectId: number;
  agentId: number;
  runId: number;
}

interface Sink {
  port: number;
  posts: string[];
  close(): Promise<void>;
}

async function startSink(): Promise<Sink> {
  const posts: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST') posts.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    posts,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function counts(): Promise<Record<string, number>> {
  const { db } = await import('@repo/db');
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

async function createOwned(sink: Sink): Promise<Owned> {
  const { db } = await import('@repo/db');
  const [ws] = await db
    .insert(workspace)
    .values({ name: `${PREFIX}-owned` })
    .returning({ id: workspace.id });
  const [tm] = await db
    .insert(team)
    .values({ workspaceId: ws.id, name: `${PREFIX}-team` })
    .returning({ id: team.id });
  const [usr] = await db
    .insert(user)
    .values({
      id: BOT_USER_ID,
      name: `${PREFIX} Bot`,
      email: `${PREFIX}bot+witness@w29.invalid`,
      emailVerified: true,
    })
    .returning({ id: user.id });
  const [proj] = await db
    .insert(project)
    .values({ teamId: tm.id, key: `${PREFIX.toUpperCase()}`, name: `${PREFIX} project` })
    .returning({ id: project.id });
  const [ag] = await db
    .insert(aiAgent)
    .values({
      teamId: tm.id,
      userId: usr.id,
      username: BOT_USERNAME,
      kind: 'external',
      invocationUrl: `http://127.0.0.1:${sink.port}/${PREFIX}-sink`,
    })
    .returning({ id: aiAgent.id });
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
  return { workspaceId: ws.id, teamId: tm.id, projectId: proj.id, agentId: ag.id, runId: run.id };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pii-admission-d2-'));
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
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TRACKER_RULES_PYTHON: '/usr/bin/python3',
    TRACKER_RULES_OWNER: stubOwner,
    TRACKER_RULES_MANIFEST: manifestPath,
  })) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }
  const seenOps: Record<string, unknown>[] = [];
  setPiiAdmissionOwner(async (_config, op) => {
    seenOps.push(op);
    return { ok: false, code: 'tracker-rules-nonzero-exit', message: OWNER_MESSAGE };
  });
  const sink = await startSink();
  const before = await counts();
  const owned = await createOwned(sink);
  console.log('[fixture] owned rows', JSON.stringify(owned));

  const servicePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'service.ts');
  const source = readFileSync(servicePath, 'utf8');
  check('gate block present in production source', source.match(GATE) !== null);
  const mutated = source.replace(GATE, '');
  check('mutation severs the production source', mutated !== source);
  const mutantPath = join(dirname(servicePath), `service.mutant-witness-${process.pid}.ts`);
  writeFileSync(mutantPath, mutated);

  const { db } = await import('@repo/db');
  try {
    // CONTROL: the production takeNextRun on the owned PII-bearing run.
    const control = await takeNextRun((await getRunnerAgent(BOT_USER_ID))!);
    check('control: claim refused (null)', control === null, JSON.stringify(control));
    const [ctl] = await db
      .select({ status: agentRun.status, lastError: agentRun.lastError, attempts: agentRun.attempts })
      .from(agentRun)
      .where(eq(agentRun.id, owned.runId));
    check('control: run failed permanently with the owner\u2019s words', ctl.status === 'failed' && ctl.lastError === OWNER_MESSAGE, JSON.stringify(ctl));
    check('control: no retry scheduled (attempts untouched)', ctl.attempts === 0);
    check('control: sink received nothing', sink.posts.length === 0, `posts=${sink.posts.length}`);
    const op = seenOps.at(-1);
    check(
      'control: owner got the state op on the run\u2019s trusted facts, no proposed_state',
      op !== undefined && op.op === 'state' && op.id === `run-${owned.runId}` && !('proposed_state' in op),
      JSON.stringify(op),
    );
    // Re-queue the owned run for the counterfactual: it is ours.
    await db
      .update(agentRun)
      .set({ status: 'pending', lastError: null, attempts: 0, nextAttemptAt: new Date() })
      .where(eq(agentRun.id, owned.runId));
    // MUTANT: the same owned claim through the copy with the actual gate call removed.
    const mutant = await import(pathToFileURL(mutantPath).href);
    const forbidden = await mutant.takeNextRun((await getRunnerAgent(BOT_USER_ID))!);
    check(
      'mutant: the run is claimed and a dispatch POST reached the sink',
      sink.posts.length === 1,
      `posts=${sink.posts.length}`,
    );
    const body = sink.posts[0] ?? '';
    check('mutant: the owned PII prompt text left the server', body.includes(RUN_PROMPT), body.slice(0, 120));
    check(
      'mutant: the framed handoff shape reached the invocation URL',
      typeof forbidden === 'object' && forbidden !== null,
      JSON.stringify(forbidden)?.slice(0, 80) ?? '',
    );
  } finally {
    rmSync(mutantPath, { force: true });
    // Owned rows go, in FK order.
    await db.delete(agentRun).where(eq(agentRun.id, owned.runId));
    await db.delete(aiAgent).where(eq(aiAgent.id, owned.agentId));
    await db.delete(project).where(eq(project.id, owned.projectId));
    await db.delete(team).where(eq(team.id, owned.teamId));
    await db.delete(user).where(eq(user.id, BOT_USER_ID));
    await db.delete(workspace).where(eq(workspace.id, owned.workspaceId));
    await sink.close();
    setPiiAdmissionOwner(checkTrackerRules);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    const after = await counts();
    check(
      'unrelated rows untouched: every table count back to the baseline',
      JSON.stringify(before) === JSON.stringify(after),
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
  console.log(failures === 0 ? '[witness] PASS' : `[witness] FAIL (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[witness] error', err);
  process.exitCode = 1;
});
