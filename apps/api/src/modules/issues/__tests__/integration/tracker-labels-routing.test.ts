// Lane routing on the gated label writer for a card nobody holds: every real label change carries
// routing facts built from the stored title and description, so a lane the text names is judged.
// DATABASE HELD: the fixtures refuse before any client exists without Root's grant flag.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import { tempManifest } from '#tests/helpers/temp-manifest';
import * as F from './tracker-labels-gate-fixtures';

afterEach(async () => {
  await F.cleanUp();
});

// The composed pins plus a synthetic routing section in a test-owned temp file. qwen2 is local
// here for the test only; it states nothing about the real lane. The copy is removed at process exit.
const ROUTED_MANIFEST = tempManifest('tracker-labels-routing-', {
  ...JSON.parse(readFileSync(F.OWNER_CONFIG, 'utf8')),
  routing: { lanes: { qwen2: { execution: 'local' } } },
}).path;
const withRoutedOwner = <T>(run: () => Promise<T>) =>
  F.withGateEnv([F.OWNER.python, F.OWNER.owner, ROUTED_MANIFEST], run);

const NAMED = 'Stored note for @qwen2.';
const LL_BLOCK = [
  'LAW LIBRARY COMPLIANCE:',
  "(a) SOURCES ARE SETTLED: Misty's source ruling for this card, pasted verbatim.",
  '(b) text source, comment source, act window all verified for the code touched.',
  '(c) no comment rows touched.',
  '(d) byte copy, never retyped.',
].join('\n');
const swap = (f: F.GateFacts, issueId: number) =>
  withRoutedOwner(() => F.setIssueLabels(f.projectId, issueId, [f.large], f.actorId, false));

describe('8364 gated label writer, unheld card routing', () => {
  it('allows a label change on an unheld card whose text names a listed lane with an agent', async () => {
    const f = await F.fixture(true, 'named-ok');
    const card = await F.gatedCard(f, 'Named lane');
    await F.laneAgent(f, 'qwen2');
    await F.storeDescription(card.issueId, NAMED);
    await swap(f, card.issueId);
    expect(await F.linksOf(card.issueId)).toEqual([{ labelId: f.large, name: F.SIZE_LARGE }]);
  }, 120_000);

  it('refuses a label change on an unheld card whose text names a lane no agent stands behind', async () => {
    const f = await F.fixture(true, 'named-none');
    const card = await F.gatedCard(f, 'Unresolved lane');
    await F.storeDescription(card.issueId, NAMED);
    const before = await F.board(f);
    const refusal = await F.refusalOf(() => swap(f, card.issueId));
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toStartWith('lane-routing:');
    expect(refusal.message).toContain('routing_facts.targets is empty');
    expect(await F.linksOf(card.issueId)).toEqual([{ labelId: f.small, name: F.SIZE_SMALL }]);
    expect((await F.board(f)).activity).toBe(before.activity);
  }, 120_000);

  it('refuses a move into law-library for a named Qwen lane, through the label writer', async () => {
    const f = await F.fixture(true, 'named-law');
    const card = await F.gatedCard(f, 'Law move');
    await F.laneAgent(f, 'qwen2');
    // A valid compliance block, so the law-library rule passes and the lane rule is the one that
    // answers. tracker_routing_facts.test.ts measures that order on the same op shape.
    await F.storeDescription(card.issueId, `${LL_BLOCK}\n${NAMED}`);
    const before = await F.board(f);
    const refusal = await F.refusalOf(() =>
      withRoutedOwner(() =>
        F.setIssueLabels(f.projectId, card.issueId, [f.small, f.law], f.actorId, false),
      ),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toStartWith('lane-routing:');
    expect(refusal.message).toContain(
      "lane 'qwen2' is refused on law-library or legal-template work",
    );
    expect(await F.linksOf(card.issueId)).toEqual([{ labelId: f.small, name: F.SIZE_SMALL }]);
    expect((await F.board(f)).activity).toBe(before.activity);
  }, 120_000);

  it('refuses a label change whose named lane the manifest does not list', async () => {
    const f = await F.fixture(true, 'named-unlisted');
    const card = await F.gatedCard(f, 'Unlisted lane');
    await F.laneAgent(f, 'qwen2');
    await F.storeDescription(card.issueId, NAMED);
    // The shared CONFIG has no routing section, so qwen2 has no execution entry.
    const refusal = await F.refusalOf(() =>
      F.withOwner(() => F.setIssueLabels(f.projectId, card.issueId, [f.large], f.actorId, false)),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'lane-unrouted']);
    expect(refusal.message).toContain('lane qwen2 has no execution entry');
    expect(await F.linksOf(card.issueId)).toEqual([{ labelId: f.small, name: F.SIZE_SMALL }]);
  }, 120_000);
});
