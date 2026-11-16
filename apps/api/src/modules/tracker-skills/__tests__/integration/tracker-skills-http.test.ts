// GET /tracker/skills/:skill and its MCP tool with real sessions: the pinned text of each pinned skill
// is served byte for byte, the receipt is recorded for the session user only, and a
// receipt one user holds opens nothing for another. This file exists for the two skills Root pinned at
// the cutover (8364) and now carries the three 8429 skills (8429_SKILLS_BY_WORK_ITEM_SPEC_R1.md).
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag. This file
// never calls resetDb. It removes by id the users it signs up, their workspaces, their receipts
// and the OAuth client it registers. The skill files and the shared CONFIG are only read.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { TRACKER_SKILLS, type TrackerSkill } from '@repo/db/tracker-skill-receipts';
import { tempManifest } from '#tests/helpers/temp-manifest';
import * as F from '#modules/issues/__tests__/integration/tracker-labels-gate-fixtures';

const { app, api, authedApi } = await import('#tests/helpers/app');
const { signUpTestUser } = await import('#tests/helpers/auth');
const { connectMcpClient, mcpRpc, registerMcpClient } = await import('#tests/helpers/mcp');
const { routeTools } = await import('#mcp/generate');

// The pins Root composed for the two skills the tracker knew at the cutover. The files are read through
// the route only.
const PINS_SOURCE =
  process.env.TRACKER_SKILLS_TEST_MANIFEST ??
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/MANIFEST_DRAFT.json';
type Pins = Record<TrackerSkill, { path: string; sha256: string }>;
// The three 8429 skills are named here rather than read from a review candidate, because a test may not
// go red when a candidate file moves and the route serves only bytes a pin names. The same three path
// and digest pairs are in /Users/misty/Output/reports/8429_SKILLS_CONFIG_CANDIDATE_R2.json for Prime to
// install. WHY headnote_authoring is pinned to the master text (Root final ruling 2026-11-16): the pin names
// 52b5c955e1721b07d99de39e13fcbcb2d6ad3fa8f4f0d15977e6f0cc4664177f, the sha256 of the master copy of that
// skill. WHY the bytes are copied into a temporary directory this test owns rather than read from the shared
// path or from a future owner release: the release export has no path until Root composes one, and the shared
// skill file is what its owner is editing, so the test proves against a frozen local copy of the master text
// that no lane is writing to. WHY the copy is checked before it is pinned: a fixture that is not the master
// text would prove nothing, so its own digest is read here and the route's answer is proved again in the
// cases below.
const HEADNOTE_MASTER_SHA = '52b5c955e1721b07d99de39e13fcbcb2d6ad3fa8f4f0d15977e6f0cc4664177f';
const HEADNOTE_MASTER_SOURCE =
  process.env.TRACKER_SKILLS_TEST_HEADNOTE_MASTER ??
  '/Users/misty/Output/reports/8429_headnote_master_export/SKILL.md';
const headnoteFixtureDir = mkdtempSync(join(tmpdir(), 'tracker-skills-http-master-'));
const HEADNOTE_MASTER_PATH = join(headnoteFixtureDir, 'SKILL.md');
writeFileSync(HEADNOTE_MASTER_PATH, readFileSync(HEADNOTE_MASTER_SOURCE));
process.on('exit', () => rmSync(headnoteFixtureDir, { recursive: true, force: true }));
const NAMED_PINS: Partial<Pins> = {
  pleading: {
    path: '/Users/misty/Code/dss-law/skills/pleading/SKILL.md',
    sha256: '8797dc8bb632a7762bbd0ff80692428bd4de4f6908ec44fe0409e95da0ec21ac',
  },
  headnote_authoring: {
    path: HEADNOTE_MASTER_PATH,
    sha256: HEADNOTE_MASTER_SHA,
  },
  jurisprudence: {
    path: '/Users/misty/Code/dss-law/skills/jurisprudence/SKILL.md',
    sha256: '807ac141011b4366f6a5f0bd344ebe64c114debedc9202c54cb51efa4eb24ef6',
  },
};
const pins = {
  ...NAMED_PINS,
  ...(JSON.parse(readFileSync(PINS_SOURCE, 'utf8')) as { skills: Partial<Pins> }).skills,
} as Pins;
const composed = JSON.parse(readFileSync(F.OWNER_CONFIG, 'utf8')) as Record<string, unknown>;
const PINNED = tempManifest('tracker-skills-http-', { ...composed, skills: pins }).path;
// The same paths under a digest no file has.
const WRONG = tempManifest('tracker-skills-http-wrong-', {
  ...composed,
  skills: Object.fromEntries(
    TRACKER_SKILLS.map((skill) => [skill, { path: pins[skill].path, sha256: '0'.repeat(64) }]),
  ),
}).path;
const under = <T>(manifest: string, run: () => Promise<T>) =>
  F.withGateEnv([F.OWNER.python, F.OWNER.owner, manifest], run);

