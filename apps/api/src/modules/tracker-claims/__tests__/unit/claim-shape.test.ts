// The claim routes' request schema, DTO and refusal mapping. No database: only pure functions.
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ClaimRefusal, ClaimRefusalCode } from '@repo/db/issue-claim';
import { ClaimBody } from '../../model';
import { claimDto, claimExpired, claimRefusalError } from '../../service';
import { claimSkillPrompts, claimSkillPromptsAfterClaim } from '../../skill-answer';
import type { TrackerWorkItemSkills } from '@repo/db/tracker-skill-receipts';

const refusal = (code: ClaimRefusalCode): ClaimRefusal => ({
  ok: false,
  code,
  message: `refused: ${code}`,
  authoritative: null,
});
const at = new Date('2026-11-15T06:00:00.000Z');

// The schema as a route applies it: a throwaway app with one route and no database.
const probe = new Elysia().post('/', ({ body }) => body, { body: ClaimBody });
const send = async (body: unknown) => {
  const res = await probe.handle(
    new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

describe('claim request body', () => {
  it('accepts an epoch of zero or more and refuses a missing, negative or fractional one', async () => {
    expect(await send({ expectedEpoch: 0 })).toEqual({ status: 200, body: { expectedEpoch: 0 } });
    expect(await send({ expectedEpoch: 7 })).toEqual({ status: 200, body: { expectedEpoch: 7 } });
    for (const bad of [{}, { expectedEpoch: -1 }, { expectedEpoch: 1.5 }, { expectedEpoch: null }])
      expect((await send(bad)).status).toBe(422);
  });

  // The framework drops properties the schema does not list before the handler runs.
  it('hands the handler the epoch only when the body also names an owner, an actor or a lease', async () => {
    for (const extra of [{ owner: 'u1' }, { actor: 'u1' }, { leaseSeconds: 9000 }, { now: 1 }])
      expect(await send({ expectedEpoch: 1, ...extra })).toEqual({
        status: 200,
        body: { expectedEpoch: 1 },
      });
  });
});

describe('claim DTO', () => {
  it('marks the claim as mine only for the user that holds it', () => {
    const state = { owner: 'u1', epoch: 3, expiresAt: at };
    expect(claimDto(state, false, 'u1')).toEqual({
      owner: 'u1',
      epoch: 3,
      expiresAt: '2026-11-15T06:00:00.000Z',
      expired: false,
      mine: true,
    });
    expect(claimDto(state, false, 'u2').mine).toBe(false);
    expect(claimDto({ owner: null, epoch: 4, expiresAt: null }, false, 'u1')).toMatchObject({
      owner: null,
      expiresAt: null,
      mine: false,
    });
  });

  it('counts a deadline equal to the clock as passed and no deadline as not expired', () => {
    const state = { owner: 'u1', epoch: 1, expiresAt: at };
    expect(claimExpired(state, at.getTime() - 1)).toBe(false);
    expect(claimExpired(state, at.getTime())).toBe(true);
    expect(claimExpired({ owner: null, epoch: 1, expiresAt: null }, at.getTime())).toBe(false);
  });
});

describe('claim refusal mapping', () => {
  it('maps a bad argument to 400 and a missing issue to 404', () => {
    expect(claimRefusalError(refusal('invalid-argument')).status).toBe(400);
    const missing = claimRefusalError(refusal('missing-row'));
    expect([missing.status, missing.message]).toEqual([404, 'Issue not found']);
  });

  it('maps every other refusal to 409 with a claim- code', () => {
    const codes: ClaimRefusalCode[] = [
      'stale-epoch',
      'live-other-owner',
      'not-claimed',
      'not-expired',
      'expired-lease',
      'wrong-owner',
    ];
    for (const code of codes) {
      const error = claimRefusalError(refusal(code));
      expect([error.status, error.code, error.message]).toEqual([
        409,
        `claim-${code}`,
        `refused: ${code}`,
      ]);
    }
  });
});

// The work-item answer a claim gives (sentinel-prod-8429). The table and the pins are the caller's own: this suite supplies the
// config the reader would have read from the manifest, so nothing here touches a database or a skill file.
const PIN = { path: '/srv/skills/law-library.md', sha256: 'b'.repeat(64) };
const PINS = {
  templates: PIN,
  law_library: PIN,
  pleading: PIN,
  headnote_authoring: PIN,
  jurisprudence: PIN,
};
const TABLE: TrackerWorkItemSkills = {
  headnotes: ['headnote_authoring', 'law_library', 'jurisprudence'],
  'law-library': ['law_library'],
  law_library: ['law_library'],
  template: ['templates', 'pleading', 'law_library'],
  templates: ['templates', 'pleading', 'law_library'],
  pleading: ['templates', 'pleading', 'law_library'],
  'legal-template': ['templates', 'pleading', 'law_library'],
  'legal-form': ['templates', 'pleading', 'law_library'],
};
const noneLive = () => false;

// A stand-in for the transaction a claim runs on, carrying the rule that made the Office delta a RETURN: a statement the
// server rejects does not only reject itself, it puts the whole Postgres transaction into failed state, and every statement
// after it answers 25P02 until the transaction ends. A savepoint is the only way back to a usable transaction, so this
// stand-in opens one, rolls back to it when a statement inside fails, and leaves the statements that carry the claim runnable.
interface ClaimTransactionStandIn {
  state: { failed: boolean; savepoints: number; statements: string[]; committed: boolean };
  statement: (name: string) => void;
  commit: () => void;
  executor: {
    statement: (name: string) => void;
    transaction: (
      run: (sp: { statement: (name: string) => void }) => Promise<unknown>,
    ) => Promise<unknown>;
  };
}

function claimTransactionStandIn(): ClaimTransactionStandIn {
  const state = { failed: false, savepoints: 0, statements: [] as string[], committed: false };
  const refused = (code: string, message: string) => Object.assign(new Error(message), { code });
  const statement = (name: string) => {
    if (state.failed)
      throw refused(
        '25P02',
        'current transaction is aborted, commands ignored until end of transaction block',
      );
    if (name === 'read a table the server does not have') {
      state.failed = true;
      throw refused('42P01', 'relation "tracker_skill_receipt" does not exist');
    }
    state.statements.push(name);
  };
  return {
    state,
    statement,
    commit: () => {
      if (state.failed) throw refused('25P02', 'current transaction is aborted');
      state.statements.push('commit the claim');
      state.committed = true;
    },
    executor: {
      statement,
      transaction: async (run) => {
        if (state.failed)
          throw refused(
            '25P02',
            'current transaction is aborted, commands ignored until end of transaction block',
          );
        state.savepoints += 1;
        try {
          const answer = await run({ statement });
          state.statements.push('release savepoint');
          return answer;
        } catch (error) {
          state.statements.push('rollback to savepoint');
          state.failed = false; // ROLLBACK TO SAVEPOINT: the caller's transaction is usable again
          throw error;
        }
      },
    },
  };
}

describe('claim work-item skills', () => {
  it('names each skill the card asks for, with the pinned path and the route that records it', () => {
    const answer = claimSkillPrompts({
      actorKind: 'agent',
      labels: ['headnotes'],
      pins: PINS,
      workItemSkills: TABLE,
      isLive: noneLive,
    });
    expect(answer.map((row) => row.skill)).toEqual([
      'law_library',
      'headnote_authoring',
      'jurisprudence',
    ]);
    expect(answer.map((row) => row.path)).toEqual([PIN.path, PIN.path, PIN.path]);
    expect(answer.map((row) => row.sha256)).toEqual([PIN.sha256, PIN.sha256, PIN.sha256]);
    expect(answer.map((row) => row.loadCommand)).toEqual([
      'GET /tracker/skills/law_library',
      'GET /tracker/skills/headnote_authoring',
      'GET /tracker/skills/jurisprudence',
    ]);
  });

  it('says nothing to a person holding her own card, and something to an agent and a system write', () => {
    const card = { labels: ['headnotes'], pins: PINS, workItemSkills: TABLE, isLive: noneLive };
    // The same card, the same labels, the same pins: only the actor behind the claim differs.
    expect(claimSkillPrompts({ actorKind: 'human', ...card })).toEqual([]);
    expect(claimSkillPrompts({ actorKind: 'agent', ...card }).length).toBe(3);
    expect(claimSkillPrompts({ actorKind: 'system', ...card }).length).toBe(3);
  });

  it('asks for a template card three skills and for an unlabelled card none', () => {
    const forLabel = (labels: string[]) =>
      claimSkillPrompts({
        actorKind: 'agent',
        labels,
        pins: PINS,
        workItemSkills: TABLE,
        isLive: noneLive,
      }).map((row) => row.skill);
    expect(forLabel(['templates'])).toEqual(['templates', 'law_library', 'pleading']);
    expect(forLabel(['legal-template', 'headnotes'])).toEqual([
      'templates',
      'law_library',
      'pleading',
      'headnote_authoring',
      'jurisprudence',
    ]);
    expect(forLabel(['pii_free'])).toEqual([]);
  });

  it('does not ask again for a skill this user already holds a live receipt for', () => {
    const answer = claimSkillPrompts({
      actorKind: 'agent',
      labels: ['headnotes'],
      pins: PINS,
      workItemSkills: TABLE,
      isLive: (skill) => skill === 'law_library',
    });
    expect(answer.map((row) => row.skill)).toEqual(['headnote_authoring', 'jurisprudence']);
  });

  it('asks for nothing when a stored label names something the table object itself answers', () => {
    // Office RETURN 2026-11-15: a card's labels are free text, so one of them can be a word the table answers from
    // Object - constructor, toString, valueOf, hasOwnProperty, __proto__. Read straight off the table those are a
    // function or the prototype, which is not a row and has no includes, so the claim path threw on a card nobody was
    // asking about. A label is a row only when it is a name in the approved vocabulary, held on this table, and a list.
    const inherited = [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      'includes',
    ];
    const ask = (labels: string[], table: TrackerWorkItemSkills = TABLE) =>
      claimSkillPrompts({
        actorKind: 'agent',
        labels,
        pins: PINS,
        workItemSkills: table,
        isLive: noneLive,
      }).map((row) => row.skill);
    expect(() => ask(inherited)).not.toThrow();
    expect(ask(inherited)).toEqual([]);
    // A label the vocabulary knows whose row is not a list is no need either.
    const broken = {
      headnotes: 'law_library',
      templates: undefined,
    } as unknown as TrackerWorkItemSkills;
    expect(ask(['headnotes', 'templates'], broken)).toEqual([]);
    // An inherited row cannot ride in on a table read from JSON: only the table's own approved rows answer.
    const fromJson = JSON.parse(
      '{"__proto__": ["law_library"], "law_library": ["law_library"]}',
    ) as TrackerWorkItemSkills;
    expect(ask(['law_library'], fromJson)).toEqual(['law_library']);
    expect(ask(['__proto__'], fromJson)).toEqual([]);
  });

  it('answers a person before it reads, and answers an agent with nothing when the read fails', async () => {
    // Office RETURN 2026-11-15: the prompt was awaited inside the claim transaction after the claim had run, so a
    // failing read could roll back or refuse a claim - a claim by Misty included. The wrapper answers a person before it
    // touches the manifest or the rows, and answers any actor with an empty prompt when the read itself fails, which is
    // all a prompt is allowed to do: it is a sentence about what to read next, never a cost.
    const person = { labels: ['headnotes'], actorKind: 'human' as const, userId: 'u-1' };
    let reads = 0;
    const failingRead = async () => {
      reads += 1;
      throw new Error('the manifest read or the receipt read failed');
    };
    const quiet = claimTransactionStandIn();
    expect(await claimSkillPromptsAfterClaim(quiet.executor as never, person, failingRead)).toEqual(
      [],
    );
    expect(reads).toBe(0);
    // WHY the read still has to be reached for an agent: the wrapper answers an actor who is told something by running the
    // reader, and only a reader that was actually reached and failed proves the answer is no prompt rather than an error.
    const agent = claimTransactionStandIn();
    expect(
      await claimSkillPromptsAfterClaim(
        agent.executor as never,
        { ...person, actorKind: 'agent' as const },
        failingRead,
      ),
    ).toEqual([]);
    expect(reads).toBe(1);
    expect(agent.state.savepoints).toBe(1);
    expect(agent.state.statements).toEqual(['rollback to savepoint']);
    agent.statement('release the lease');
    agent.commit();
    expect(agent.state.committed).toBe(true);
    expect(
      await claimSkillPromptsAfterClaim(
        claimTransactionStandIn().executor as never,
        { ...person, actorKind: 'system' as const },
        async () => [
          {
            skill: 'law_library',
            path: PIN.path,
            sha256: PIN.sha256,
            loadCommand: 'GET /tracker/skills/law_library',
          },
        ],
      ),
    ).toEqual([
      {
        skill: 'law_library',
        path: PIN.path,
        sha256: PIN.sha256,
        loadCommand: 'GET /tracker/skills/law_library',
      },
    ]);
  });

  it('survives a read the server rejected in SQL, and the claim still reaches its commit', async () => {
    // Office D1 delta RETURN 2026-11-16: the first repair caught the failure in JavaScript, which is not what a rejected
    // statement does to Postgres. The read ran on the claim's own transaction, so the first rejected statement put that
    // transaction in failed state and the release and the commit that carry the claim would have answered 25P02. This control
    // runs the real wrapper against a transaction that keeps that rule, fails one read inside it, and then runs the
    // statements the claim needs afterwards.
    const box = claimTransactionStandIn();
    box.statement('claim the row');
    const prompts = await claimSkillPromptsAfterClaim(
      box.executor as never,
      { labels: ['headnotes'], actorKind: 'agent' as const, userId: 'u-1' },
      async (sp) => {
        const read = (sp as unknown as { statement: (name: string) => void }).statement;
        read('read the receipt row');
        read('read a table the server does not have');
        return [];
      },
    );
    expect(prompts).toEqual([]);
    expect(box.state.savepoints).toBe(1);
    expect(box.state.failed).toBe(false);
    expect(box.state.statements).toEqual([
      'claim the row',
      'read the receipt row',
      'rollback to savepoint',
    ]);
    // The claim was taken before the prompt was asked, so it has to survive to the end of the transaction.
    box.statement('release the lease');
    box.commit();
    expect(box.state.committed).toBe(true);
    expect(box.state.statements).toEqual([
      'claim the row',
      'read the receipt row',
      'rollback to savepoint',
      'release the lease',
      'commit the claim',
    ]);
  });
});
