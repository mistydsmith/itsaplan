// Focused real-database tests for the two shared transaction readers: getSetting
// (app_setting) and readSecret (app_secret). Both now take a trailing executor, so a
// caller that is already inside a transaction can read what it just wrote. Everything here
// is a dummy row under one test-owned key on the owned D2 test database, and every row is
// removed by that exact key. No real setting, secret, provider credential, rig or ledger
// row is read or written, and no secret value is ever put into an assertion message.
//
// Run from packages/db, gated and serial, with the standalone preflight first:
//   bun test --env-file=/dev/null src/__tests__/transaction-readers.test.ts
// DATABASE_URL must point at the owned itsaplan_8364_d2_test on 127.0.0.1:5433 and
// NODE_ENV must be test. The guard below runs before any client is created, so a refused
// target never opens a pool.

import { afterAll, beforeAll, expect, it } from 'bun:test';
import postgres from 'postgres';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import { appSecret, appSetting } from '../schema/app';
import type { DbExecutor } from '../client';

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// The one key this suite owns, used for both tables. Cleanup deletes by this key only.
const KEY = 'zz_qwen2_d2_transaction_readers';
const ABSENT_KEY = `${KEY}.never-written`;

interface Dummy {
  marker: string;
  value: number;
}
const dummy: Dummy = { marker: 'transaction-readers', value: 7 };

function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL does not parse');
  }
  const name = url.pathname.replace(/^\//, '');
  const port = url.port || '5432';
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(`refusing non-loopback host ${url.hostname}`);
  if (port !== '5433') throw new Error(`refusing port ${port}; this suite uses 5433`);
  if (/sentinel|trial/i.test(name))
    throw new Error('refusing a persistent trial or Sentinel database');
  if (name !== REQUIRED_DB)
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}

const url = targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

// A test-only encryption key: this suite encrypts and decrypts only its own dummy value,
// so no instance APP_ENCRYPTION_KEY is used. It is set before any crypto call, and no
// plaintext or ciphertext is ever logged.
process.env.APP_ENCRYPTION_KEY = 'zz-test-only-dummy-key-for-transaction-reader-tests';

// Imported only after the target is proven, so a refused target creates no pool.
const { getSetting } = await import('../settings');
const { readSecret, writeSecret } = await import('../secrets');
const { encryptSecret } = await import('@repo/crypto');

// Own connection (max 1) for fixtures, counts and cleanup. The readers' default executor
// comes from src/client.ts and is a different connection, which is what makes the
// "outside the transaction cannot see it" assertion meaningful rather than tautological.
const client = postgres(url, { max: 1, onnotice: () => undefined });
const testDb = drizzle(client, { schema });