const signedUp: { userId: string; workspaceId: number | null }[] = [];
const clients: string[] = [];
async function person() {
  const user = await signUpTestUser({
    email: `zz-u4-skill-${signedUp.length}-${Date.now().toString(36)}@example.com`,
  });
  signedUp.push({ userId: user.userId, workspaceId: user.workspaceId });
  return { api: authedApi(user.cookie), userId: user.userId, cookie: user.cookie };
}
afterEach(async () => {
  await F.cleanUp();
  const drops = clients
    .splice(0)
    .map((id) => sql`DELETE FROM oauth_client WHERE client_id = ${id}`);
  for (const { userId, workspaceId } of signedUp.splice(0)) {
    drops.push(sql`DELETE FROM app_setting WHERE key LIKE ${`tracker.skill_receipt:%:${userId}`}`);
    if (workspaceId !== null)
      drops.push(
        sql`DELETE FROM team WHERE workspace_id = ${workspaceId}`,
        sql`DELETE FROM workspace WHERE id = ${workspaceId}`,
      );
    drops.push(sql`DELETE FROM "user" WHERE id = ${userId}`);
  }
  for (const drop of drops)
    await F.db.execute(drop).catch((error) => F.cleanupErrors.push(`skills http: ${error}`));
});

const receiptKeys = async (userId: string) =>
  (
    (await F.db.execute(
      sql`SELECT key FROM app_setting WHERE key LIKE ${`tracker.skill_receipt:%:${userId}`} ORDER BY key`,
    )) as unknown as { key: string }[]
  ).map((row) => row.key);
const receiptCount = async () =>
  Number(
    (
      (await F.db.execute(
        sql`SELECT count(*)::int AS n FROM app_setting WHERE key LIKE 'tracker.skill_receipt:%'`,
      )) as unknown as { n: number }[]
    )[0].n,
  );
const codeOf = (error: unknown) =>
  String((error as { value?: { code?: string } } | null)?.value?.code ?? '');

