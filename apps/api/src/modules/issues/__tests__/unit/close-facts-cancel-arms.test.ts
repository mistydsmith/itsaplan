// The producer wiring for the owner's unowned Review cancel arm (sentinel-prod-8429.2): the close
// op carries review_cancel_actors (the owner CONFIG's pinned list) and author (the creator user id
// this server recorded on the card's created activity). Both are read on the transaction that holds
// the card's lock and never from the request body, so a caller-supplied value is overridden. No
// database: the manifest is a test-owned temp copy that pins the review_cancel_actors list.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { TRACKER_GATE_ENV } from '@repo/db/tracker-gate';
import type { DbExecutor } from '@repo/db';
import { attachCloseFacts, cardAuthor } from '../../close-facts';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const work = mkdtempSync(join(tmpdir(), 'close-cancel-arms-'));
const manifestPath = join(work, 'CONFIG.json');
const names = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];
const prior = names.map((name) => process.env[name]);

// A minimal valid manifest that pins the review_cancel_actors list. python and owner need only be
// absolute paths for the gate to reach the configured state, so named absolutes suffice; only the
// manifest is actually read.
beforeAll(() => {
  writeFileSync(
    manifestPath,
    JSON.stringify({
      pythonSha256: HEX64_A,
      fileSha256: { '/sentinel/tools/tracker_rule_claims.py': HEX64_B },
      review_cancel_actors: ['u-review-a', 'u-review-b'],
    }),
  );
  process.env[names[0]] = '/sentinel/tools/python';
  process.env[names[1]] = '/sentinel/owner';
  process.env[names[2]] = manifestPath;
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  names.forEach((name, index) => {
    if (prior[index] === undefined) delete process.env[name];
    else process.env[name] = prior[index];
  });
});

const countingTx = (rows: unknown[] | ((query: unknown) => unknown[])): DbExecutor =>
  ({
    execute: async (query: unknown) => (typeof rows === 'function' ? rows(query) : rows),
  }) as unknown as DbExecutor;

describe('8429.2 producer wiring: the cancel arm trusted facts on the close op', () => {
  // The operator_close and author reads share the transaction, so one row supplies is_agent,
  // member_role (operatorCloseFact) and actor_user_id (cardAuthor).
  const row = { is_agent: false, member_role: 'owner', actor_user_id: 'u-creator' };
  const input = { id: 7, rigPrefix: 'sentinel-prod', beadId: 'sentinel-prod-9', projectId: 1 };

  it('attaches the pinned list and the created author, overriding any caller-supplied value', async () => {
    const op: Record<string, unknown> = {
      review_cancel_actors: ['u-forged'],
      author: 'u-forged',
    };
    await attachCloseFacts(op, { ...input, tx: countingTx([row]), actorUserId: 'u-owner' });
    expect(op.review_cancel_actors).toEqual(['u-review-a', 'u-review-b']); // from the manifest
    expect(op.author).toBe('u-creator'); // from the created activity, not the caller
  });

  it('reads the card author from the created activity, and null when there is none', async () => {
    expect(await cardAuthor(countingTx([{ actor_user_id: 'u-creator' }]), 7)).toBe('u-creator');
    expect(await cardAuthor(countingTx([]), 7)).toBe(null);
  });
});
