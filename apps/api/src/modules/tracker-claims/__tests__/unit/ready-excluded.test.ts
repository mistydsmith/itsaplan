// Which errors leave one card out of the ready pool and which fail the request. No database.
import { describe, expect, test } from 'bun:test';
import { HttpError } from '#shared/lib';
import { excludedReason } from '../../ready';

const refused = (code?: string, status = 409) => new HttpError(status, 'refused', code);

describe('excludedReason', () => {
  test('a card with an unproven fact is left out under that fact', () => {
    expect(excludedReason(refused('claim-unproven-kind-unknown'))).toBe('kind-unknown');
    expect(excludedReason(refused('claim-unproven-dependency-without-identity'))).toBe(
      'dependency-without-identity',
    );
  });

  test('a card the owner refuses, cannot route or cannot identify is left out', () => {
    expect(excludedReason(refused('tracker-rules-violation'))).toBe('owner-refused');
    expect(excludedReason(refused('lane-unrouted'))).toBe('lane-unrouted');
    expect(excludedReason(refused('issue-without-identity'))).toBe('issue-without-identity');
    expect(excludedReason(refused('issue-identity-mismatch'))).toBe('issue-identity-mismatch');
  });

  test('a card taken or deleted after the candidates were read is left out', () => {
    expect(excludedReason(refused('claim-live-other-owner'))).toBe('lease-taken');
    expect(excludedReason(refused('claim-stale-epoch'))).toBe('lease-taken');
    expect(excludedReason(refused(undefined, 404))).toBe('gone');
  });

  test('a missing rule config or user fails the request', () => {
    expect(excludedReason(refused('tracker-rules-unconfigured'))).toBeNull();
    expect(excludedReason(refused('tracker-rules-spawn-failed'))).toBeNull();
    expect(excludedReason(refused('tracker-rules-transport-error'))).toBeNull();
    expect(excludedReason(refused('claim-no-user'))).toBeNull();
    expect(excludedReason(refused())).toBeNull();
  });

  test('any other error fails the request', () => {
    expect(excludedReason(new Error('connection lost'))).toBeNull();
    expect(excludedReason(refused('claim-unproven-kind-unknown', 400))).toBeNull();
    expect(excludedReason(refused('tracker-rules-violation', 500))).toBeNull();
  });
});
