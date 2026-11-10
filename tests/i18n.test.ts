import { describe, expect, it } from 'vitest';
import { en, format, ja } from '../src/i18n/messages';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('ja and en have exactly the same keys', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty translations', () => {
    for (const dict of [en, ja] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(dict)) expect(v.trim(), k).not.toBe('');
    }
  });

  it('uses the same placeholders in both languages', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ja[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('formats placeholders', () => {
    expect(format('{a} / {b}', { a: 1, b: 'x' })).toBe('1 / x');
    expect(format('{missing}', {})).toBe('{missing}');
  });
});
