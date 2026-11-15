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
  skillPinsProblem,
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
  expect(skillPinsProblem({ pleading: pin })).toContain('unknown skill: pleading');
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
