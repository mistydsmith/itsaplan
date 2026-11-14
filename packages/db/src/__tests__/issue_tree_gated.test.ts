import { afterAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import { parentLinkProblem, type ParentLinkProblem } from '../issue-tree';

// The gated-versus-ordinary parent rules, against a real Postgres. Ordinary fixtures are
// created and deleted by exact id; rig and ledger rows are never touched here.
const REQUIRED_DB = 'itsaplan_8364_c4_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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
const client = postgres(url, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end();
});

const made = {
  issue: [] as number[],
  column: [] as number[],
  project: [] as number[],
  team: [] as number[],
  workspace: [] as number[],
  rig: [] as number[],
};

async function project(gated: boolean): Promise<number> {
  const [workspace] =
    await client`INSERT INTO workspace (name) VALUES ('c4b tree ws') RETURNING id`;
  made.workspace.push(workspace.id as number);
  const [team] = await client`INSERT INTO team (workspace_id, name, slug)
    VALUES (${workspace.id}, 'c4b tree team', ${`c4b-tree-${workspace.id}`}) RETURNING id`;
  made.team.push(team.id as number);
  let rigId: number | null = null;
  if (gated) {
    const [rig] =
      await client`INSERT INTO rig (prefix) VALUES (${`c4b-tree-${workspace.id}`}) RETURNING id`;
    made.rig.push(rig.id as number);
    rigId = rig.id as number;
  }
  const [row] = await client`INSERT INTO project (team_id, key, name, rig_id)
    VALUES (${team.id}, ${`C4B${workspace.id}`}, 'c4b tree project', ${rigId}) RETURNING id`;
  made.project.push(row.id as number);
  return row.id as number;
}

let position = 0;
async function column(projectId: number): Promise<number> {
  position += 1;
  const [row] = await client`INSERT INTO project_column (project_id, name, position)
    VALUES (${projectId}, ${`Todo ${position}`}, ${position}) RETURNING id`;
  made.column.push(row.id as number);
  return row.id as number;
}

let sequence = 0;
async function issue(
  projectId: number,
  columnId: number,
  parentId: number | null,
  archived = false,
): Promise<number> {
  sequence += 1;
  // Two statements rather than one with spliced SQL, so nothing is ever built by string
  // concatenation.
  const [row] = archived
    ? await client`
        INSERT INTO issue (project_id, sequence_number, column_id, title, parent_id, archived_at)
        VALUES (${projectId}, ${sequence}, ${columnId}, 'c4b tree issue', ${parentId}, now())
        RETURNING id`
    : await client`
        INSERT INTO issue (project_id, sequence_number, column_id, title, parent_id)
        VALUES (${projectId}, ${sequence}, ${columnId}, 'c4b tree issue', ${parentId})
        RETURNING id`;
  made.issue.push(row.id as number);
  return row.id as number;
}

async function cleanUp(): Promise<void> {
  for (const id of made.issue.splice(0)) await client`DELETE FROM issue WHERE id = ${id}`;
  for (const id of made.column.splice(0)) await client`DELETE FROM project_column WHERE id = ${id}`;
  for (const id of made.project.splice(0)) await client`DELETE FROM project WHERE id = ${id}`;
  for (const id of made.team.splice(0)) await client`DELETE FROM team WHERE id = ${id}`;
  for (const id of made.workspace.splice(0)) await client`DELETE FROM workspace WHERE id = ${id}`;
  // Rig rows stay: the C1 guard refuses deletion.
}

async function ask(
  issueId: number | null,
  parentId: number,
  projectId?: number,
): Promise<ParentLinkProblem> {
  return parentLinkProblem(
    issueId,
    parentId,
    db,
    projectId === undefined ? {} : { expectedProjectId: projectId },
  );
}

describe('the harness guard refuses a wrong target without contacting it', () => {
  it('rejects the wrong environment, host, port, name and a persistent base', () => {
    const good = `postgres://nobody@127.0.0.1:5433/${REQUIRED_DB}`;
    expect(targetUrl(good, 'test')).toBe(good);
    expect(() => targetUrl(good, 'production')).toThrow(/NODE_ENV/);
    expect(() => targetUrl('postgres://nobody@db.example.com:5433/x', 'test')).toThrow(/loopback/);
    expect(() => targetUrl(`postgres://nobody@127.0.0.1:5432/${REQUIRED_DB}`, 'test')).toThrow(
      /5433/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/sentinel_test', 'test')).toThrow(
      /Sentinel/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/itsaplan', 'test')).toThrow(
      /refusing database/,
    );
  });
});

