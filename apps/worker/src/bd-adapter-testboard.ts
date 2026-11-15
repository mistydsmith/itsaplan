import type { BdCardView } from './bd-mapping';

// The shared card factory for the bd adapter test boards: a full BdCardView
// with the measured defaults, overridable field-by-field. Split out of
// bd-adapter.test.ts so the registration split (bd-adapter-registration.
// test.ts) can build its own boards without importing a test file
// (CT 2026-11-15 split, test bodies byte-identical).
export const card = (
  c: Partial<BdCardView> & { id: string; title: string; issue_type: string },
): BdCardView => ({
  description: '',
  status: 'open',
  priority: null,
  assignee: null,
  labels: [],
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...c,
});
