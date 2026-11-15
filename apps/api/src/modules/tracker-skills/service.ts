import { db } from '@repo/db';
import { loadTrackerRulesConfig } from '@repo/db/tracker-gate';
import {
  readPinnedSkill,
  recordSkillReceipt,
  type TrackerSkill,
} from '@repo/db/tracker-skill-receipts';
import { HttpError } from '#shared/lib';

// Serves the pinned text of a skill and records that this user was served it. The receipt is
// written only after the bytes matched the manifest pin, so a receipt never names text the
// manifest does not pin. The legal-template rule reads the receipt on the writer's next write.
export async function deliverTrackerSkill(userId: string, skill: TrackerSkill) {
  const config = await loadTrackerRulesConfig();
  const pin = config.state === 'configured' ? config.skills?.[skill] : undefined;
  if (pin === undefined) {
    throw new HttpError(404, `The rule manifest pins no ${skill} skill`, 'skill-unpinned');
  }
  const text = await readPinnedSkill(pin);
  if (text === null) {
    throw new HttpError(
      409,
      `The ${skill} skill file is unreadable or does not match its manifest pin`,
      'skill-pin-mismatch',
    );
  }
  const receipt = await recordSkillReceipt(userId, skill, pin.sha256, db);
  return { skill, sha256: receipt.digest, servedAt: receipt.servedAt, text };
}
