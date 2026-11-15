// apps/api/src/modules/tracker-landings/model.ts — sentinel-prod-8429 atom F1: the route's request schemas.
// WHY a model file: the API layer validates at the edge with Elysia's TypeBox schemas, so a body is checked before a handler
// sees it rather than trusted and hand-checked afterwards.
//
// WHY the body carries no host field: repository, ref, remote, expected push URL, excluded paths, project and column, close repo
// key, manifest, closer and proof commands are HOST configuration. This schema names only item evidence and a mode, so a client
// cannot even express a landing against another tree.

import { t } from 'elysia';

export const LandingParams = t.Object({
  repoKey: t.String({ minLength: 1 }),
  itemKey: t.String({ minLength: 1 }),
});

export const LandingRequestBody = t.Object({
  receipts: t.Optional(t.Array(t.Unknown())),
  verdicts: t.Optional(t.Array(t.Unknown())),
  columns: t.Optional(t.Array(t.Unknown())),
  status: t.Optional(t.String()),
  archived: t.Optional(t.Boolean()),
  mode: t.Optional(t.Union([t.Literal('land'), t.Literal('record')])),
});

export type LandingParamsType = typeof LandingParams.static;
export type LandingRequestBodyType = typeof LandingRequestBody.static;

export const LandingResponse = t.Object({
  report: t.Object(
    { ok: t.Boolean(), stage: t.String(), reason: t.String() },
    { additionalProperties: true },
  ),
});
