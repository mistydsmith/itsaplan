// The claim routes' request schema, DTO and refusal mapping. No database: only pure functions.
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ClaimRefusal, ClaimRefusalCode } from '@repo/db/issue-claim';
import { ClaimBody } from '../../model';
import { claimDto, claimExpired, claimRefusalError } from '../../service';

const refusal = (code: ClaimRefusalCode): ClaimRefusal => ({
  ok: false,
  code,
  message: `refused: ${code}`,
  authoritative: null,
});
const at = new Date('2026-11-15T06:00:00.000Z');

// The schema as a route applies it: a throwaway app with one route and no database.
const probe = new Elysia().post('/', ({ body }) => body, { body: ClaimBody });
const send = async (body: unknown) => {
  const res = await probe.handle(
    new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

describe('claim request body', () => {
  it('accepts an epoch of zero or more and refuses a missing, negative or fractional one', async () => {
    expect(await send({ expectedEpoch: 0 })).toEqual({ status: 200, body: { expectedEpoch: 0 } });
    expect(await send({ expectedEpoch: 7 })).toEqual({ status: 200, body: { expectedEpoch: 7 } });
    for (const bad of [{}, { expectedEpoch: -1 }, { expectedEpoch: 1.5 }, { expectedEpoch: null }])
      expect((await send(bad)).status).toBe(422);
  });

  // The framework drops properties the schema does not list before the handler runs.
  it('hands the handler the epoch only when the body also names an owner, an actor or a lease', async () => {
    for (const extra of [{ owner: 'u1' }, { actor: 'u1' }, { leaseSeconds: 9000 }, { now: 1 }])
      expect(await send({ expectedEpoch: 1, ...extra })).toEqual({
        status: 200,
        body: { expectedEpoch: 1 },
      });
  });
});

describe('claim DTO', () => {
  it('marks the claim as mine only for the user that holds it', () => {
    const state = { owner: 'u1', epoch: 3, expiresAt: at };
    expect(claimDto(state, false, 'u1')).toEqual({
      owner: 'u1',
      epoch: 3,
      expiresAt: '2026-11-15T06:00:00.000Z',
      expired: false,
      mine: true,
    });
    expect(claimDto(state, false, 'u2').mine).toBe(false);
    expect(claimDto({ owner: null, epoch: 4, expiresAt: null }, false, 'u1')).toMatchObject({
      owner: null,
      expiresAt: null,
      mine: false,
    });
  });

  it('counts a deadline equal to the clock as passed and no deadline as not expired', () => {
    const state = { owner: 'u1', epoch: 1, expiresAt: at };
    expect(claimExpired(state, at.getTime() - 1)).toBe(false);
    expect(claimExpired(state, at.getTime())).toBe(true);
    expect(claimExpired({ owner: null, epoch: 1, expiresAt: null }, at.getTime())).toBe(false);
  });
});

describe('claim refusal mapping', () => {
  it('maps a bad argument to 400 and a missing issue to 404', () => {
    expect(claimRefusalError(refusal('invalid-argument')).status).toBe(400);
    const missing = claimRefusalError(refusal('missing-row'));
    expect([missing.status, missing.message]).toEqual([404, 'Issue not found']);
  });

  it('maps every other refusal to 409 with a claim- code', () => {
    const codes: ClaimRefusalCode[] = [
      'stale-epoch',
      'live-other-owner',
      'not-claimed',
      'not-expired',
      'expired-lease',
      'wrong-owner',
    ];
    for (const code of codes) {
      const error = claimRefusalError(refusal(code));
      expect([error.status, error.code, error.message]).toEqual([
        409,
        `claim-${code}`,
        `refused: ${code}`,
      ]);
    }
  });
});
