// scripts/landing-evidence.test.ts — sentinel-prod-8429 auto-lander unit 1 (R3).
// NO DB and NO PRELOAD: the module imports nothing and this file imports only bun:test and it. Run with
//   env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" bun test ./landing-evidence.test.ts
// WHY: R1 and R2 were returned for ten fail-open holes, so every one of them is a regression block here.

import { describe, expect, it } from 'bun:test';

import {
  dedupeEvidence,
  evaluateBundle,
  evaluateLanding,
  latestVerdict,
  normaliseIdentity,
  parseReceipt,
  parseSubject,
  parseVerdict,
  type LandingOutcome,
  type LandingReceipt,
  type ReviewVerdict,
} from './landing-evidence';

const CANDIDATE = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333';
const KEY = 'sentinel-prod-8429.3';
const ITEM = { itemKey: KEY, status: 'in_progress' };
const SUBJECT = `${KEY}: land the evidence core`;
const PARTIAL = `${KEY} (partial): land the evidence core`;
const TEST_NAME = 'scripts/landing-evidence.test.ts';

const outcomes = (over: Partial<LandingOutcome> = {}): LandingOutcome[] => [
  { name: TEST_NAME, passed: 19, failed: 0, ...over },
];

function receipt(over: Partial<LandingReceipt> = {}): LandingReceipt {
  return {
    id: 'ev-receipt-1',
    itemKey: KEY,
    candidateSha: CANDIDATE,
    baseSha: BASE,
    author: 'dsh',
    allowedPaths: ['scripts/landing-evidence.ts'],
    namedTests: [TEST_NAME],
    outcomes: outcomes(),
    ...over,
  };
}

function verdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    id: 'ev-verdict-1',
    reviewer: 'claude_today',
    sha: CANDIDATE,
    decision: 'PASS',
    sequence: 1,
    ...over,
  };
}

/** One-line decision helper so each regression asserts a code rather than restating the shape. */
function decide(over: {
  receipt?: unknown;
  verdicts?: readonly unknown[];
  subject?: unknown;
  item?: { itemKey: string; status?: string; archived?: boolean };
}) {
  return evaluateLanding({
    item: over.item ?? ITEM,
    receipt: over.receipt ?? receipt(),
    verdicts: over.verdicts ?? [verdict()],
    subject: over.subject ?? SUBJECT,
  });
}

describe('the permitted path still permits', () => {
  it('accepts one valid receipt and one independent PASS on the same full SHA', () => {
    expect(decide({}).eligible).toBe(true);
    expect(decide({}).partial).toBe(false);
  });

  it('accepts a receipt carrying both candidate and base as distinct fields', () => {
    expect(typeof parseReceipt({ ...receipt(), id: undefined })).toBe('object');
  });
});

describe('hole 1 — the subject key must match the item and the receipt exactly', () => {
  it('refuses a subject naming a different item than the receipt', () => {
    const decision = decide({
      subject: 'sentinel-prod-9999: land something else',
    });
    expect(decision.code).toBe('SUBJECT_KEY_MISMATCH');
    expect(decision.reason).toContain('sentinel-prod-9999');
  });

  it('refuses when the item and the receipt disagree', () => {
    expect(
      decide({
        item: { itemKey: 'sentinel-prod-9999' },
        subject: 'sentinel-prod-9999: x',
      }).code,
    ).toBe('ITEM_KEY_MISSING');
  });

  it('refuses a prefix key, a missing separator, and a partial marker in prose', () => {
    expect(decide({ subject: 'sentinel-prod-8429junk: text' }).code).toBe('SUBJECT_KEY_MISMATCH');
    expect(parseSubject('sentinel-prod-8429: text')).toEqual({
      itemKey: 'sentinel-prod-8429',
      partial: false,
    });
    for (const bad of [`${KEY} land the core`, KEY, '', '   ', undefined])
      expect(parseSubject(bad)).toBe('SUBJECT_MALFORMED');
    expect(parseSubject(`${KEY}: a partial repair (partial):`)).toBe('SUBJECT_MALFORMED');
    expect(parseSubject(PARTIAL)).toEqual({ itemKey: KEY, partial: true });
  });
});

describe('imported ledger identity compatibility', () => {
  it('accepts verbatim imported keys while still comparing the whole stored key', () => {
    for (const key of ['sentinel-prod-bpudl11', 'rig-hash.1.2', 'rig-legacy:token']) {
      expect(
        decide({
          item: { itemKey: key },
          receipt: receipt({ itemKey: key }),
          subject: `${key}: land imported work`,
        }).eligible,
      ).toBe(true);
      expect(
        decide({
          item: { itemKey: key },
          receipt: receipt({ itemKey: key }),
          subject: `${key} (partial): land imported work`,
        }).partial,
      ).toBe(true);
    }
  });
});