describe('gated projects are uncapped', () => {
  it('allows a chain deeper than a hundred levels', async () => {
    try {
      const projectId = await project(true);
      const columnId = await column(projectId);
      let parentId = await issue(projectId, columnId, null);
      const root = parentId;
      for (let i = 0; i < 120; i += 1) parentId = await issue(projectId, columnId, parentId);
      expect(await ask(null, parentId, projectId)).toBeNull();
      const deepest = await issue(projectId, columnId, parentId);
      expect(await ask(deepest, parentId, projectId)).toBeNull();
      // root placed under its own deepest descendant is the cycle; the other direction, the
      // deepest issue placed under root, is legal and already asserted above.
      expect(await ask(root, deepest, projectId)).toBe('cycle');
    } finally {
      await cleanUp();
    }
  }, 30_000);

  it('refuses a parent chain that already loops in stored data', async () => {
    try {
      const projectId = await project(true);
      const columnId = await column(projectId);
      const first = await issue(projectId, columnId, null);
      const second = await issue(projectId, columnId, first);
      // Write a loop directly: first under second. The guard on the API refuses this, so the
      // stored shape is made here to stand in for old imported data.
      await client`UPDATE issue SET parent_id = ${second} WHERE id = ${first}`;
      const fresh = await issue(projectId, columnId, null);
      expect(await ask(fresh, first, projectId)).toBe('cycle');
    } finally {
      await cleanUp();
    }
  });

  it('counts an archived ancestor like any other', async () => {
    try {
      const projectId = await project(true);
      const columnId = await column(projectId);
      const archived = await issue(projectId, columnId, null, true);
      expect(await ask(null, archived, projectId)).toBeNull();
      const middle = await issue(projectId, columnId, archived);
      expect(await ask(null, middle, projectId)).toBeNull();
    } finally {
      await cleanUp();
    }
  });

  it('refuses a parent in another project', async () => {
    try {
      const gatedA = await project(true);
      const gatedB = await project(true);
      const columnA = await column(gatedA);
      const parent = await issue(gatedA, columnA, null);
      const own = await issue(gatedB, await column(gatedB), null);
      expect(await ask(own, parent, gatedB)).toBe('cross-project');
    } finally {
      await cleanUp();
    }
  });

  it('refuses an issue being put under its own subtree', async () => {
    try {
      const projectId = await project(true);
      const columnId = await column(projectId);
      const top = await issue(projectId, columnId, null);
      const middle = await issue(projectId, columnId, top);
      const bottom = await issue(projectId, columnId, middle);
      expect(await ask(top, bottom, projectId)).toBe('cycle');
      expect(await ask(top, top, projectId)).toBe('cycle');
    } finally {
      await cleanUp();
    }
  });

  it('refuses a same-project parent whose stored ancestor belongs to another project', async () => {
    // Root's first countercase: the immediate parent is in this project, but the link it
    // already carries reaches into another one, which the complete walk must refuse.
    try {
      const gatedA = await project(true);
      const gatedB = await project(true);
      const columnA = await column(gatedA);
      const columnB = await column(gatedB);
      const foreign = await issue(gatedB, columnB, null);
      const parent = await issue(gatedA, columnA, foreign);
      const own = await issue(gatedA, columnA, null);
      expect(await ask(own, parent, gatedA)).toBe('cross-project');
    } finally {
      await cleanUp();
    }
  });

  it('refuses when an expected project disagrees with the issue own project', async () => {
    // Root's second countercase: an existing issue in A, an expected project of B, and a
    // parent in B. The issue row owns the association, so the disagreement refuses.
    try {
      const gatedA = await project(true);
      const gatedB = await project(true);
      const columnA = await column(gatedA);
      const columnB = await column(gatedB);
      const own = await issue(gatedA, columnA, null);
      const parentInB = await issue(gatedB, columnB, null);
      expect(await ask(own, parentInB, gatedB)).toBe('cross-project');
      // The honest expectation, the issue's own project, still answers about the real link.
      expect(await ask(own, parentInB, gatedA)).toBe('cross-project');
    } finally {
      await cleanUp();
    }
  });

  it('refuses a parent that does not exist', async () => {
    try {
      const projectId = await project(true);
      const columnId = await column(projectId);
      const own = await issue(projectId, columnId, null);
      expect(await ask(own, 2_000_000_000, projectId)).toBe('missing-parent');
    } finally {
      await cleanUp();
    }
  });
});

describe('ordinary projects keep their eight-level limit', () => {
  it('allows depth eight and refuses depth nine', async () => {
    try {
      const projectId = await project(false);
      const columnId = await column(projectId);
      // Seven issues make a chain whose deepest node sits at level seven; a new issue under
      // it becomes level eight, which must be allowed.
      let parentId = await issue(projectId, columnId, null);
      for (let i = 1; i < 7; i += 1) parentId = await issue(projectId, columnId, parentId);
      expect(await ask(null, parentId, projectId)).toBeNull();
      // One more extends the stored chain to level eight, so a new issue under it would be
      // level nine, which must be refused.
      const level8 = await issue(projectId, columnId, parentId);
      expect(await ask(null, level8, projectId)).toBe('depth');
    } finally {
      await cleanUp();
    }
  }, 30_000);

  it('still answers cycle for a self or descendant parent', async () => {
    try {
      const projectId = await project(false);
      const columnId = await column(projectId);
      const top = await issue(projectId, columnId, null);
      const child = await issue(projectId, columnId, top);
      expect(await ask(top, child, projectId)).toBe('cycle');
      expect(await ask(top, top, projectId)).toBe('cycle');
      expect(await ask(null, top, projectId)).toBeNull();
    } finally {
      await cleanUp();
    }
  });
});
