import { describe, expect, it } from 'vitest';
import { resolveDatasetId } from '../src/app/config';

describe('resolveDatasetId', () => {
  it('defaults to the observed dataset', () => {
    expect(resolveDatasetId('')).toBe('observed-2026');
  });

  it('accepts a known dataset from the URL', () => {
    expect(resolveDatasetId('?dataset=demo')).toBe('demo');
  });

  it('ignores unknown dataset ids (no arbitrary paths)', () => {
    expect(resolveDatasetId('?dataset=../../etc')).toBe('observed-2026');
  });
});
