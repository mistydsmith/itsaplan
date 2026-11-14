// The gate on the direct label writer (8364 U4): a gated project's labels may change only through the gate, the ordinary branch is held by the project
// row, and a routed card stays refused until an authenticated routing seam exists. Source only for now: every call is internal, there is no HTTP endpoint
// or browser test, and nothing here runs until Root's serial DB GO sets the grant. A4 owns the whole create path, so the cards below come from createIssue
// on a gated project and from plain SQL on an ordinary one; nothing simulates a card by bypassing a gate it is testing.
// A write case always asks for a change the owner allows: the stored size-small out and size-large in. A request that drops the only size or adds a second
// one belongs to a refusal case. A refusal case asks for the same valid request, so the rule that answers is the rule under test - size, routing, Law
// Library, ledger, the gate's config rule or the ordinary branch's fence - and each case names that rule while the card staying intact is proved by untouched.
// Root's mutation expectations, recorded so a later pass cannot quietly drop them:
// (A) remove the gate call from a gated label change: 'refuses the size label that is no longer there', 'refuses a second size label', the stored-state
//     case, both routed cases, the no-ledger-row case, 'refuses a gated label write that arrives through a supplied executor' and both bulk refusals fail.
// (B) remove the FOR SHARE read the ordinary branch takes first: both race cases fail and only those.
import { afterEach, describe, expect, it } from 'bun:test';
import * as F from './tracker-labels-gate-fixtures';

afterEach(async () => {
  await F.cleanUp();
});

const stored = (f: F.GateFacts) => [{ labelId: f.small, name: F.SIZE_SMALL }];
const swapped = (f: F.GateFacts) => [{ labelId: f.large, name: F.SIZE_LARGE }];
// The one case that adds a label instead of swapping one asserts its own shape: two links, one add row, one more label row on the board.
const plusPlain = (f: F.GateFacts) => [
  { labelId: f.plain, name: F.PLAIN_LABEL },
  { labelId: f.small, name: F.SIZE_SMALL },
];

// The change a successful size swap must make: the size-large link in place of size-small, one add row and one remove row naming each label as it was, the
// same number of label rows, the card's own stamp moved, one delivery when the write asked for one, and nothing else on the board moved.
async function swappedIn(f: F.GateFacts, issueId: number, before: F.Board, events: boolean) {
  expect(await F.linksOf(issueId)).toEqual(swapped(f));
  const acts = await F.activityOf(issueId);
  expect(acts.map((entry) => entry.action).slice(-2)).toEqual(['label_add', 'label_remove']);
  expect(acts[acts.length - 2]).toEqual({ action: 'label_add', from: null, to: F.SIZE_LARGE });
  expect(acts[acts.length - 1]).toEqual({ action: 'label_remove', from: F.SIZE_SMALL, to: null });
  const deliveries = await F.deliveriesOf(f.projectId);
  if (!events) expect(deliveries).toEqual([]);
  else {
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]).toEqual({
      webhookId: f.hookId,
      event: 'issue.label_changed',
      added: [{ id: f.large, name: F.SIZE_LARGE }],
      removed: [{ id: f.small, name: F.SIZE_SMALL }],
    });
  }
  const after = await F.board(f);
  expect(after.labels).toBe(before.labels);
  expect(after.activity).toBe(before.activity + 2);
  expect(after.issues).toBe(before.issues);
  expect(after.runs).toBe(0);
  expect(after.webhooks).toBe(1);
  expect(after.deliveries).toBe(events ? 1 : 0);
  expect(after.updatedAt).not.toBe(before.updatedAt);
  expect(after.updatedAt).not.toBeNull();
  return after;
}
// A single add on an ordinary card: one new link, one add row, one more label row, one delivery.
async function addedOne(f: F.GateFacts, issueId: number, before: F.Board) {
  expect(await F.linksOf(issueId)).toEqual(plusPlain(f));
  const acts = await F.activityOf(issueId);
  expect(acts.map((entry) => entry.action)).toEqual(['label_add']);
  expect(acts[0]).toEqual({ action: 'label_add', from: null, to: F.PLAIN_LABEL });
  expect((await F.deliveriesOf(f.projectId)).length).toBe(1);
  const after = await F.board(f);
  expect(after.labels).toBe(before.labels + 1);
  expect(after.activity).toBe(before.activity + 1);
  expect(after.updatedAt).not.toBe(before.updatedAt);
  return after;
}
// The proof of a refusal: nothing moved anywhere a label change could have moved it, and every card still holds exactly the labels it held before.
async function untouched(f: F.GateFacts, cards: F.Card[], links: F.Link[], before: F.Board) {
  const after = await F.board(f);
  const counters = ['seq', 'root', 'issues', 'identities', 'labels', 'activity'] as const;
  const others = ['deliveries', 'notifications', 'runs', 'webhooks'] as const;
  for (const key of [...counters, ...others]) expect(after[key]).toBe(before[key]);
  expect(after.updatedAt).toBe(before.updatedAt);
  for (const card of cards) expect(await F.linksOf(card.issueId)).toEqual(links);
}
type ConfigRun = <T>(run: () => Promise<T>) => Promise<T>;
async function gatedPair(f: F.GateFacts, tag: string) {
  return [await F.gatedCard(f, `${tag} minted`), await F.gatedCard(f, `${tag} second`)];
}

