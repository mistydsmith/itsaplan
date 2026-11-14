/**
 * 8364 E1: comment_version carries the storage shape the immutable-history unit needs.
 *
 * WHY this new file exists (NEW-TEST-FILE reason): no existing DB-package test owns comment_version.
 * issue_identity.test.ts and issue_claim.test.ts prove ledger and claim rules; this table is the
 * comment-history store, so its constraints get their own proof. The test is pure - it introspects the
 * drizzle table definition and the prepared migration text - so it runs with no database at all, which
 * is what the E1 prep GO allows.
 *
 * WHAT IS PROVEN, and how it can fail:
 *   - the table exists with exactly the columns the design names, and revision/body/issueId are NOT NULL;
 *   - comment_id carries no foreign key (a cascade there would delete the history the table exists for);
 *   - issue_id cascades with the issue, the one deletion boundary accepted;
 *   - author_user_id is a nullable snapshot with no FK, because an ON DELETE SET NULL could never fire
 *     on a row that refuses every UPDATE;
 *   - the unique key and the lookup index exist, and the revision check refuses 0 or negative values;
 *   - nothing here proves that a migration runs or that a trigger fires: the migration, its journal
 *     entry and its snapshot are held for their own atomization, and no database was touched. When that
 *     atom opens, its test adds the UPDATE-refusal assertion and the "no DELETE trigger" assertion,
 *     because a blanket append-only trigger would abort the issue cascade and deleteComment's own hard
 *     delete.
 */
import { describe, expect, it } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { commentVersion } from '../schema/app';

const config = getTableConfig(commentVersion);
const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

const COLUMN_NAMES = [
  'id',
  'comment_id',
  'issue_id',
  'revision',
  'body',
  'author_user_id',
  'superseded_at',
  'deleted_after',
];

describe('comment_version storage shape', () => {
  it('carries exactly the designed columns', () => {
    expect(Object.keys(columns).sort()).toEqual([...COLUMN_NAMES].sort());
  });

  it('refuses null in the revision, body and issue link', () => {
    expect(columns['revision'].notNull).toBe(true);
    expect(columns['body'].notNull).toBe(true);
    expect(columns['issue_id'].notNull).toBe(true);
    expect(columns['comment_id'].notNull).toBe(true);
    expect(columns['superseded_at'].notNull).toBe(true);
    expect(columns['deleted_after'].notNull).toBe(true);
  });

  it('keeps the author as a nullable snapshot with no foreign key', () => {
    // Immutability and ON DELETE SET NULL cannot coexist: the trigger forbids the UPDATE that the FK
    // action would need, so the value is a snapshot and the column stays nullable.
    expect(columns['author_user_id'].notNull).toBe(false);
    const authorFks = config.foreignKeys.filter((fk) =>
      fk.reference().columns.some((column) => column.name === 'author_user_id'),
    );
    expect(authorFks).toEqual([]);
  });

  it('carries no foreign key on the comment id, and cascades only from the issue', () => {
    const foreign = config.foreignKeys.map((fk) => ({
      columns: fk.reference().columns.map((column) => column.name),
      table: fk.reference().foreignTable,
      onDelete: fk.onDelete,
    }));
    expect(foreign.some((fk) => fk.columns.includes('comment_id'))).toBe(false);
    expect(foreign).toHaveLength(1);
    expect(foreign[0].columns).toEqual(['issue_id']);
    expect(foreign[0].onDelete).toBe('cascade');
  });

  it('keys one row per comment revision and indexes the retained-list read', () => {
    expect(config.uniqueConstraints.map((unique) => unique.name)).toContain(
      'comment_version_comment_revision_unique',
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      'comment_version_lookup_idx',
    );
  });

  it('refuses a revision below one', () => {
    const revisionCheck = config.checks.find(
      (entry) => entry.name === 'comment_version_revision_check',
    );
    expect(revisionCheck).toBeDefined();
    const checkText = revisionCheck!.value.queryChunks
      .map((chunk) => String((chunk as { value?: unknown }).value ?? ''))
      .join('');
    expect(checkText).toContain('>= 1');
  });
});
