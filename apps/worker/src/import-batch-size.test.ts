// sentinel-prod-8364: the per-tick chunk by source. Pure, no database and no reader.
import { describe, expect, it } from 'bun:test';
import { importBatchSize } from './import-batch-size';

describe('importBatchSize', () => {
  it('gives a local bd board 250 records a tick', () => {
    expect(importBatchSize('bd')).toBe(250);
  });

  it('keeps every remote source at 15, inside its request budget', () => {
    for (const source of ['plane', 'linear', 'trello', 'something-new']) {
      expect(importBatchSize(source)).toBe(15);
    }
  });
});
