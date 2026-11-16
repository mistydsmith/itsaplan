// Skill delivery receipts for the legal-template rule. The rule owner refuses legal-template work
// until the writer has the templates skill and the law-library skill. The server cannot observe
// what a model read, so it records what it can prove: it served these exact bytes to this
// authenticated user at this time. The writer turns a live receipt into the owner's declaration.
//
// WHY the receipt is keyed by the writer and by digest (sentinel-prod-8364 G5): a receipt another
// user holds, or one for skill text that has since changed, says nothing about this write. The
// manifest pins each skill's path and sha256; a receipt for any other digest is dead the moment
// the pin changes. A receipt is a row the server wrote, so a flag in a request body opens nothing.
//
// WHY the set is wider than the two skills the legal-template rule reads (sentinel-prod-8429, Misty
// 2026-11-15: "i also want words like the dss-law production skills - headnote, jurisprudence, template, law library - per work
// item"): a card's own labels name the kind of work it is, and the pinned manifest maps that kind to the skills it needs. Every
// skill in that map is delivered and received here, so there is one delivery mechanism - the tracker-skills route - and no second
// one per skill. The map is trusted config: a lane invents no row, and a row naming a skill the manifest does not pin is a config
// refusal before any claim or write runs.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
// Type only: tracker-gate.ts imports this file, and the gate must load in a process that has no
// database. Every function that touches a row takes the caller's executor.
import type { DbExecutor } from './client';
import { appSetting } from './schema/app';

export const TRACKER_SKILLS = [
  'templates',
  'law_library',
  'pleading',
  'headnote_authoring',
  'jurisprudence',
] as const;
export type TrackerSkill = (typeof TRACKER_SKILLS)[number];

// Root's ruling: a delivery is good for eight hours.
export const SKILL_RECEIPT_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface TrackerSkillPin {
  path: string;
  sha256: string;
}
export type TrackerSkillPins = Partial<Record<TrackerSkill, TrackerSkillPin>>;

export interface TrackerSkillReceipt {
  digest: string;
  servedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isTrackerSkill(value: unknown): value is TrackerSkill {
  return TRACKER_SKILLS.includes(value as TrackerSkill);
}

export function skillPinsProblem(skills: unknown): string | null {
  if (typeof skills !== 'object' || skills === null || Array.isArray(skills))
    return 'the manifest skills section must be a mapping';
  for (const [name, pin] of Object.entries(skills as Record<string, unknown>)) {
    if (!isTrackerSkill(name)) return `the manifest skills section names an unknown skill: ${name}`;
    const { path, sha256 } = (pin ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || !path.startsWith('/'))
      return `the manifest skill ${name} needs an absolute path`;
    if (typeof sha256 !== 'string' || !HEX64.test(sha256))
      return `the manifest skill ${name} needs a 64 character hex sha256`;
  }
  return null;
}

// The pinned bytes, or null when the file is unreadable or is not the text the manifest pins.
// A changed file is never served: its receipt would claim a delivery of text nobody reviewed.
export async function readPinnedSkill(pin: TrackerSkillPin): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(pin.path);
  } catch {
    return null;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) return null;
  return bytes.toString('utf8');
}

function receiptKey(userId: string, skill: TrackerSkill): string {
  return `tracker.skill_receipt:${skill}:${userId}`;
}

// One row per user and skill in app_setting; a later delivery replaces the earlier one.
export async function recordSkillReceipt(
  userId: string,
  skill: TrackerSkill,
  digest: string,
  executor: DbExecutor,
  now: Date = new Date(),
): Promise<TrackerSkillReceipt> {
  const value: TrackerSkillReceipt = { digest, servedAt: now.toISOString() };
  await executor
    .insert(appSetting)
    .values({ key: receiptKey(userId, skill), value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: sql`now()` } });
  return value;
}

export function receiptIsLive(
  receipt: unknown,
  pin: TrackerSkillPin | undefined,
  now: Date,
): boolean {
  if (pin === undefined || typeof receipt !== 'object' || receipt === null) return false;
  const { digest, servedAt } = receipt as Partial<TrackerSkillReceipt>;
  if (digest !== pin.sha256 || typeof servedAt !== 'string') return false;
  const served = Date.parse(servedAt);
  if (Number.isNaN(served)) return false;
  const age = now.getTime() - served;
  return age >= 0 && age < SKILL_RECEIPT_LIFETIME_MS;
}

