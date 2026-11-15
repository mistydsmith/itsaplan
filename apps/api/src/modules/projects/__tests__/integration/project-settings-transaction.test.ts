import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

// apps/api/src/modules/projects/__tests__/integration/project-settings-transaction.test.ts
// sentinel-prod-8429 prerequisite L1.
//
// WHY this file: getProjectSetting and getSubtaskAutomationSettings gained a caller-executor parameter, and the
// property that matters cannot be shown with a fake - a write inside a transaction must be visible to a read on
// that SAME transaction, and invisible to a pool read until it commits.
//
// The exact-target / NODE_ENV / no-worker guard runs BEFORE any DB import, following the neighbouring
// transaction-* suites (CT's review, 8429): a real transaction proof must never run against the wrong database.
// The fixtures create their own workspace, team and project, because team.workspace_id is NOT NULL with no
// default, and they delete the workspace so the cascade removes everything under it.

const EXPECTED_DB = 'itsaplan_8364_d2_test';

function assertTargetGuard(): void {
  const envUrl = process.env.DATABASE_URL ?? '';
  let u: URL;
  try {
    u = new URL(envUrl);
  } catch {
    throw new Error(
      `target guard: DATABASE_URL is not a parseable URL, got ${JSON.stringify(envUrl)}`,
    );
  }
  if (u.hostname !== '127.0.0.1' && u.hostname !== '::1')
    throw new Error(`target guard: host must be loopback (127.0.0.1 or ::1), got '${u.hostname}'`);
  if (u.port !== '5433') throw new Error(`target guard: port must be 5433, got '${u.port}'`);
  if (u.pathname !== `/${EXPECTED_DB}`)
    throw new Error(`target guard: path must be /${EXPECTED_DB}, got '${u.pathname}'`);
  if (process.env.NODE_ENV !== 'test') throw new Error('target guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('target guard: BUN_TEST_WORKER_ID must be unset (single process)');
}

// PREPARED, not executed: the suite runs only with ITSAPLAN_LANDING_D2=1, for Root's serial D2 slot.
const READY = (process.env.ITSAPLAN_LANDING_D2 ?? '').trim() === '1';

type Db = typeof import('@repo/db');
let schema: Db;
let getSubtaskAutomationSettings: typeof import('../../service').getSubtaskAutomationSettings;
let setSubtaskAutomationSettings: typeof import('../../service').setSubtaskAutomationSettings;

const runId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface Owned {
  workspaceId: number;
  projectId: number;
}

/** A workspace, team and project this case owns; the workspace delete cascades through all of them. */
async function ownProject(): Promise<Owned> {
  const id = runId();
  const [workspace] = await schema.db
    .insert(schema.workspace)
    .values({ name: `d2 ws ${id}` })
    .returning({ id: schema.workspace.id });
  const [team] = await schema.db
    .insert(schema.team)
    .values({ workspaceId: workspace.id, name: `d2 ${id}`, slug: `d2-${id}` })
    .returning({ id: schema.team.id });
  const [project] = await schema.db
    .insert(schema.project)
    .values({ teamId: team.id, name: `d2 ${id}`, key: `D2${id.slice(0, 5).toUpperCase()}` })
    .returning({ id: schema.project.id });
  return { workspaceId: workspace.id, projectId: project.id };
}

async function dropOwned(owned: Owned): Promise<void> {
  // WHY only the workspace: its cascade removes the team, the project and the project's settings, so the case
  // cannot leave a stray row and cannot delete anything it did not create.
  await schema.db.delete(schema.workspace).where(eq(schema.workspace.id, owned.workspaceId));
}

const d2 = READY ? describe : describe.skip;

if (READY) {
  assertTargetGuard();
  schema = await import('@repo/db');
  ({ getSubtaskAutomationSettings, setSubtaskAutomationSettings } = await import('../../service'));
}

d2('project settings read on the caller executor', () => {
  it('sees an uncommitted write on its own transaction, and the pool sees it only after commit', async () => {
    const owned = await ownProject();
    try {
      // WHY a holder: values assigned inside the transaction callback are not seen by the compiler's narrowing, so
      // a `let boolean | null` reads as null at the assertions and toBe rejects it.
      const seen: { inTx: boolean | null; onPoolDuringTx: boolean | null } = {
        inTx: null,
        onPoolDuringTx: null,
      };
      await schema.db.transaction(async (tx) => {
        await tx.insert(schema.projectSetting).values({
          projectId: owned.projectId,
          key: 'subtask_automation',
          value: { completeParent: true, closeSubtasks: false },
        });
        // Same executor: it must see the row this transaction just wrote.
        seen.inTx = (await getSubtaskAutomationSettings(owned.projectId, tx)).completeParent;
        // The pool cannot see an uncommitted row, which is what a pool read inside a landing would have done.
        seen.onPoolDuringTx = (await getSubtaskAutomationSettings(owned.projectId)).completeParent;
      });
      const afterCommit = await getSubtaskAutomationSettings(owned.projectId);
      expect(seen.inTx).toBe(true);
      expect(seen.onPoolDuringTx).toBe(false);
      expect(afterCommit.completeParent).toBe(true);
    } finally {
      await dropOwned(owned);
    }
  });

  it('leaves an existing default caller on the pool', async () => {
    const owned = await ownProject();
    try {
      await setSubtaskAutomationSettings(owned.projectId, {
        completeParent: true,
        closeSubtasks: true,
      });
      // No executor: the signature must behave exactly as it did before the parameter existed.
      await expect(getSubtaskAutomationSettings(owned.projectId)).resolves.toEqual({
        completeParent: true,
        closeSubtasks: true,
      });
    } finally {
      await dropOwned(owned);
    }
  });
});
