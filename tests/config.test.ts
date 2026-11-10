import { describe, expect, it } from 'vitest';
import { resolveDatasetId } from '../src/app/config';

describe('resolveDatasetId', () => {
  it('defaults to the observed dataset', () => {
    expect(resolveDatasetId('')).toBe('observed-2026-v2');
  });

  it('accepts a known dataset from the URL', () => {
    expect(resolveDatasetId('?dataset=demo')).toBe('demo');
    expect(resolveDatasetId('?dataset=observed-2026')).toBe('observed-2026'); // v1 kept for comparison
  });

  it('ignores unknown dataset ids (no arbitrary paths)', () => {
    expect(resolveDatasetId('?dataset=../../etc')).toBe('observed-2026-v2');
  });
});
