// Non-DB tests for skill delivery receipts: the manifest pins, the pinned-bytes read and the
// receipt's lifetime. The row read and write are covered by the API suite in the database slot.
// Run from packages/db: bun test --env-file=/dev/null src/__tests__/tracker_skill_receipts.test.ts

import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPinnedSkill,
  receiptIsLive,
  SKILL_RECEIPT_LIFETIME_MS,
  skillPromptsFor,
  skillPinsProblem,
  skillsNeededForLabels,
  TRACKER_SKILLS,
  workItemSkillsProblem,
  type TrackerSkill,
  type TrackerWorkItemSkills,
} from '../tracker-skill-receipts';

const dir = mkdtempSync(join(tmpdir(), 'tracker-skill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TEXT = '# Templates skill\nCopy approved wording verbatim.\n';
const path = join(dir, 'templates.md');
writeFileSync(path, TEXT);
const sha256 = createHash('sha256').update(TEXT).digest('hex');
const pin = { path, sha256 };
const NOW = new Date('2026-11-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

test('a valid skills section has no problem and a malformed one names it', () => {
  expect(skillPinsProblem({ templates: pin, law_library: pin })).toBeNull();
  expect(skillPinsProblem({})).toBeNull();
  expect(skillPinsProblem([])).toContain('must be a mapping');
  expect(skillPinsProblem({ pleading_forms: pin })).toContain('unknown skill: pleading_forms');
  expect(skillPinsProblem({ templates: { path: 'skills/a.md', sha256 } })).toContain(
    'absolute path',
  );
  expect(skillPinsProblem({ templates: { path, sha256: 'abc' } })).toContain('hex sha256');
  expect(skillPinsProblem({ templates: null })).toContain('absolute path');
});

test('the pinned bytes are served only while the file is the pinned text', async () => {
  expect(await readPinnedSkill(pin)).toBe(TEXT);
  expect(await readPinnedSkill({ path, sha256: '0'.repeat(64) })).toBeNull();
  expect(await readPinnedSkill({ path: join(dir, 'missing.md'), sha256 })).toBeNull();
});

test('a receipt is live for eight hours and only for the pinned digest', () => {
  const live = { digest: sha256, servedAt: ago(60_000) };
  expect(receiptIsLive(live, pin, NOW)).toBe(true);
  expect(receiptIsLive({ ...live, servedAt: ago(SKILL_RECEIPT_LIFETIME_MS - 1) }, pin, NOW)).toBe(
    true,
  );
  expect(receiptIsLive({ ...live, servedAt: ago(SKILL_RECEIPT_LIFETIME_MS) }, pin, NOW)).toBe(
    false,
  );
  // The pin changed after the delivery: the old receipt is dead at once.
  expect(receiptIsLive(live, { path, sha256: '1'.repeat(64) }, NOW)).toBe(false);
  // A delivery dated in the future is not a delivery.
  expect(receiptIsLive({ ...live, servedAt: ago(-60_000) }, pin, NOW)).toBe(false);
});

test('a missing pin, a missing receipt or a malformed one is never live', () => {
  expect(receiptIsLive({ digest: sha256, servedAt: ago(1) }, undefined, NOW)).toBe(false);
  expect(receiptIsLive(undefined, pin, NOW)).toBe(false);
  expect(receiptIsLive(null, pin, NOW)).toBe(false);
  expect(receiptIsLive(true, pin, NOW)).toBe(false);
  expect(receiptIsLive({ digest: sha256 }, pin, NOW)).toBe(false);
  expect(receiptIsLive({ digest: sha256, servedAt: 'yesterday' }, pin, NOW)).toBe(false);
});

// The work-item table of sentinel-prod-8429, in the shape the owner's manifest carries it. The two rulings are rows in the
// table, not code: headnotes carry jurisprudence, and a template card carries the law library so a pleading is checked against
// current law.
const ALL_PINS: Record<TrackerSkill, { path: string; sha256: string }> = {
  templates: pin,
  law_library: pin,
  pleading: pin,
  headnote_authoring: pin,
  jurisprudence: pin,
};
const TABLE: TrackerWorkItemSkills = {
  headnotes: ['headnote_authoring', 'law_library', 'jurisprudence'],
  'law-library': ['law_library'],
  law_library: ['law_library'],
  template: ['templates', 'pleading', 'law_library'],
  templates: ['templates', 'pleading', 'law_library'],
  pleading: ['templates', 'pleading', 'law_library'],
  'legal-template': ['templates', 'pleading', 'law_library'],
  'legal-form': ['templates', 'pleading', 'law_library'],
};

test('a sound work-item table has no problem and every malformed row names itself', () => {
  expect(workItemSkillsProblem(ALL_PINS, TABLE)).toBeNull();
  expect(workItemSkillsProblem(ALL_PINS, {})).toBeNull();
  expect(workItemSkillsProblem(ALL_PINS, [])).toContain('must be a mapping');
  expect(workItemSkillsProblem(ALL_PINS, null)).toContain('must be a mapping');
  expect(workItemSkillsProblem(ALL_PINS, { headnote: ['law_library'] })).toContain(
    'unknown work item label: headnote',
  );
  expect(workItemSkillsProblem(ALL_PINS, { headnotes: [] })).toContain('nonempty list of skills');
  expect(workItemSkillsProblem(ALL_PINS, { headnotes: 'law_library' })).toContain(
    'nonempty list of skills',
  );
  expect(workItemSkillsProblem(ALL_PINS, { headnotes: ['pleading_forms'] })).toContain(
    'headnotes names an unknown skill: pleading_forms',
  );
  expect(workItemSkillsProblem(ALL_PINS, { headnotes: ['law_library', 'law_library'] })).toContain(
    'names law_library twice',
  );
  // The row a server could never keep: it promises a skill the manifest pins no path for, so the route could not deliver it and
  // no receipt could ever be written for it.
  expect(
    workItemSkillsProblem({ templates: pin }, { templates: ['templates', 'pleading'] }),
  ).toContain('needs the pleading skill, which the manifest pins no path for');
});

test('the stored labels of a card choose its skills, and an unknown label asks for nothing', () => {
  expect(skillsNeededForLabels(['headnotes'], TABLE)).toEqual([
    'law_library',
    'headnote_authoring',
    'jurisprudence',
  ]);
  expect(skillsNeededForLabels(['template'], TABLE)).toEqual([
    'templates',
    'law_library',
    'pleading',
  ]);
  expect(skillsNeededForLabels(['law_library'], TABLE)).toEqual(['law_library']);
  expect(skillsNeededForLabels(['legal-form'], TABLE)).toEqual([
    'templates',
    'law_library',
    'pleading',
  ]);
  // Two labels on one card ask for one merged list, in the order the skills are declared, with no name twice.
  expect(skillsNeededForLabels(['headnotes', 'legal-template'], TABLE)).toEqual([
    ...TRACKER_SKILLS,
  ]);
  expect(skillsNeededForLabels(['pii_free', 'urgent'], TABLE)).toEqual([]);
  expect(skillsNeededForLabels(['headnotes'], {})).toEqual([]);
  expect(skillsNeededForLabels(['headnotes'], undefined)).toEqual([]);
  // A label is read as a stored label: case and padding are not the label the table knows.
  expect(skillsNeededForLabels(['Headnotes', ' headnotes '], TABLE)).toEqual([]);
});

test('a stored label that names something the table object itself answers asks for nothing', () => {
  // Office RETURN 2026-11-15: labels are free text, so a card can carry constructor, toString, valueOf, hasOwnProperty or
  // __proto__ as a label. Read straight off the table those are a function or the prototype, which is not a row and has no
  // includes, and the lookup threw. A label counts only when it is a name in the approved vocabulary, held directly on this
  // table, and actually a list.
  const inherited = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'includes',
  ];
  expect(() => skillsNeededForLabels(inherited, TABLE)).not.toThrow();
  expect(skillsNeededForLabels(inherited, TABLE)).toEqual([]);
  const broken = {
    headnotes: 'law_library',
    templates: undefined,
  } as unknown as TrackerWorkItemSkills;
  expect(skillsNeededForLabels(['headnotes', 'templates'], broken)).toEqual([]);
  // A table read from JSON answers only its own approved rows, even when the text carries a prototype-shaped key.
  const fromJson = JSON.parse(
    '{"__proto__": ["law_library"], "law_library": ["law_library"]}',
  ) as TrackerWorkItemSkills;
  expect(skillsNeededForLabels(['law_library'], fromJson)).toEqual(['law_library']);
  expect(skillsNeededForLabels(['__proto__'], fromJson)).toEqual([]);
});

test('a prompt names the pinned path and digest and the one route that records the delivery', () => {
  const needed = skillsNeededForLabels(['headnotes'], TABLE);
  const prompts = skillPromptsFor(ALL_PINS, needed, () => false);
  expect(prompts.map((row) => row.skill)).toEqual([
    'law_library',
    'headnote_authoring',
    'jurisprudence',
  ]);
  expect(prompts.map((row) => row.loadCommand)).toEqual([
    'GET /tracker/skills/law_library',
    'GET /tracker/skills/headnote_authoring',
    'GET /tracker/skills/jurisprudence',
  ]);
  expect(prompts.map((row) => row.sha256)).toEqual([sha256, sha256, sha256]);
  expect(prompts.map((row) => row.path)).toEqual([path, path, path]);
  // A skill this user already holds a live receipt for is not asked for again.
  expect(
    skillPromptsFor(ALL_PINS, needed, (skill) => skill === 'law_library').map((row) => row.skill),
  ).toEqual(['headnote_authoring', 'jurisprudence']);
  expect(skillPromptsFor(ALL_PINS, needed, () => true)).toEqual([]);
  expect(skillPromptsFor(undefined, needed, () => false)).toEqual([]);
});
