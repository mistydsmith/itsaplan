// The issue_activity payload of a landing record. Pure: no database, no ORM, so both the
// coordinator's tests and the native adapter in apps/api read one definition.
//
// WHY a payload discriminator: issue_activity_kind_check permits only 'comment' and 'activity',
// so the logical kind of a landing row is stored in the payload, where it is durable and is
// never confused with a comment body.
import type { CleanupObligationRow, LandingActivityRow, PriorActivity } from './landing-record';

export const LANDING_PAYLOAD_SCHEMA = 'sentinel-landing-record/v1';

export type LandingLogicalKind = 'landing_full' | 'landing_partial' | 'landing_cleanup';

export interface LandingPayload {
  schema: typeof LANDING_PAYLOAD_SCHEMA;
  logicalKind: LandingLogicalKind;
  activityId: string;
  itemKey: string;
  candidateSha: string;
  baseSha?: string;
  targetRef?: string | null;
  remoteSha?: string;
  partial?: boolean;
  obligation?: string;
  metadata?: Record<string, unknown> | null;
}

export function landingPayload(row: LandingActivityRow): LandingPayload {
  return {
    schema: LANDING_PAYLOAD_SCHEMA,
    logicalKind: row.kind,
    activityId: row.payload.activityId,
    itemKey: row.payload.itemKey,
    candidateSha: row.payload.candidateSha,
    baseSha: row.payload.baseSha,
    targetRef: row.payload.targetRef,
    remoteSha: row.payload.remoteSha,
    partial: row.payload.partial,
    metadata: row.payload.metadata,
  };
}

export function cleanupPayload(row: CleanupObligationRow): LandingPayload {
  return {
    schema: LANDING_PAYLOAD_SCHEMA,
    logicalKind: 'landing_cleanup',
    activityId: `${row.itemKey}:${row.candidateSha}:cleanup`,
    itemKey: row.itemKey,
    candidateSha: row.candidateSha,
    obligation: row.obligation,
  };
}

// A stored payload read back for the replay check. Any other activity on the issue is not a
// landing record.
export function priorFromPayload(payload: unknown): PriorActivity | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const row = payload as Partial<LandingPayload>;
  if (row.schema !== LANDING_PAYLOAD_SCHEMA) return null;
  if (typeof row.activityId !== 'string' || typeof row.candidateSha !== 'string') return null;
  const logical = row.logicalKind;
  if (logical !== 'landing_full' && logical !== 'landing_partial' && logical !== 'landing_cleanup')
    return null;
  return {
    kind: logical,
    payload: { activityId: row.activityId, candidateSha: row.candidateSha, itemKey: row.itemKey },
  };
}

export function landingsOnly(payloads: readonly unknown[]): PriorActivity[] {
  const out: PriorActivity[] = [];
  for (const payload of payloads) {
    const row = priorFromPayload(payload);
    if (row !== null) out.push(row);
  }
  return out;
}