describe('hole 2 — required fields must be present, non-empty and well formed', () => {
  const bare = { ...receipt(), id: undefined };
  it('refuses empty, missing or malformed path, test and outcome fields', () => {
    for (const bad of [
      { ...bare, allowedPaths: [] },
      { ...bare, allowedPaths: ['  '] },
      { ...bare, allowedPaths: [1] },
      { ...bare, namedTests: [] },
      { ...bare, namedTests: [''] },
      { ...bare, outcomes: [] },
      { ...bare, outcomes: undefined },
      { ...bare, outcomes: [{ name: '', passed: 1, failed: 0 }] },
      { ...bare, outcomes: [{ name: 'a', passed: -1, failed: 0 }] },
      { ...bare, outcomes: [{ name: 'a', passed: 1.5, failed: 0 }] },
    ])
      expect(parseReceipt(bad)).toBe('RECEIPT_FIELDS_MISSING');
  });

  it('refuses a failed named test, and a blank author', () => {
    expect(decide({ receipt: receipt({ outcomes: outcomes({ failed: 2 }) }) }).code).toBe(
      'NAMED_TEST_FAILED',
    );
    expect(parseReceipt({ ...bare, author: '   ' })).toBe('IDENTITY_MISSING');
  });
});

describe('hole 3 — a reused id with different content is a conflict, never first-wins', () => {
  it('refuses, while identical repeats still collapse', () => {
    expect(
      decide({
        verdicts: [verdict(), verdict({ decision: 'RETURN', sequence: 2 })],
      }).code,
    ).toBe('EVIDENCE_ID_CONFLICT');
    const { rows, conflict } = dedupeEvidence([verdict(), verdict()]);
    expect(conflict).toBe(false);
    expect(rows.length).toBe(1);
  });
});

describe('hole 4 — invalid newest evidence refuses instead of resurrecting an older PASS', () => {
  it('refuses a bogus decision even though a valid PASS exists', () => {
    const bogus = {
      id: 'ev-verdict-2',
      reviewer: 'claude_today',
      sha: CANDIDATE,
      decision: 'BOGUS',
      sequence: 2,
    };
    expect(decide({ verdicts: [verdict(), bogus] }).code).toBe('VERDICT_INVALID');
  });

  it('refuses a non-integer sequence and a tie on the newest', () => {
    expect(parseVerdict({ reviewer: 'r', sha: CANDIDATE, decision: 'PASS', sequence: 'two' })).toBe(
      'VERDICT_SEQUENCE_INVALID',
    );
    expect(parseVerdict({ reviewer: 'r', sha: CANDIDATE, decision: 'PASS', sequence: 1.5 })).toBe(
      'VERDICT_SEQUENCE_INVALID',
    );
    const tie = [
      verdict({ sequence: 2 }),
      verdict({ id: 'ev-2', decision: 'RETURN', sequence: 2 }),
    ];
    expect(decide({ verdicts: tie }).code).toBe('VERDICT_SEQUENCE_TIE');
  });

  it('refuses a missing sequence instead of ranking a later RETURN below an explicit PASS', () => {
    const missingSequence = {
      ...verdict({ id: 'unsequenced', decision: 'RETURN' }),
      sequence: undefined,
    };
    expect(decide({ verdicts: [verdict({ sequence: 100 }), missingSequence] }).code).toBe(
      'VERDICT_SEQUENCE_INVALID',
    );
    expect(decide({ verdicts: [missingSequence] }).code).toBe('VERDICT_SEQUENCE_INVALID');
  });

  it('picks the newest by sequence and ignores verdicts about other SHAs', () => {
    expect(
      latestVerdict([verdict(), verdict({ sha: OTHER, sequence: 9 })], CANDIDATE).verdict?.sequence,
    ).toBe(1);
  });
});

describe('hole 5 — competing receipts refuse as ambiguous', () => {
  it('refuses two candidates, accepts an identical repeat, refuses an empty bundle', () => {
    const competing = receipt({
      id: 'ev-receipt-2',
      candidateSha: OTHER,
      baseSha: CANDIDATE,
    });
    expect(evaluateBundle(ITEM, SUBJECT, [receipt(), competing], [verdict()]).code).toBe(
      'RECEIPT_AMBIGUOUS',
    );
    expect(evaluateBundle(ITEM, SUBJECT, [receipt(), receipt()], [verdict()]).eligible).toBe(true);
    expect(evaluateBundle(ITEM, SUBJECT, [], [verdict()]).code).toBe('RECEIPT_MISSING');
  });
});

