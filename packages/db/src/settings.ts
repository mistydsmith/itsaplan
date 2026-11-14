import { eq, sql } from 'drizzle-orm';
import { db, type DbExecutor } from './client';
import { appSetting } from './schema/app';

// Data access for global instance settings (app_setting): a key-value store, not
// scoped to a project. The value is a jsonb blob owned by the reading feature, so
// one table backs many settings. It lives here rather than in the api because both
// the api (god mode routes) and @repo/auth (the registration gate) read it.

// `executor` defaults to the process pool, so an ordinary call is unchanged. A caller
// that is already inside a transaction passes it, and the read then sees that
// transaction's own uncommitted rows and takes no second connection.
export async function getSetting<T>(key: string, executor: DbExecutor = db): Promise<T | null> {
  const rows = await executor
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, key));
  return rows[0] ? (rows[0].value as T) : null;
}

// Stores `value` only when the key is free, and returns what the key holds afterwards.
// The conflict branch rewrites the row with its own value so RETURNING yields the
// stored one, which makes processes racing on a first write settle on the same result.
export async function getOrCreateSetting<T>(key: string, value: T): Promise<T> {
  const rows = await db
    .insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: sql`${appSetting.value}` } })
    .returning({ value: appSetting.value });
  return rows[0]!.value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: { value, updatedAt: sql`now()` },
    });
}