// The work-item skills map: a card label to the skills that kind of card needs.
//
// WHY it is a manifest section and not code (sentinel-prod-8429): Misty approves the table and no lane invents a row, so the rows
// live in the pinned config the server already refuses to start without, next to the skill pins they name. A card's labels are
// the only input: the kind is never read from a title, a body, or any field a request could supply.
export const WORK_ITEM_LABELS = [
  'headnotes',
  'law-library',
  'law_library',
  'template',
  'templates',
  'pleading',
  'legal-template',
  'legal-form',
] as const;
export type WorkItemLabel = (typeof WORK_ITEM_LABELS)[number];
export type TrackerWorkItemSkills = Partial<Record<WorkItemLabel, TrackerSkill[]>>;

export function isWorkItemLabel(value: unknown): value is WorkItemLabel {
  return (WORK_ITEM_LABELS as readonly unknown[]).includes(value);
}

// The map's own shape, checked against the pins it must be able to name. A row naming a skill the manifest does not pin is
// refused here, before any claim or write, because the server would name a skill it can never deliver.
export function workItemSkillsProblem(skills: unknown, table: unknown): string | null {
  if (typeof table !== 'object' || table === null || Array.isArray(table))
    return 'the manifest work_item_skills section must be a mapping';
  const pins = (skills ?? {}) as TrackerSkillPins;
  for (const [label, needed] of Object.entries(table as Record<string, unknown>)) {
    if (!isWorkItemLabel(label))
      return `the manifest work_item_skills section names an unknown work item label: ${label}`;
    if (!Array.isArray(needed) || needed.length === 0)
      return `work_item_skills.${label} must be a nonempty list of skills`;
    const seen = new Set<string>();
    for (const skill of needed) {
      if (!isTrackerSkill(skill))
        return `work_item_skills.${label} names an unknown skill: ${skill}`;
      if (seen.has(skill)) return `work_item_skills.${label} names ${skill} twice`;
      seen.add(skill);
      if (pins[skill] === undefined)
        return `work_item_skills.${label} needs the ${skill} skill, which the manifest pins no path for`;
    }
  }
  return null;
}

// The skills a card's stored labels ask for, in the order this file lists the skills. A label the map does not know is no need,
// and a card with no known label needs nothing: the map adds a prompt, so it removes no refusal and no right.
function rowForLabel(table: TrackerWorkItemSkills, label: string): readonly TrackerSkill[] {
  // WHY three guards instead of a lookup (Office RETURN 2026-11-15): a card's labels are free text, so a label can be a
  // word the table object itself answers - constructor, toString, valueOf, hasOwnProperty, __proto__ - and table[label]
  // hands back a function or the prototype, which is not a row and has no includes. A label must be a name in the
  // approved vocabulary, held directly on this table, and actually a list, before it can ask for anything.
  if (!isWorkItemLabel(label)) return [];
  const row = Object.hasOwn(table, label) ? table[label as WorkItemLabel] : undefined;
  return Array.isArray(row) ? row : [];
}

export function skillsNeededForLabels(
  labels: readonly string[],
  table: TrackerWorkItemSkills | undefined,
): TrackerSkill[] {
  if (table === undefined) return [];
  return TRACKER_SKILLS.filter((skill) =>
    labels.some((label) => rowForLabel(table, label).includes(skill)),
  );
}

// What a lane is told to load: the skill's manifest path, its sha256, and the route that serves the pinned text and writes the
// receipt. WHY the command is the route itself: there is one delivery mechanism, and a prompt naming another door would teach a
// lane to fetch skill text somewhere a receipt is never written.
export interface TrackerSkillPrompt {
  skill: TrackerSkill;
  path: string;
  sha256: string;
  loadCommand: string;
}

export function skillPromptsFor(
  pins: TrackerSkillPins | undefined,
  needed: readonly TrackerSkill[],
  live: (skill: TrackerSkill) => boolean,
): TrackerSkillPrompt[] {
  // WHY a skill with no pin is not named: the server cannot deliver it, so a prompt would send a lane to a door its own tracker-skills
  // route does not have. The manifest cross-check refuses such a row before any claim answers, so this is the second answer, not
  // the first.
  return needed
    .filter((skill) => pins?.[skill] !== undefined && !live(skill))
    .map((skill) => ({
      skill,
      path: pins?.[skill]?.path ?? '',
      sha256: pins?.[skill]?.sha256 ?? '',
      loadCommand: `GET /tracker/skills/${skill}`,
    }));
}

// Whether this user holds a live receipt for the pinned text of the skill. No pins, no user or
// no receipt is false: the owner then refuses in its own words.
export async function holdsSkillReceipt(
  pins: TrackerSkillPins | undefined,
  userId: string | null,
  skill: TrackerSkill,
  executor: DbExecutor,
  now: Date = new Date(),
): Promise<boolean> {
  const pin = pins?.[skill];
  if (pin === undefined || userId === null) return false;
  const rows = await executor
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, receiptKey(userId, skill)));
  return receiptIsLive(rows[0]?.value, pin, now);
}
