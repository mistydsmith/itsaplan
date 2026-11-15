import { t } from 'elysia';
import { pageQueryFields } from '#shared/pagination';

export const ClaimParams = t.Object({ issueId: t.Numeric() });

export const BeadParams = t.Object({ beadId: t.String({ minLength: 1 }) });

export const BeadIssueResponse = t.Object({
  id: t.Integer({ description: 'The issue id the claim and issue routes take.' }),
  beadId: t.String({ description: 'The full bead id as stored on the issue.' }),
});

// The epoch the caller last read is the whole request. Any other property is dropped before the
// handler runs, so a request cannot name an owner or a lease length.
export const ClaimBody = t.Object(
  {
    expectedEpoch: t.Integer({
      minimum: 0,
      description: 'The claim epoch you last read for this issue. 0 for an issue never claimed.',
    }),
  },
  { additionalProperties: false },
);

export const ClaimResponse = t.Object({
  owner: t.Nullable(t.String({ description: 'The user id that holds the claim, or null.' })),
  epoch: t.Integer({ description: 'Send this as expectedEpoch on the next claim request.' }),
  expiresAt: t.Nullable(t.String({ description: 'When the claim lapses unless it is extended.' })),
  expired: t.Boolean({ description: 'True when a claim is held and its deadline has passed.' }),
  mine: t.Boolean({ description: 'True when you hold the claim.' }),
  unchanged: t.Optional(
    t.Boolean({ description: 'True when the request found your live claim and wrote nothing.' }),
  ),
});

const Excluded = t.Record(t.String(), t.Integer(), {
  description: 'How many judged issues were left out, by reason.',
});

export const ProjectKeyParams = t.Object({ projectKey: t.String() });

export const ReadyQuery = t.Object(pageQueryFields);

// WHY this is not pageResponse: every count here is about the judged page. A field named total
// next to the items would read as the number of ready issues, which no page can state.
export const ReadyResponse = t.Object({
  items: t.Array(
    t.Object({
      id: t.Integer(),
      beadId: t.String(),
      title: t.String(),
      priority: t.Nullable(t.String()),
      epoch: t.Integer({ description: 'The claim epoch read when the issue was judged.' }),
    }),
  ),
  candidateTotal: t.Integer({
    description: 'Open issues with no live claim in the project, before any is judged.',
  }),
  evaluatedCount: t.Integer({ description: 'Candidates judged on this page.' }),
  eligibleCountOnPage: t.Integer({
    description: 'Items on this page. An empty page does not mean an empty pool.',
  }),
  excluded: Excluded,
  page: t.Integer(),
  pageSize: t.Integer(),
});

// The request states nothing: the server picks the issue, the epoch and the holder.
export const ReadyClaimBody = t.Object({}, { additionalProperties: false });

export const ReadyClaimResponse = t.Object({
  claimed: t.Nullable(
    t.Composite([t.Object({ id: t.Integer(), beadId: t.String() }), ClaimResponse]),
  ),
  evaluatedCount: t.Integer({ description: 'Candidates judged before the walk stopped.' }),
  excluded: Excluded,
});