describe('hole 6 — direct entry points runtime-validate instead of trusting types', () => {
  it('refuses short SHAs, a blank reviewer and a nonsense subject', () => {
    const junk = {
      id: 'x',
      itemKey: KEY,
      candidateSha: 'bad',
      baseSha: 'bad',
      author: 'dsh',
    };
    expect(
      decide({
        receipt: junk,
        verdicts: [{ reviewer: '  ', sha: 'bad', decision: 'PASS', sequence: 1 }],
      }).code,
    ).toBe('SHA_INVALID');
    expect(
      decide({
        verdicts: [
          {
            id: 'v',
            reviewer: '   ',
            sha: CANDIDATE,
            decision: 'PASS',
            sequence: 1,
          },
        ],
      }).code,
    ).toBe('IDENTITY_MISSING');
    expect(decide({ subject: 'no key here' }).code).toBe('SUBJECT_MALFORMED');
  });
});

describe('hole 7 — every named test needs its own successful outcome, by exact name', () => {
  const bare = { ...receipt(), id: undefined };
  it('refuses two named tests with one outcome, or an undeclared outcome name', () => {
    const two = {
      namedTests: ['a.test.ts', 'b.test.ts'],
      outcomes: [{ name: 'a.test.ts', passed: 3, failed: 0 }],
    };
    expect(parseReceipt({ ...bare, ...two })).toBe('RECEIPT_OUTCOMES_MISMATCH');
    const unrelated = {
      namedTests: ['a.test.ts'],
      outcomes: [{ name: 'suite', passed: 9, failed: 0 }],
    };
    expect(parseReceipt({ ...bare, ...unrelated })).toBe('RECEIPT_OUTCOMES_MISMATCH');
  });

  it('refuses duplicated tests or duplicated outcomes', () => {
    expect(parseReceipt({ ...bare, namedTests: ['a.test.ts', 'a.test.ts'] })).toBe(
      'RECEIPT_OUTCOMES_MISMATCH',
    );
    expect(parseReceipt({ ...bare, outcomes: [outcomes()[0], outcomes()[0]] })).toBe(
      'RECEIPT_OUTCOMES_MISMATCH',
    );
  });
});

describe('hole 8 — receipts that contradict each other refuse, whatever their ids', () => {
  it('refuses a different base SHA, or a green receipt beside a failed one', () => {
    const otherBase = receipt({ id: 'ev-receipt-2', baseSha: OTHER });
    expect(evaluateBundle(ITEM, SUBJECT, [receipt(), otherBase], [verdict()]).code).toBe(
      'RECEIPT_AMBIGUOUS',
    );
    const failed = receipt({
      id: 'ev-receipt-3',
      outcomes: outcomes({ failed: 4 }),
    });
    expect(evaluateBundle(ITEM, SUBJECT, [receipt(), failed], [verdict()]).code).toBe(
      'RECEIPT_AMBIGUOUS',
    );
  });

  it('still treats identical content under two ids as one fact', () => {
    expect(
      evaluateBundle(ITEM, SUBJECT, [receipt(), receipt({ id: 'ev-receipt-2' })], [verdict()])
        .eligible,
    ).toBe(true);
  });
});

describe('identity forgives space and case, never emptiness', () => {
  it('sees a spaced uppercase author as the same identity, so a self-PASS refuses', () => {
    expect(normaliseIdentity(' DSH ')).toBe('dsh');
    expect(
      decide({
        receipt: receipt({ author: ' dsh ' }),
        verdicts: [verdict({ reviewer: 'DSH' })],
      }).code,
    ).toBe('NOT_INDEPENDENT_REVIEWER');
    expect(
      decide({
        verdicts: [
          {
            id: 'v',
            reviewer: '',
            sha: CANDIDATE,
            decision: 'PASS',
            sequence: 1,
          },
        ],
      }).code,
    ).toBe('IDENTITY_MISSING');
  });
});

describe('the newest verdict decides, and partial comes from the subject', () => {
  it('refuses RETURN, FAIL and HOLD after a PASS on the same SHA', () => {
    for (const word of ['RETURN', 'FAIL', 'HOLD'] as const) {
      expect(
        decide({
          verdicts: [verdict(), verdict({ id: 'ev-2', decision: word, sequence: 2 })],
        }).code,
      ).toBe('VERDICT_NOT_PASS');
    }
  });

  it('a partial subject records the receipt and leaves the item unfinished', () => {
    const decision = decide({ subject: PARTIAL });
    expect(decision.eligible).toBe(true);
    expect(decision.partial).toBe(true);
    expect(decision.reason).toContain('leave it unfinished');
  });

  it('refuses canceled and archived items before any evidence is read', () => {
    expect(decide({ item: { itemKey: KEY, status: 'canceled' } }).code).toBe('ITEM_CANCELED');
    expect(decide({ item: { itemKey: KEY, archived: true } }).code).toBe('ITEM_ARCHIVED');
  });

  it('refuses when no verdict names the candidate', () => {
    expect(decide({ verdicts: [verdict({ sha: OTHER })] }).code).toBe('VERDICT_MISSING');
  });
});
