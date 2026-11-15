// The per-card detail half of the bd mapper tests (split out of
// bd-mapping.test.ts, Root P0 2026-11-15: leaves under the 400-line cap,
// split by actual responsibility, no behavior change - these tests moved
// verbatim). bd-mapping.test.ts keeps the snapshot/core mapping; this leaf
// owns the two per-card contracts:
//
//   - mapBdComments: the export comment shape (text field, uuid id, author
//     token);
//   - the title contract through the REAL pinned identity owner
//     (tools/tracker_rule_identity.py): a mapped title must survive a later
//     update op, the trial unprefixed shape is refused.
//
// The card/map helpers are the same small fixtures the core file uses (test
// fixtures are duplicated per leaf, not chained through a shim module).
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mapBdComments, mapBdSource, type BdCardView } from './bd-mapping';

function card(over: Partial<BdCardView> & { id: string }): BdCardView {
  return {
    title: `card ${over.id}`,
    description: '',
    status: 'open',
    priority: null,
    assignee: null,
    issue_type: 'task',
    labels: [],
    dependencies: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    ...over,
  };
}
// Every fixture card on this board carries the trusted rig prefix, exactly the
// real shape: map() binds it, and the mapping fails without it.
const RIG = 'sentinel-prod';
const map = (cards: BdCardView[], over: { maxDepth?: number; rigPrefix?: string } = {}) =>
  mapBdSource(cards, { rigPrefix: RIG, ...over });

describe('mapBdComments', () => {
  test('the export comment shape: text field, uuid id, authorship as the bd author token', () => {
    // The measured export comment is {id, issue_id, author, text, created_at}:
    // `text` not `body`, and a real uuid id that is the stable dedupe key.
    const comments = mapBdComments('sentinel-prod-9008.1', [
      {
        id: 'a-uuid',
        issue_id: 'sentinel-prod-9008.1',
        author: 'codex_admin',
        text: 'first',
        created_at: '2026-11-03T00:00:00.000Z',
      },
      { author: null, text: 'second', created_at: null },
    ]);
    expect(comments).toEqual([
      {
        sourceId: 'sentinel-prod-9008.1:a-uuid',
        authorEmail: null,
        authorName: 'codex_admin',
        bodyMarkdown: 'first',
        createdAt: '2026-11-03T00:00:00.000Z',
        replyToSourceId: null,
      },
      // A record that omits the id keeps the index fallback - never assume the
      // export will keep printing the id.
      {
        sourceId: 'sentinel-prod-9008.1:c1',
        authorEmail: null,
        authorName: 'bd import',
        bodyMarkdown: 'second',
        createdAt: '1970-01-01T00:00:00.000Z',
        replyToSourceId: null,
      },
    ]);
  });

  test('no comments is an empty list, never a crash', () => {
    expect(mapBdComments('sentinel-prod-9008.2', undefined)).toEqual([]);
  });
});

// The title contract is judged by the REAL pinned identity owner, not a copy of
// it: tools/tracker_rule_identity.py is a pure stdlib module with a --check-op
// CLI (no I/O, no database), so the proof shells out to it directly. An imported
// card whose title lacks the token prefix can never be updated again
// (_title_matches refuses the edit), which is why the mapper prefixes.
const OWNER = '/Users/misty/sentinel/sentinel-prod/tools/tracker_rule_identity.py';
const PYTHON = '/Users/misty/sentinel/sentinel-env/bin/python';

function checkOp(op: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [OWNER, '--check-op'], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (!existsSync(OWNER)) {
      child.kill();
      return reject(new Error(`pinned identity owner missing at ${OWNER}`));
    }
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`owner exited ${code}`));
      const parsed = JSON.parse(out) as { refusal: string | null }[];
      resolve(parsed[0]?.refusal ?? null);
    });
    child.stdin.write(JSON.stringify(op));
    child.stdin.end();
  });
}

function updateOp(
  token: string,
  previousTitle: string,
  proposedTitle: string,
  prefix = 'sentinel-prod',
): Record<string, unknown> {
  const beadId = `${prefix}-${token}`;
  return {
    op: 'update',
    id: beadId,
    rig_prefix: prefix,
    title: proposedTitle,
    description: 'body',
    labels: [],
    previous_state: { title: previousTitle, description: 'body', labels: [], bead_id: beadId },
    proposed_state: { title: proposedTitle, description: 'body', labels: [], bead_id: beadId },
  };
}

