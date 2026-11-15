import { describe, expect, it } from 'bun:test';

import {
  LANDING_PAYLOAD_SCHEMA,
  cleanupPayload,
  landingPayload,
  landingsOnly,
} from './landing-native-record';
import type { LandingActivityRow } from './landing-record';

const SHA = 'a'.repeat(40);
const row: LandingActivityRow = {
  itemKey: 'zz-1',
  kind: 'landing_full',
  action: 'landing_recorded',
  actorName: 'lane',
  body: 'landed',
  payload: {
    activityId: `zz-1:${SHA}`,
    itemKey: 'zz-1',
    candidateSha: SHA,
    baseSha: 'b'.repeat(40),
    targetRef: 'main',
    remoteSha: SHA,
    partial: false,
    metadata: null,
  },
};

describe('the landing payload', () => {
  it('stores the logical kind and the flight fields under the schema', () => {
    expect(landingPayload(row)).toEqual({
      schema: LANDING_PAYLOAD_SCHEMA,
      logicalKind: 'landing_full',
      ...row.payload,
    });
  });

  it('names a cleanup row by item and commit', () => {
    const cleanup = cleanupPayload({
      itemKey: 'zz-1',
      candidateSha: SHA,
      kind: 'landing_cleanup',
      obligation: 'release the lane',
    });
    expect(cleanup).toMatchObject({
      logicalKind: 'landing_cleanup',
      activityId: `zz-1:${SHA}:cleanup`,
      obligation: 'release the lane',
    });
  });

  it('reads back only rows that carry the schema and a known kind', () => {
    const stored = landingPayload(row);
    const read = landingsOnly([
      stored,
      null,
      'text',
      { ...stored, schema: 'other' },
      { ...stored, logicalKind: 'comment' },
      { ...stored, candidateSha: 7 },
      { subject: 'status' },
    ]);
    expect(read).toEqual([
      {
        kind: 'landing_full',
        payload: { activityId: stored.activityId, candidateSha: SHA, itemKey: 'zz-1' },
      },
    ]);
  });
});
