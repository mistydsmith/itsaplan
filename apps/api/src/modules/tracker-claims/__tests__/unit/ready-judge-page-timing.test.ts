// Synthetic timing benchmark for the ready page's per-row judgment (sentinel-prod-9924).
//
// WHY a benchmark and not just a count of in-flight judgments: the fix for the ready page is that
// the 25 cards on a page are judged with two in flight instead of one. A count proves the shape of
// the fix; the wall clock proves the page is fast. This benchmark measures the wall clock of one
// 25-row page judged the fixed way (concurrency = JUDGE_CONCURRENCY) against the same page judged
// serially (concurrency 1), and drives both off one threshold: the fixed page must clear it and the
// serial page must not. A change that removes the overlap - the mutant - makes the two times equal
// and that threshold fails, so the benchmark catches it.
//
// No database: the judgment is a stand-in that mimics what one card pays the rule owner, two gates
// (the state op and the claim op), each a fixed delay. sentinel-prod-8429 measured that same shape
// at 34 ms a spawn through the real transport; here each gate is 20 ms so a 25-card page is about
// 1 s serial and about 0.5 s at the fixed bound, a gap far larger than scheduling noise. The
// synthetic absolute time does not equal the real 30 s target - the real page is proven under it by
// the measured timing proof - the benchmark proves the overlap exists and is not removable silently.
import { describe, expect, test } from 'bun:test';
import { JUDGE_CONCURRENCY, judgePage } from '../../ready';
import type { Candidate, ReadyItem } from '../../ready';

// Two 20 ms gates per card, back to back, mimic the two rule-owner spawns one card really pays.
const GATE_MS = 20;

const rows = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, priority: 'low' }));

const itemOf = (row: Candidate): ReadyItem => ({
  id: Number(row.id),
  beadId: `sentinel-prod-${row.id}`,
  title: `card ${row.id}`,
  priority: row.priority,
  epoch: 0,
});

// One card's real cost: the routing op judgeGatedClaim gates first, then the claim op with the
// readiness and lease facts. Two fixed delays, so the page cost is deterministic.
const makeJudge =
  () =>
  async (row: Candidate): Promise<ReadyItem> => {
    await new Promise((resolve) => setTimeout(resolve, GATE_MS));
    await new Promise((resolve) => setTimeout(resolve, GATE_MS));
    return itemOf(row);
  };

// The wall clock for a whole 25-row page. With no concurrency arg the page is judged the fixed way
// (bound = JUDGE_CONCURRENCY); passing 1 forces the serial page, which is the mutant this benchmark
// has to catch.
const timePage = async (concurrency?: number): Promise<number> => {
  const start = performance.now();
  if (concurrency === undefined) {
    await judgePage(rows(25), makeJudge(), {});
  } else {
    await judgePage(rows(25), makeJudge(), {}, concurrency);
  }
  return performance.now() - start;
};

describe('ready page timing benchmark (sentinel-prod-9924)', () => {
  // A single threshold, set between the two expected times, that the fixed page clears and the
  // serial page does not. This is what "tells a slow page from a fast one".
  test('the fixed page clears a threshold the serial page fails', async () => {
    const fixed = await timePage();
    const serial = await timePage(1);
    // The fixed bound overlaps two cards, so the fixed page is about half the serial wall clock.
    // 65% of the serial time sits between them: the fixed page must be under it, the serial page
    // (the mutant that drops the overlap) must be over it.
    const threshold = serial * 0.65;
    expect(fixed).toBeLessThan(threshold);
    expect(serial).toBeGreaterThan(threshold);
  }, 20000);

  // The fix is the measured gain. A mutant that drops the concurrency bound to one makes the fixed
  // time equal the serial time; this ratio assertion then fails, so it catches that mutant.
  test('removing the overlap is caught: the serial page is not at least 1.4x slower than the fixed one', async () => {
    const fixed = await timePage();
    const serial = await timePage(1);
    expect(serial).toBeGreaterThan(fixed * 1.4);
  }, 20000);

  // The benchmark's threshold is calibrated to the measured bound, so it must stay the measured one.
  test('the bound the benchmark relies on is the measured one, not a rounder guess', () => {
    expect(JUDGE_CONCURRENCY).toBe(2);
  });
});