// One transaction per case, always rolled back: nothing this suite writes is committed, so
// the owned database keeps every row it had.
const ROLLBACK = Symbol('rollback');
async function rolledBack(fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
  try {
    await testDb.transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function settingRows(): Promise<number> {
  const [row] = await client`SELECT count(*)::int AS n FROM app_setting WHERE key = ${KEY}`;
  return row.n as number;
}

async function secretRows(): Promise<number> {
  const [row] = await client`SELECT count(*)::int AS n FROM app_secret WHERE key = ${KEY}`;
  return row.n as number;
}

async function txSettingRows(executor: DbExecutor): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(appSetting)
    .where(eq(appSetting.key, KEY));
  return row.n;
}

async function insertSetting(executor: DbExecutor): Promise<void> {
  await executor.insert(appSetting).values({ key: KEY, value: dummy });
}

async function insertSecret(executor: DbExecutor): Promise<void> {
  const enc = encryptSecret(JSON.stringify(dummy));
  await executor.insert(appSecret).values({
    key: KEY,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    redacted: dummy,
  });
}

async function deleteBoth(): Promise<void> {
  await client`DELETE FROM app_setting WHERE key = ${KEY}`;
  await client`DELETE FROM app_secret WHERE key = ${KEY}`;
}

beforeAll(async () => {
  // The key is test-owned, so removing a leftover from an interrupted run is exact cleanup
  // rather than a repair of someone else's row. Then the suite states what it assumes.
  await deleteBoth();
  expect(await settingRows()).toBe(0);
  expect(await secretRows()).toBe(0);
});

afterAll(async () => {
  // Exact cleanup by the one owned key on both tables, then proof nothing was left behind.
  await deleteBoth();
  expect(await settingRows()).toBe(0);
  expect(await secretRows()).toBe(0);
  await client.end();
});

it('finds no row under its own key before it writes one', async () => {
  expect(await getSetting(KEY)).toBeNull();
  expect(await readSecret(KEY)).toBeNull();
});

it('reads its own uncommitted setting on the supplied executor', async () => {
  await rolledBack(async (tx) => {
    await insertSetting(tx);
    expect(await txSettingRows(tx)).toBe(1);
    expect(await getSetting<Dummy>(KEY, tx)).toEqual(dummy);
  });
  expect(await settingRows()).toBe(0);
});

it('reads its own uncommitted encrypted secret on the supplied executor', async () => {
  await rolledBack(async (tx) => {
    await insertSecret(tx);
    expect(await readSecret<Dummy>(KEY, tx)).toEqual(dummy);
    // Stored as an opaque blob: the row must not carry the plaintext it decrypts to, and
    // the three GCM parts must be distinct. No value is printed.
    const [row] = await tx
      .select({ ciphertext: appSecret.ciphertext, iv: appSecret.iv, authTag: appSecret.authTag })
      .from(appSecret)
      .where(eq(appSecret.key, KEY));
    expect(row.ciphertext).not.toContain(dummy.marker);
    expect(Buffer.from(row.ciphertext, 'base64').length).toBeGreaterThan(0);
    expect(row.iv).not.toBe(row.ciphertext);
    expect(row.authTag).not.toBe(row.ciphertext);
    expect(row.iv).not.toBe(row.authTag);
  });
  expect(await secretRows()).toBe(0);
});

it('keeps both uncommitted rows invisible to the default executor', async () => {
  await rolledBack(async (tx) => {
    await insertSetting(tx);
    await insertSecret(tx);
    // Same key, same moment, the readers' own pool: neither row is visible.
    expect(await getSetting(KEY)).toBeNull();
    expect(await readSecret(KEY)).toBeNull();
    // And the caller's executor does see both, so the two nulls above are isolation and
    // not a lost write.
    expect(await getSetting<Dummy>(KEY, tx)).toEqual(dummy);
    expect(await readSecret<Dummy>(KEY, tx)).toEqual(dummy);
  });
  expect(await settingRows()).toBe(0);
  expect(await secretRows()).toBe(0);
});

it('removes both rows when the transaction rolls back', async () => {
  await rolledBack(async (tx) => {
    await insertSetting(tx);
    await insertSecret(tx);
    expect(await getSetting<Dummy>(KEY, tx)).toEqual(dummy);
    expect(await readSecret<Dummy>(KEY, tx)).toEqual(dummy);
  });
  expect(await settingRows()).toBe(0);
  expect(await secretRows()).toBe(0);
  expect(await getSetting(KEY)).toBeNull();
  expect(await readSecret(KEY)).toBeNull();
});

it('keeps the reader usable after a savepoint refusal on the same executor', async () => {
  // A nested transaction is a SAVEPOINT on this driver, so the intended refusal below
  // aborts only its own block. The outer transaction stays live and the reader still
  // answers on it: no 25P02 aborted-state failure is mistaken for a passing refusal, and
  // no second connection is opened, which is what would self-deadlock a caller.
  let sawRefusal: unknown = null;
  try {
    await testDb.transaction(async (outer) => {
      await insertSetting(outer);
      try {
        await outer.transaction(async (savepoint) => {
          await insertSecret(savepoint);
          throw ROLLBACK;
        });
      } catch (error) {
        sawRefusal = error;
      }
      expect(sawRefusal).toBe(ROLLBACK);
      // Outer still live: the setting it wrote is still readable through the same executor,
      // and the refused secret insert is gone.
      expect(await txSettingRows(outer)).toBe(1);
      expect(await getSetting<Dummy>(KEY, outer)).toEqual(dummy);
      const [secretCount] = await outer
        .select({ n: count() })
        .from(appSecret)
        .where(eq(appSecret.key, KEY));
      expect(secretCount.n).toBe(0);
      throw ROLLBACK;
    });
  } catch (error) {
    // The outer transaction is rolled back on purpose; only that intended rollback may leave
    // this block, so an aborted-state or driver failure cannot pass as a green case.
    if (error !== ROLLBACK) throw error;
  }
  expect(sawRefusal).toBe(ROLLBACK);
  expect(await settingRows()).toBe(0);
  expect(await secretRows()).toBe(0);
});

it('reads a committed row on the default executor with the one-argument call', async () => {
  // Default call semantics are unchanged: one argument, the process pool, a committed row.
  await insertSetting(testDb);
  await insertSecret(testDb);
  expect(await settingRows()).toBe(1);
  expect(await secretRows()).toBe(1);
  expect(await getSetting<Dummy>(KEY)).toEqual(dummy);
  expect(await readSecret<Dummy>(KEY)).toEqual(dummy);
  await deleteBoth();
  expect(await getSetting(KEY)).toBeNull();
  expect(await readSecret(KEY)).toBeNull();
});

it('reads the same committed row on a caller transaction too', async () => {
  await insertSetting(testDb);
  await rolledBack(async (tx) => {
    expect(await getSetting<Dummy>(KEY, tx)).toEqual(dummy);
    expect(await getSetting<Dummy>(KEY)).toEqual(dummy);
  });
  await client`DELETE FROM app_setting WHERE key = ${KEY}`;
  expect(await settingRows()).toBe(0);
});

it('answers null for a key nobody wrote, on both doors', async () => {
  expect(await getSetting(ABSENT_KEY)).toBeNull();
  expect(await readSecret(ABSENT_KEY)).toBeNull();
  await rolledBack(async (tx) => {
    expect(await getSetting(ABSENT_KEY, tx)).toBeNull();
    expect(await readSecret(ABSENT_KEY, tx)).toBeNull();
  });
});

it('still reads back what the unchanged writer put there', async () => {
  // writeSecret is not part of this unit: it takes no executor and writes on the default
  // pool. readSecret must still read its row back, with and without a caller transaction.
  await writeSecret(KEY, dummy, { marker: true, value: true });
  expect(await secretRows()).toBe(1);
  expect(await readSecret<Dummy>(KEY)).toEqual(dummy);
  await rolledBack(async (tx) => {
    expect(await readSecret<Dummy>(KEY, tx)).toEqual(dummy);
  });
  await client`DELETE FROM app_secret WHERE key = ${KEY}`;
  expect(await secretRows()).toBe(0);
});
