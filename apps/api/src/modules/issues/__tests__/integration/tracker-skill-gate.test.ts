// The skill declarations on a gated write (8364 G5): the legal-template rule is opened for an agent only by the server's own live delivery receipt for
// that same agent and the pinned skill text. PREPARED, NOT RUN: it imports the label gate fixtures, so it stops at their grant guard until Root's serial
// database GO. Every case adds the legal-template label to a gated card whose stored description carries the Law Library block, with a valid size swap,
// so the only rule left to answer is the skill declaration under test.
// The last case needs an owner pin that includes the human parity atom (Sentinel fcfa0194). On the R3 owner snapshot it refuses with the templates
// skill wording instead, which is the behaviour before that atom.
// No request field reaches the op: setIssueLabels takes no flag and no actor kind, so a forged flag has no parameter to arrive in.
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  recordSkillReceipt,
  SKILL_RECEIPT_LIFETIME_MS,
  type TrackerSkill,
} from '@repo/db/tracker-skill-receipts';
import { deliverTrackerSkill } from '#modules/tracker-skills/service';
import * as F from './tracker-labels-gate-fixtures';

const TEMPLATE_LABEL = 'legal-template';
const BLOCK =
  "LAW LIBRARY COMPLIANCE: SOURCES ARE SETTLED under Misty's ruling.\n" +
  'text source, comment source, act window per code touched.\n' +
  'supersession receipt on file; no comment rows touched.\n' +
  'byte copy, never retyped (script).';
const TEMPLATES_REFUSAL = 'until the templates skill is loaded';
const LAW_LIBRARY_REFUSAL = 'until the law-library skill is loaded';
const BLOCK_REFUSAL = 'until the body carries the compliance block';
const SKILLS: TrackerSkill[] = ['templates', 'law_library'];

const dir = mkdtempSync(join(tmpdir(), 'tracker-skill-gate-'));
const digests = {} as Record<TrackerSkill, string>;
const pins = {} as Record<TrackerSkill, { path: string; sha256: string }>;
for (const skill of SKILLS) {
  const text = `# ${skill} skill\nSynthetic text for the receipt proof.\n`;
  const path = join(dir, `${skill}.md`);
  writeFileSync(path, text);
  digests[skill] = createHash('sha256').update(text).digest('hex');
  pins[skill] = { path, sha256: digests[skill] };
}
const manifest = join(dir, 'manifest.json');
writeFileSync(
  manifest,
  JSON.stringify({ ...JSON.parse(readFileSync(F.OWNER_CONFIG, 'utf8')), skills: pins }),
);
const withSkills = <T>(run: () => Promise<T>) =>
  F.withGateEnv([F.OWNER.python, F.OWNER.owner, manifest], run);

const users: string[] = [];
afterEach(async () => {
  for (const userId of users.splice(0))
    await F.db.execute(
      sql`DELETE FROM app_setting WHERE key LIKE ${`tracker.skill_receipt:%:${userId}`}`,
    );
  await F.cleanUp();
});
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// A gated card with the block stored and a legal-template label ready to add. The fixture's actor is the writer.
async function templateCase(tag: string, description: string = BLOCK) {
  const f = await F.fixture(true, tag);
  users.push(f.actorId);
  const card = await F.gatedCard(f, `Template card ${tag}`);
  await F.db.execute(sql`UPDATE issue SET description = ${description} WHERE id = ${card.issueId}`);
  const row = (await F.db.execute(
    sql`INSERT INTO label (project_id, name, color) VALUES (${f.projectId}, ${TEMPLATE_LABEL}, '#123456') RETURNING id`,
  )) as unknown as { id: number | string }[];
  const template = Number(row[0].id);
  const write = () =>
    withSkills(() => F.setIssueLabels(f.projectId, card.issueId, [f.large, template], f.actorId));
  const names = async () => (await F.linksOf(card.issueId)).map((link) => link.name);
  return { f, write, names };
}
const receipt = (userId: string, skill: TrackerSkill, digest = digests[skill], at = new Date()) =>
  recordSkillReceipt(userId, skill, digest, F.db, at);

describe('skill declarations on a gated legal-template write', () => {
  it('refuses an agent that holds no receipt and names the templates skill', async () => {
    const { f, write, names } = await templateCase('none');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    const refusal = await F.refusalOf(write);
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain(TEMPLATES_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });

  it('allows an agent after the server delivered both pinned skills to it', async () => {
    const { f, write, names } = await templateCase('delivered');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    for (const skill of SKILLS) {
      const served = await withSkills(() => deliverTrackerSkill(f.actorId, skill));
      expect(served.sha256).toBe(digests[skill]);
    }
    await write();
    expect(await names()).toEqual([TEMPLATE_LABEL, F.SIZE_LARGE]);
  });

  it('refuses on the law-library skill when only the templates skill was delivered', async () => {
    const { f, write, names } = await templateCase('half');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    await receipt(f.actorId, 'templates');
    const refusal = await F.refusalOf(write);
    expect(refusal.message).toContain(LAW_LIBRARY_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });

  it('refuses a receipt that is eight hours old', async () => {
    const { f, write, names } = await templateCase('expired');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    const old = new Date(Date.now() - SKILL_RECEIPT_LIFETIME_MS);
    await receipt(f.actorId, 'templates', digests.templates, old);
    await receipt(f.actorId, 'law_library');
    const refusal = await F.refusalOf(write);
    expect(refusal.message).toContain(TEMPLATES_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });

  it('refuses a receipt for a digest the manifest no longer pins', async () => {
    const { f, write, names } = await templateCase('digest');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    await receipt(f.actorId, 'templates', '0'.repeat(64));
    await receipt(f.actorId, 'law_library');
    const refusal = await F.refusalOf(write);
    expect(refusal.message).toContain(TEMPLATES_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });

  it("refuses an agent that would need another user's receipts", async () => {
    const { f, write, names } = await templateCase('cross');
    await F.asAgent(f.projectId, f.actorId, 'opus');
    const other = await F.fixture(true, 'cross-other');
    users.push(other.actorId);
    for (const skill of SKILLS) await receipt(other.actorId, skill);
    const refusal = await F.refusalOf(write);
    expect(refusal.message).toContain(TEMPLATES_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });

  it('checks a person on the Law Library block and not on the skills', async () => {
    const { write, names } = await templateCase('human', 'Plain notes with no block.');
    const refusal = await F.refusalOf(write);
    expect(refusal.message).toContain(BLOCK_REFUSAL);
    expect(refusal.message).not.toContain(TEMPLATES_REFUSAL);
    expect(await names()).toEqual([F.SIZE_SMALL]);
  });
});
