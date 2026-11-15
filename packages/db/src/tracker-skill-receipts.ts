// Skill delivery receipts for the legal-template rule. The rule owner refuses legal-template work
// until the writer has the templates skill and the law-library skill. The server cannot observe
// what a model read, so it records what it can prove: it served these exact bytes to this
// authenticated user at this time. The writer turns a live receipt into the owner's declaration.
//
// WHY the receipt is keyed by the writer and by digest (sentinel-prod-8364 G5): a receipt another
// user holds, or one for skill text that has since changed, says nothing about this write. The
// manifest pins each skill's path and sha256; a receipt for any other digest is dead the moment
// the pin changes. A receipt is a row the server wrote, so a flag in a request body opens nothing.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
// Type only: tracker-gate.ts imports this file, and the gate must load in a process that has no
// database. Every function that touches a row takes the caller's executor.
import type { DbExecutor } from './client';
import { appSetting } from './schema/app';

export const TRACKER_SKILLS = ['templates', 'law_library'] as const;
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
