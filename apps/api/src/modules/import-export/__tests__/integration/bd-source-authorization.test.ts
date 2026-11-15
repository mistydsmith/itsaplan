import { describe, it, expect } from 'bun:test';

// THE WITNESS (sentinel-prod-8429, prepared by qwen2 2026-11-15, Root's slice in msg_a1e39de3bb12; R2 repair of
// Root's RETURN in msg_1c1f5286ac02).
//
// WHAT IS CLAIMED HERE, and what is not. 617cd9cd put the server's bd board behind the instance-owner guard:
// requireBdOperator (apps/api/src/modules/import-export/bd.ts) calls requireGod (#shared/access), and
// apps/api/src/modules/import-export/index.ts calls it on POST .../import-jobs/bd-test-connection and
// POST .../import-jobs/bd-preview, and on POST .../import-jobs when body.source === 'bd' - while the route's own
// permission: ['import_export', 'create'] still applies. This file proves the authorization half of that over the
// real HTTP routes with real sessions: a person who owns the project, holds its import_export permission, and is not
// the instance owner is refused with the server's own 403, before any board read, before any config read, and before
// any command is attempted - and the job table is left exactly as it was found. It proves nothing about a real
// board's contents: no bd runs here, and no real board is named. The tripwire (an executable that exists nowhere and
// a board path that exists nowhere) is what makes "before" provable: had any of the three calls reached the command
// half, the answer would have carried the command's or the config's words instead of the door's.
//
// WHAT R2 ADDED, at Root's instruction: every 403 this witness counts as the door is now required to be the door -
// the assertion rejects the CSRF refusal the app answers for an Origin that is present but untrusted, and rejects a
// project-permission refusal, so a case that reads like the owner guard cannot silently be about membership or CSRF.
// bdCall sends the app's own APP_URL-derived Origin because that is what a call from the web app carries; it is test
// context, not a repair of a defect (Root's correction msg_1f293ef091f8, and measured: Bun's Request sends no Origin
// and no Sec-Fetch-Site on its own, so a request without either is allowed by the guard, not refused).
// The instance owner who reaches the command half is a project owner of the witness project through
// projectMember, because the permission half is not bypassed by a global role. The Plane contrast carries exactly the
// fields planeImportJobBody in 617cd9cd's model.ts requires (baseUrl, workspaceSlug, apiToken, planeProjectId,
// planeProjectKey; source is optional there and defaults to a Plane job), and the bd body carries source 'bd' with an
// optional sourceName, which is what bdImportJobBody accepts. Nothing here names a real board, a real credential or a
// real project.
//
// PREPARED, NOT RUN BY THIS LANE. The fixture leaf beside this file refuses at import unless Root sets
// ITSAPLAN_8429_QW2_BD_SOURCE_AUTH=granted, refuses a database that is not itsaplan_8364_d2_test on port 5433, and
// refuses a parallel test worker. Root composes this with the candidate and runs it serially; this lane ran no
// database and no provider. No global beforeEach is used and no table is cleared: each case builds its own accounts,
// project and - in one case - its own job, and cleanup deletes only the ids those calls captured.

import {
  bdCall,
  bdRoute,
  bdSourceFixture,
  cleanupFixture,
  importJobCountAll,
  importJobCountForProject,
  importJobsRoute,
  namesCommandOrConfigFailure,
  namesPermissionFailure,
  namesTripwire,
  OWNER_ONLY_ERROR,
  projectRoleOf,
  roleOf,
  TRIPWIRE_BD_COMMAND,
  TRIPWIRE_BOARD_ROOT,
  withTripwire,
  type Fixture,
} from './bd-source-authorization-fixtures';

// bdConnectionBody and bdPreviewBody in 617cd9cd's model.ts are t.Object({}): the board and the command are
// privileged server config, never a body field.
const BD_BODY = {};
// bdImportJobBody: source is required, sourceName is the optional name the job card shows.
const BD_JOB_BODY = { source: 'bd', sourceName: 'zz witness board' };

// The Plane differential: the same route, the same person, the same permission, a source the guard does not cover.
// Each field below is a field planeImportJobBody requires. The apiToken is a synthetic string the server will encrypt
// and never use: the job stays 'pending' and this lane never runs a worker or a provider call.
const PLANE_BODY = {
  source: 'plane',
  baseUrl: 'https://plane.zz-witness.invalid',
  workspaceSlug: 'zzw',
  apiToken: 'zz-witness-token-not-a-secret',
  planeProjectId: '00000000-0000-4000-8000-000000000001',
  planeProjectKey: 'ZZW',
};