describe('title contract through the real pinned identity owner', () => {
  for (const token of ['sentinel-prod-8363', 'sentinel-prod-8363.1', 'deadbeef']) {
    test(`a mapped ${token === 'sentinel-prod-8363' ? 'numeric' : token === 'sentinel-prod-8363.1' ? 'daughter' : 'hash'} title allows a later update`, async () => {
      const snap = map([card({ id: `sentinel-prod-${token}`, title: 'the card body' })]);
      const issue = snap.issues[0];
      expect(issue.title).toBe(`${token}: the card body`);
      const refusal = await checkOp(updateOp(token, issue.title, `${token}: the edited body`));
      expect(refusal).toBeNull();
    });
  }

  test('the trial shape (unprefixed title) is refused by the owner: the bug the prefix fixes', async () => {
    const refusal = await checkOp(
      updateOp('sentinel-prod-8363.1', 'the card body', 'the edited body'),
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('sentinel-prod-8363.1');
  });

  // The REAL id shape (Root 8363.1): the board's cards are <rig>-<token>.
  // The mapper derives the local token from the trusted rig prefix, and the
  // owner judges the mapped title.
  test('real prefixed id sentinel-prod-8363.1: mapped title accepted for the full bead id', async () => {
    const snap = map([card({ id: 'sentinel-prod-8363.1', title: 'the card body' })], {
      rigPrefix: 'sentinel-prod',
    });
    const issue = snap.issues[0];
    // The title carries the LOCAL token, and the full source id stays in sourceId.
    expect(issue.title).toBe('8363.1: the card body');
    expect(issue.sourceId).toBe('sentinel-prod-8363.1');
    // The owner accepts a later update on the FULL bead id with the mapped title.
    const refusal = await checkOp(updateOp('8363.1', issue.title!, '8363.1: the edited body'));
    expect(refusal).toBeNull();
    // A title prefixed with the FULL bd id is what the old mapper produced:
    // the owner refuses it, and the identity attach makes the title uneditable
    // afterwards - the exact defect this fixes.
    const fullIdTitle = await checkOp(
      updateOp('8363.1', issue.title!, 'sentinel-prod-8363.1: the edited body'),
    );
    expect(fullIdTitle).not.toBeNull();
    // The sequence root is the numeric head of the TOKEN (8363), not the 0 the
    // full id used to yield.
    expect(issue.sequenceId).toBe(8363);
  });

  test('EVERY issue keeps its EXACT source issue_type as typeSourceId: the operational kind is preserved, never defaulted (8429 R1)', () => {
    // Root native-READY ruling: an imported epic cannot become Task. The
    // machine-bound exact source name rides typeSourceId; the native
    // task/bug/feature/... -> task readiness mapping happens LATER at the
    // ready fact, never at import - the import preserves the name.
    const kinds = [
      'task',
      'bug',
      'feature',
      'chore',
      'decision',
      'spike',
      'event',
      'merge-request',
      'molecule',
      'epic',
    ];
    const cards = kinds.map((t, i) => card({ id: `sentinel-prod-9013.${i + 1}`, issue_type: t }));
    const snap = map(cards);
    for (const kind of kinds) {
      const issue = snap.issues.find((i) => i.sourceId.endsWith(`.${kinds.indexOf(kind) + 1}`))!;
      expect(issue.typeSourceId).toBe(kind);
    }
    // The epic is an issue with the exact kind 'epic' - not dropped, not
    // translated, not defaulted to task.
    expect(snap.issues.find((i) => i.typeSourceId === 'epic')).toBeDefined();
    expect(snap.issues).toHaveLength(kinds.length);
  });

  test('a real prefixed hash id maps its token, keeps sequenceId 0 with no numeric root', async () => {
    const snap = map([card({ id: 'sentinel-prod-deadbeef', title: 'a hash card' })], {
      rigPrefix: 'sentinel-prod',
    });
    const issue = snap.issues[0];
    expect(issue.title).toBe('deadbeef: a hash card');
    expect(issue.sequenceId).toBe(0);
    const refusal = await checkOp(updateOp('deadbeef', issue.title!, 'deadbeef: edited'));
    expect(refusal).toBeNull();
  });

  test('a foreign/legacy-prefix id is REFUSED by the sentinel-prod rig: never renamed (Root ruling 2026-11-15)', () => {
    // Root ruling: reject the fallback that turned b-4500 into
    // sentinel-prod-b-4500. The pinned owner's refusal is not permission to
    // rename a source ID - strict matching of the actual rig prefix only.
    expect(() =>
      map([card({ id: 'b-4500', title: 'legacy sequential id' })], {
        rigPrefix: 'sentinel-prod',
      }),
    ).toThrow('does not carry the rig prefix sentinel-prod');
  });

  test('the explicit legacy rig prefix b maps b-4500 to token 4500: same converter, no framework (Root ruling)', () => {
    // Root preserves the legacy record in a separate legacy project under its
    // OWN rig prefix b. The SAME strict path maps b-4500 to token 4500 - the
    // number, not the id: nothing invented, nothing renamed.
    const snap = map([card({ id: 'b-4500', title: 'legacy sequential id' })], {
      rigPrefix: 'b',
    });
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0]!.sourceId).toBe('b-4500');
    expect(snap.issues[0]!.title).toBe('4500: legacy sequential id');
    expect(snap.issues[0]!.sequenceId).toBe(4500);
  });

  test('a multi-hyphen rig prefix strips exactly once', async () => {
    const snap = map([card({ id: 'acme-legal-42.7', title: 'nested' })], {
      rigPrefix: 'acme-legal',
    });
    const issue = snap.issues[0];
    expect(issue.title).toBe('42.7: nested');
    expect(issue.sequenceId).toBe(42);
    const refusal = await checkOp(updateOp('42.7', issue.title!, '42.7: edited', 'acme-legal'));
    expect(refusal).toBeNull();
  });
});