describe('8364 U4 gated label writer', () => {
  it('replaces the labels on a gated card and keeps the identity, the card and the delivery', async () => {
    const f = await F.fixture(true, 'allow');
    const rigBefore = await F.board(f);
    const ledgerBefore = await F.ledgerOf(F.RIG_PREFIX);
    const card = await F.gatedCard(f, 'Labelled work');
    const before = await F.board(f);
    // The identity the owner reads is the one the server adapter minted: <rig prefix>-<local token>, with the title opening on the local token. Counters
    // and ledger are compared against the baseline this case started from, because the shared rig accumulates across cases.
    const bead = card.beadId ?? '';
    expect(bead).toStartWith(`${F.RIG_PREFIX}-`);
    expect(card.title).toStartWith(bead.slice(F.RIG_PREFIX.length + 1));
    expect(before.identities).toBe(rigBefore.identities + 1);
    expect(before.root).toBeGreaterThan(rigBefore.root);
    const ledger = await F.ledgerOf(F.RIG_PREFIX);
    expect(ledger.length).toBe(ledgerBefore.length + 1);
    expect(ledger.map((entry) => entry.issue_id)).toContain(card.issueId);
    expect(await F.linksOf(card.issueId)).toEqual(stored(f));

    await F.withOwner(() =>
      F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true),
    );

    const after = await swappedIn(f, card.issueId, before, true);
    expect(after.seq).toBe(before.seq);
    expect(after.identities).toBe(before.identities);
    expect(after.root).toBe(before.root);
    expect(await F.ledgerOf(F.RIG_PREFIX)).toHaveLength(ledger.length);
    expect(await F.rigOf(f.projectId)).toBe(f.rigId);
  });
  it('writes the same change silently when emitEvent is false', async () => {
    const f = await F.fixture(true, 'silent');
    const card = await F.gatedCard(f, 'Silent labels');
    const before = await F.board(f);
    expect(before.deliveries).toBe(0);
    await F.withOwner(() =>
      F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, false),
    );
    await swappedIn(f, card.issueId, before, false);
  });
  it('refuses the size label that is no longer there and writes nothing', async () => {
    const f = await F.fixture(true, 'no-size');
    const cards = await gatedPair(f, 'Size dropped');
    const before = await F.board(f);
    for (const card of cards) {
      const refusal = await F.refusalOf(() =>
        F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.plain], f.actorId, true)),
      );
      expect(refusal.status).toBe(409);
      expect(refusal.message).toStartWith('size:');
      expect(refusal.message).toContain('exactly one canonical size label');
    }
    await untouched(f, cards, stored(f), before);
  });
  it('refuses a second size label and writes nothing', async () => {
    const f = await F.fixture(true, 'two-sizes');
    const cards = await gatedPair(f, 'Two sizes');
    const before = await F.board(f);
    for (const card of cards) {
      const refusal = await F.refusalOf(() =>
        F.withOwner(() =>
          F.setIssueLabels(f.projectId, card.issueId, [f.small, f.large, f.plain], f.actorId, true),
        ),
      );
      expect(refusal.status).toBe(409);
      expect(refusal.message).toStartWith('size:');
      expect(refusal.message).toContain('more than one canonical size label');
    }
    await untouched(f, cards, stored(f), before);
  });
  it('refuses on what the card already stores, with the same requested ids on both cards', async () => {
    const f = await F.fixture(true, 'stored');
    const plain = await F.gatedCard(f, 'Stored one size');
    const lawStored = await F.gatedCard(f, 'Stored second');
    await F.storeLabel(lawStored.issueId, f.law);
    const before = await F.board(f);
    const lawLinks = [
      { labelId: f.law, name: F.LAW_LABEL },
      { labelId: f.small, name: F.SIZE_SMALL },
    ];
    expect(await F.linksOf(plain.issueId)).toEqual(stored(f));
    expect(await F.linksOf(lawStored.issueId)).toEqual(lawLinks);
    // The identical request on two cards: the card that stores only a size takes it, the card that stores a Law Library label does not. The refusal comes
    // from what the card already holds, not from what the call asked for.
    await F.withOwner(() =>
      F.setIssueLabels(f.projectId, plain.issueId, [f.large], f.actorId, true),
    );
    expect(await F.linksOf(plain.issueId)).toEqual(swapped(f));
    const refusal = await F.refusalOf(() =>
      F.withOwner(() =>
        F.setIssueLabels(f.projectId, lawStored.issueId, [f.large], f.actorId, true),
      ),
    );
    expect(refusal.status).toBe(409);
    expect(refusal.message).toStartWith('law-library-compliance:');
    expect(refusal.message).toContain('Law Library');
    expect(await F.linksOf(lawStored.issueId)).toEqual(lawLinks);
    const after = await F.board(f);
    expect(after.labels).toBe(before.labels);
    expect(after.activity).toBe(before.activity + 2);
    expect(after.deliveries).toBe(1);
    expect(await F.rigOf(f.projectId)).toBe(f.rigId);
  });
  it('allows the same labels resent in a different order on a held card', async () => {
    const f = await F.fixture(true, 'reorder');
    const card = await F.gatedCard(f, 'Reordered labels');
    // First the second label is added through the gate on a card nobody holds, so the card genuinely stores both.
    await F.withOwner(() =>
      F.setIssueLabels(f.projectId, card.issueId, [f.plain, f.small], f.actorId, false),
    );
    await F.assign(card.issueId, f.actorId);
    const held = await F.linksOf(card.issueId);
    expect(held).toEqual(plusPlain(f));
    const mid = await F.board(f);
    // The same two ids, in the opposite order, on a card somebody holds. Nothing moved, so no routing judgement is owed and none is refused.
    await F.withOwner(() =>
      F.setIssueLabels(f.projectId, card.issueId, [f.small, f.plain], f.actorId, true),
    );
    await untouched(f, [card], plusPlain(f), mid);
    expect(await F.deliveriesOf(f.projectId)).toEqual([]);
  });
  it('refuses a routed card and keeps its stored size label', async () => {
    const f = await F.fixture(true, 'routed');
    const cards = await gatedPair(f, 'Assigned work');
    const before = await F.board(f);
    for (const card of cards) {
      await F.assign(card.issueId, f.actorId);
      const refusal = await F.refusalOf(() =>
        F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true)),
      );
      expect(refusal.status).toBe(409);
      expect(refusal.message).toStartWith('lane-routing:');
      expect(refusal.message).toContain('routing_facts');
    }
    await untouched(f, cards, stored(f), before);
  });
  it('refuses a gated label write on a card that has no ledger row for the locked rig', async () => {
    const f = await F.fixture(false, 'no-ledger');
    const card = await F.ordinaryCard(f, 'Activated without a ledger row', 1);
    const rig = await F.sharedRig();
    await F.activateRig(f, rig);
    const before = await F.board(f);
    const ledger = await F.ledgerOf(F.RIG_PREFIX);
    const mine = ledger.filter((entry) => entry.issue_id === card.issueId);
    expect(mine).toEqual([]);
    const refusal = await F.refusalOf(() =>
      F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true)),
    );
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('issue-without-identity');
    expect(refusal.message).toContain('no ledger identity for this rig');
    // The writer's own refusal, before the rule owner is consulted: a foreign or missing id is never handed to the owner.
    expect(refusal.message).not.toContain('canonical size label');
    await untouched(f, [card], stored(f), before);
    await F.resetRig(f);
  });
  it('refuses a gated bulk label add with both configs and still serves an ordinary project', async () => {
    const f = await F.fixture(true, 'bulk-gated');
    const cards = await gatedPair(f, 'Gated bulk');
    const before = await F.board(f);
    for (const run of [F.withOwner, F.withNoConfig]) {
      const refusal = await F.refusalOf(() =>
        run(() =>
          F.bulkAddLabels(
            f.projectId,
            cards.map((card) => card.issueId),
            [f.large],
            f.actorId,
          ),
        ),
      );
      expect(refusal.status).toBe(409);
      // A gated bulk change is disabled as a whole before any member is read or judged, so the wording is the writer's own on either config.
      expect(refusal.message).toContain('Bulk label changes are not available on a gated project');
      expect(refusal.message).not.toContain('canonical size label');
    }
    await untouched(f, cards, stored(f), before);

    const o = await F.fixture(false, 'bulk-ordinary');
    const control = await F.ordinaryCard(o, 'Ordinary bulk', 1);
    const beforeControl = await F.board(o);
    await F.withOwner(() => F.bulkAddLabels(o.projectId, [control.issueId], [o.plain], o.actorId));
    await addedOne(o, control.issueId, beforeControl);
    expect((await F.board(o)).root).toBe(0);
  });
  it('refuses every gated label write when the manifest config is missing or empty', async () => {
    const f = await F.fixture(true, 'manifest');
    const cards = await gatedPair(f, 'Manifest missing');
    const before = await F.board(f);
    const configs: [ConfigRun, string][] = [
      [F.withBrokenConfig, 'manifest'],
      [F.withNoConfig, 'a gated project needs'],
    ];
    for (const [run, wording] of configs) {
      for (const card of cards) {
        const refusal = await F.refusalOf(() =>
          run(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true)),
        );
        expect(refusal.status).toBe(409);
        // A gated write with no usable manifest never reaches the rule owner, so no rule wording can appear in the refusal.
        expect(refusal.message).toContain(wording);
        expect(refusal.message).not.toContain('canonical size label');
      }
    }
    await untouched(f, cards, stored(f), before);
  });
  it('writes and notifies on an ordinary project with the same broken manifest that blocks a gated one', async () => {
    const f = await F.fixture(false, 'ordinary');
    const card = await F.ordinaryCard(f, 'Ordinary labels', 1);
    const before = await F.board(f);
    expect(card.beadId).toBeNull();
    expect(before.root).toBe(0);
    expect(before.identities).toBe(0);
    await F.withBrokenConfig(() =>
      F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true),
    );
    const after = await swappedIn(f, card.issueId, before, true);
    expect(after.root).toBe(0);
    expect(after.identities).toBe(0);
    expect(after.seq).toBe(before.seq);
  });
  it('refuses a gated label write that arrives through a supplied executor', async () => {
    const f = await F.fixture(true, 'executor');
    const size = await F.gatedCard(f, 'Injected size refusal');
    const routed = await F.gatedCard(f, 'Injected routing refusal');
    await F.assign(routed.issueId, f.actorId);
    const before = await F.board(f);
    const calls: [F.Card, number[], string][] = [
      [size, [f.plain], 'canonical size label'],
      [routed, [f.large], 'lane-routing'],
    ];
    for (const [card, labelIds, wording] of calls) {
      const refusal = await F.db.transaction(async (tx) => {
        try {
          await F.withOwner(() =>
            F.setIssueLabels(f.projectId, card.issueId, labelIds, f.actorId, true, tx),
          );
        } catch (error) {
          return error as F.Refusal;
        }
        throw new Error(
          `a gated label write went through on a supplied executor it should have refused: ${card.issueId}`,
        );
      });
      expect(refusal.status).toBe(409);
      expect(refusal.message).toContain(wording);
    }
    await untouched(f, [size, routed], stored(f), before);
  });
  it('refuses the label change whose activation commits first, with a backend proven to be waiting', async () => {
    const f = await F.fixture(false, 'race-commit');
    const card = await F.ordinaryCard(f, 'Activation race', 1);
    const rig = await F.sharedRig();
    const before = await F.board(f);
    const outcome = await F.activationRace(f.projectId, rig, 'commit', () =>
      F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true)),
    ).finally(() => F.resetRig(f));
    expect(outcome.waiting).toBeGreaterThan(0);
    expect(outcome.blockedByOther).toBeGreaterThan(0);
    expect(outcome.saved).toBe(false);
    expect(outcome.refusal?.status).toBe(409);
    // The ordinary branch's own fence: the save saw the rig the activation committed first and wrote nothing. No rule owner is consulted on this branch, and
    // this fixture mints no identity, so the rig and ledger counts stay where the ordinary fixture left them.
    expect(outcome.refusal?.message).toContain('changed its rig while the labels were being saved');
    expect(outcome.refusal?.message).not.toContain('canonical size label');
    await untouched(f, [card], stored(f), before);
    expect(await F.rigOf(f.projectId)).toBeNull();
    expect((await F.activityOf(card.issueId)).length).toBe(0);
    expect((await F.board(f)).root).toBe(0);
    expect((await F.board(f)).identities).toBe(0);
  });
  it('writes the label change normally when that activation is rolled back', async () => {
    const f = await F.fixture(false, 'race-rollback');
    const card = await F.ordinaryCard(f, 'Rolled back activation', 1);
    const rig = await F.sharedRig();
    const before = await F.board(f);
    const outcome = await F.activationRace(f.projectId, rig, 'rollback', () =>
      F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, true)),
    );
    expect(outcome.waiting).toBeGreaterThan(0);
    expect(outcome.blockedByOther).toBeGreaterThan(0);
    expect(outcome.saved).toBe(true);
    expect(outcome.refusal).toBeUndefined();
    const after = await swappedIn(f, card.issueId, before, true);
    expect(after.root).toBe(0);
    expect(after.identities).toBe(0);
  });
  it('leaves no test data and no ledger row with an issue still attached', async () => {
    // Nothing is created here: every fixture this run made has already been cleaned by the afterEach that follows each case, so the residue is read from
    // the immutable inventory of ids the run created, not from a queue cleanup has already drained.
    await F.cleanUp();
    expect(F.cleanupErrors).toEqual([]);
    const left = await F.residue();
    expect(Object.values(left).every((count) => typeof count === 'number')).toBe(true);
    // Only the synthetic rig remains, which the schema forbids deleting. Every issue, label, webhook, column, team, workspace, project and user this run
    // made is gone, and every ledger row it made is a tombstone: still there, with no issue attached.
    expect(left).toEqual({
      project: 0,
      label: 0,
      webhook: 0,
      column: 0,
      team: 0,
      workspace: 0,
      issue: 0,
      rig: 1,
      user: 0,
    });
    const ledger = await F.ledgerOf(F.RIG_PREFIX);
    const tombstones = ledger.filter((entry) => entry.issue_id === null);
    expect(ledger.length).toBeGreaterThan(0);
    expect(tombstones.length).toBe(ledger.length);
  });
});