// A 403 is only the door if it carries the door's words and not the words of the two other refusals that stand in
// front of it: the CSRF Origin guard in apps/api/src/app.ts, and the project permission the route also asks for.
function expectDoorRefusal(call: { status: number; body: string }): void {
  expect(call.status).toBe(403);
  expect(call.body).toContain(OWNER_ONLY_ERROR);
  expect(call.body).not.toContain('CSRF_ORIGIN_REJECTED');
  expect(namesPermissionFailure(call.body)).toBe(false);
  expect(namesTripwire(call.body)).toBe(false);
  expect(namesCommandOrConfigFailure(call.body)).toBe(false);
}

// Runs one case's act and asserts the two counts the claim needs: the instance's job table and this project's
// share of it, both unchanged.
async function expectNoJobCreated(fixture: Fixture, before: number): Promise<void> {
  const after = await importJobCountAll();
  expect(after).toBe(before);
  expect(await importJobCountForProject(fixture.projectId)).toBe(0);
}

describe('8429 bd-source authorization: the instance-owner door on the three bd routes', () => {
  it('refuses the bd board test-connection for a project owner who is not the instance owner, in the server words', async () => {
    const fixture = await bdSourceFixture();
    try {
      // The facts every 403 below rests on, read from the tables the server reads rather than assumed.
      expect(await roleOf(fixture.projectOwner.id)).toBe('user');
      expect(await roleOf(fixture.instanceOwner.id)).toBe('god');
      expect(await projectRoleOf(fixture.projectId, fixture.projectOwner.id)).toBe('owner');

      const before = await importJobCountAll();
      const res = await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-test-connection'), {
        cookie: fixture.projectOwner.cookie,
        body: BD_BODY,
      });
      expectDoorRefusal(res);
      await expectNoJobCreated(fixture, before);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('refuses the bd board preview the same way, because the preview reads the same server-global board', async () => {
    const fixture = await bdSourceFixture();
    try {
      const before = await importJobCountAll();
      const res = await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-preview'), {
        cookie: fixture.projectOwner.cookie,
        body: BD_BODY,
      });
      expectDoorRefusal(res);
      await expectNoJobCreated(fixture, before);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('refuses a bd import job at the door and leaves the job table exactly as it found it', async () => {
    const fixture = await bdSourceFixture();
    try {
      const before = await importJobCountAll();
      const res = await bdCall(fixture, 'POST', importJobsRoute(fixture), {
        cookie: fixture.projectOwner.cookie,
        body: BD_JOB_BODY,
      });
      expectDoorRefusal(res);
      await expectNoJobCreated(fixture, before);

      // And the project really has no job to find: the refusal created nothing to clean up.
      const listed = await bdCall(fixture, 'GET', importJobsRoute(fixture), {
        cookie: fixture.projectOwner.cookie,
      });
      expect(listed.status).toBe(200);
      expect(listed.body).toContain('[]');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('proves the refusal is the instance role and not the project permission: the same owner reaches the other import routes', async () => {
    const fixture = await bdSourceFixture();
    const createdJobIds: number[] = [];
    try {
      // The same permission the bd routes require (import_export create), on a route the guard does not cover.
      const exportRes = await bdCall(fixture, 'GET', `${importJobsRoute(fixture)}/export`, {
        cookie: fixture.projectOwner.cookie,
      });
      expect(exportRes.status).toBe(200);

      // And the very same POST route accepts a source the guard does not cover, for the same person, answering with
      // the job the model describes rather than an error the body shape would have produced.
      const plane = await bdCall(fixture, 'POST', importJobsRoute(fixture), {
        cookie: fixture.projectOwner.cookie,
        body: PLANE_BODY,
      });
      expect(plane.status).toBe(201);
      const created = JSON.parse(plane.body) as { id?: number; source?: string; status?: string };
      expect(typeof created.id).toBe('number');
      expect(created.source).toBe('plane');
      expect(created.status).toBe('pending');
      if (typeof created.id === 'number') createdJobIds.push(created.id);
      expect(await importJobCountForProject(fixture.projectId)).toBe(1);

      // The contrast, in the same breath: the bd source on that same route, same person, same permission.
      const bd = await bdCall(fixture, 'POST', importJobsRoute(fixture), {
        cookie: fixture.projectOwner.cookie,
        body: BD_JOB_BODY,
      });
      expectDoorRefusal(bd);
      expect(await importJobCountForProject(fixture.projectId)).toBe(1);
    } finally {
      await cleanupFixture(fixture, createdJobIds);
    }
  });

  it('answers 403 and not a command or config failure, with an unusable bd executable configured', async () => {
    const fixture = await bdSourceFixture();
    try {
      const before = await importJobCountAll();
      await withTripwire(async () => {
        for (const segment of ['bd-test-connection', 'bd-preview']) {
          const res = await bdCall(fixture, 'POST', bdRoute(fixture, segment), {
            cookie: fixture.projectOwner.cookie,
            body: BD_BODY,
          });
          expectDoorRefusal(res);
        }
        const job = await bdCall(fixture, 'POST', importJobsRoute(fixture), {
          cookie: fixture.projectOwner.cookie,
          body: BD_JOB_BODY,
        });
        expectDoorRefusal(job);
      });
      await expectNoJobCreated(fixture, before);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('proves the tripwire is live, so the 403 above is not a vacuous pass: the instance owner reaches the command half', async () => {
    const fixture = await bdSourceFixture();
    try {
      // The operator has to be a project owner too, or this call would be refused by the route's own permission and
      // the case would be reading the wrong guard. Said out loud, then checked.
      expect(await projectRoleOf(fixture.projectId, fixture.instanceOwner.id)).toBe('owner');
      expect(await roleOf(fixture.instanceOwner.id)).toBe('god');

      await withTripwire(async () => {
        const res = await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-test-connection'), {
          cookie: fixture.instanceOwner.cookie,
          body: BD_BODY,
        });
        // The door is open for the operator; what stops this call is the configured executable that does not
        // exist. That is the command half of the route speaking, which the role user above never reached.
        expect(res.status).not.toBe(403);
        expect(namesPermissionFailure(res.body)).toBe(false);
        expect(res.body).not.toContain(OWNER_ONLY_ERROR);
        expect(namesCommandOrConfigFailure(res.body)).toBe(true);
        expect(res.body).toContain(TRIPWIRE_BD_COMMAND);
        expect(res.body).toContain(TRIPWIRE_BOARD_ROOT);
      });
      expect(await importJobCountForProject(fixture.projectId)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reaches no command either when there is no session at all, with the tripwire configured', async () => {
    const fixture = await bdSourceFixture();
    try {
      const before = await importJobCountAll();
      await withTripwire(async () => {
        const res = await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-test-connection'), {
          body: BD_BODY,
        });
        expect(res.status).toBe(401);
        expect(namesTripwire(res.body)).toBe(false);
        expect(namesCommandOrConfigFailure(res.body)).toBe(false);
      });
      await expectNoJobCreated(fixture, before);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('does not leak the board path or the command name in any of the refusals it produced', async () => {
    const fixture = await bdSourceFixture();
    try {
      await withTripwire(async () => {
        const calls = [
          await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-test-connection'), {
            cookie: fixture.projectOwner.cookie,
            body: BD_BODY,
          }),
          await bdCall(fixture, 'POST', bdRoute(fixture, 'bd-preview'), {
            cookie: fixture.projectOwner.cookie,
            body: BD_BODY,
          }),
          await bdCall(fixture, 'POST', importJobsRoute(fixture), {
            cookie: fixture.projectOwner.cookie,
            body: BD_JOB_BODY,
          }),
        ];
        expect(calls.every((call) => call.status === 403)).toBe(true);
        expect(calls.every((call) => call.body.includes(OWNER_ONLY_ERROR))).toBe(true);
        expect(
          calls.some((call) => namesTripwire(call.body) || namesCommandOrConfigFailure(call.body)),
        ).toBe(false);
      });
      // The names this witness invented are still exactly two strings, both unused by the server.
      expect(TRIPWIRE_BD_COMMAND).toContain('zz-8429');
      expect(TRIPWIRE_BOARD_ROOT).toContain('zz-8429');
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
