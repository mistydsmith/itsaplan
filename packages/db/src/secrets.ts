import { eq, sql } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '@repo/crypto';
import { db, type DbExecutor } from './client';
import { appSecret } from './schema/app';

// Encrypted instance configuration (app_secret): one JSON blob per key, encrypted as
// a whole, with a `redacted` mirror the settings UI reads without decrypting. The
// plaintext counterpart is settings.ts (app_setting).
//
// It lives here because the api, @repo/auth and the bot all go through it, and only a
// process holding APP_ENCRYPTION_KEY can read a value back.

// `executor` defaults to the process pool, so an ordinary call is unchanged: the same
// row, the same decryption, the same APP_ENCRYPTION_KEY requirement. A caller inside a
// transaction passes it and reads the row that transaction wrote but has not committed.
export async function readSecret<T>(key: string, executor: DbExecutor = db): Promise<T | null> {
  const rows = await executor
    .select({ ciphertext: appSecret.ciphertext, iv: appSecret.iv, authTag: appSecret.authTag })
    .from(appSecret)
    .where(eq(appSecret.key, key));
  const row = rows[0];
  return row ? (JSON.parse(decryptSecret(row)) as T) : null;
}

export async function writeSecret(key: string, value: unknown, redacted: object): Promise<void> {
  const enc = encryptSecret(JSON.stringify(value));
  await db
    .insert(appSecret)
    .values({
      key,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      redacted,
    })
    .onConflictDoUpdate({
      target: appSecret.key,
      set: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        redacted,
        updatedAt: sql`now()`,
      },
    });
}