describe('8364 G5 GET /tracker/skills/:skill', () => {
  it('holds the master headnote text it claims to hold, in a copy no lane is editing', () => {
    // Root final ruling 2026-11-16: the config and this test pin the master headnote text 52b5c955... The
    // witness is the one a reviewer can run without Root's DB grant: the copy the pins name carries the digest
    // the pins name, and the pins name that copy and no other path.
    const fixture = createHash('sha256').update(readFileSync(HEADNOTE_MASTER_PATH)).digest('hex');
    expect(fixture).toBe(HEADNOTE_MASTER_SHA);
    expect(pins.headnote_authoring.sha256).toBe(HEADNOTE_MASTER_SHA);
    expect(pins.headnote_authoring.path).toBe(HEADNOTE_MASTER_PATH);
  });
  it('refuses a request with no session and records nothing', async () => {
    const before = await receiptCount();
    for (const skill of TRACKER_SKILLS) {
      const res = await under(PINNED, () => api.tracker.skills({ skill }).get());
      expect(res.status).toBe(401);
    }
    expect(await receiptCount()).toBe(before);
  }, 120_000);

  it('serves the exact pinned text of both skills and records receipts for the caller only', async () => {
    const reader = await person();
    const bystander = await person();
    for (const skill of TRACKER_SKILLS) {
      const res = await under(PINNED, () => reader.api.tracker.skills({ skill }).get());
      expect(res.status).toBe(200);
      const text = readFileSync(pins[skill].path, 'utf8');
      expect(res.data?.text).toBe(text);
      expect(res.data?.sha256).toBe(pins[skill].sha256);
      expect(
        createHash('sha256')
          .update(res.data?.text ?? '')
          .digest('hex'),
      ).toBe(pins[skill].sha256);
      expect(res.data?.skill).toBe(skill);
    }
    expect(await receiptKeys(reader.userId)).toEqual(
      [...TRACKER_SKILLS].sort().map((skill) => `tracker.skill_receipt:${skill}:${reader.userId}`),
    );
    expect(await receiptKeys(bystander.userId)).toEqual([]);
  }, 120_000);

  it('records nothing when the pin does not match the file, when no skill is pinned, and for an unknown skill', async () => {
    const reader = await person();
    for (const skill of TRACKER_SKILLS) {
      const mismatch = await under(WRONG, () => reader.api.tracker.skills({ skill }).get());
      expect([mismatch.status, codeOf(mismatch.error)]).toEqual([409, 'skill-pin-mismatch']);
      // The composed CONFIG pins no skills.
      const unpinned = await F.withOwner(() => reader.api.tracker.skills({ skill }).get());
      expect([unpinned.status, codeOf(unpinned.error)]).toEqual([404, 'skill-unpinned']);
    }
    const unknown = await under(PINNED, () =>
      reader.api.tracker.skills({ skill: 'pleading' as TrackerSkill }).get(),
    );
    // errorAnswer in shared/lib.ts answers a schema failure with 400.
    expect(unknown.status).toBe(400);
    expect(await receiptKeys(reader.userId)).toEqual([]);
  }, 120_000);

  // An agent's legal-template write is opened by that agent's own receipts and by nobody else's.
  it('refuses an agent while only another user fetched the skills, then allows it after its own fetch', async () => {
    const f = await F.fixture(true, 'skills-http');
    const card = await F.gatedCard(f, 'Template card over HTTP');
    await F.db.execute(
      sql`UPDATE issue SET description = ${
        "LAW LIBRARY COMPLIANCE: SOURCES ARE SETTLED under Misty's ruling.\n" +
        'text source, comment source, act window per code touched.\n' +
        'supersession receipt on file; no comment rows touched.\n' +
        'byte copy, never retyped (script).'
      } WHERE id = ${card.issueId}`,
    );
    const [label] = (await F.db.execute(
      sql`INSERT INTO label (project_id, name, color) VALUES (${f.projectId}, 'legal-template', '#123456') RETURNING id`,
    )) as unknown as { id: number | string }[];
    const agent = await person();
    const other = await person();
    await F.db.execute(
      sql`INSERT INTO project_member (project_id, user_id, role) VALUES (${f.projectId}, ${agent.userId}, 'member')`,
    );
    await F.asAgent(f.projectId, agent.userId, 'opus');
    const write = () =>
      under(PINNED, () =>
        F.setIssueLabels(f.projectId, card.issueId, [f.large, Number(label.id)], agent.userId),
      );
    const names = async () => (await F.linksOf(card.issueId)).map((link) => link.name);

    for (const skill of TRACKER_SKILLS)
      expect((await under(PINNED, () => other.api.tracker.skills({ skill }).get())).status).toBe(
        200,
      );
    const refusal = await F.refusalOf(write);
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('until the templates skill is loaded');
    expect(await names()).toEqual([F.SIZE_SMALL]);

    for (const skill of TRACKER_SKILLS)
      expect((await under(PINNED, () => agent.api.tracker.skills({ skill }).get())).status).toBe(
        200,
      );
    await write();
    expect(await names()).toEqual(['legal-template', F.SIZE_LARGE]);
  }, 180_000);
});

describe('8364 G5 read_tracker_skill MCP tool', () => {
  // Metadata only: what the generator builds from the route. No request is sent.
  it('is generated from the route with the route schema', () => {
    const tool = routeTools(app).find((entry) => entry.name === 'read_tracker_skill');
    expect(tool).toMatchObject({
      method: 'GET',
      path: '/tracker/skills/:skill',
      pathParams: ['skill'],
      hasBody: false,
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['skill']);
  });

  // A real invocation: tools/list and tools/call over /mcp with the person's OAuth token.
  it('serves the pinned text over MCP and records the receipt for the token user', async () => {
    const reader = await person();
    const clientId = await registerMcpClient('tracker skills proof');
    clients.push(clientId);
    const token = await connectMcpClient(reader.cookie, clientId);
    const { tools } = await mcpRpc(token, 'tools/list');
    const listed = tools.find((entry: { name: string }) => entry.name === 'read_tracker_skill');
    expect(Object.keys(listed.inputSchema.properties)).toEqual(['skill']);

    const result = await under(PINNED, () =>
      mcpRpc(token, 'tools/call', {
        name: 'read_tracker_skill',
        arguments: { skill: 'templates' },
      }),
    );
    expect(result.isError === true).toBe(false);
    const served = JSON.parse(result.content[0].text) as { sha256: string; text: string };
    expect(served.sha256).toBe(pins.templates.sha256);
    expect(served.text).toBe(readFileSync(pins.templates.path, 'utf8'));
    expect(await receiptKeys(reader.userId)).toEqual([
      `tracker.skill_receipt:templates:${reader.userId}`,
    ]);

    const bad = await under(PINNED, () =>
      mcpRpc(token, 'tools/call', { name: 'read_tracker_skill', arguments: { skill: 'pleading' } }),
    );
    expect(bad.isError).toBe(true);
    expect(await receiptKeys(reader.userId)).toHaveLength(1);
  }, 180_000);
});
