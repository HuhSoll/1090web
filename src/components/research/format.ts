import { useMemo } from 'react';
import { useI18n } from '../../i18n/useI18n';

/** Locale-aware number formatting for Research Mode ('—' for missing values). */
export function useFormat() {
  const { locale } = useI18n();
  return useMemo(() => {
    const tag = locale === 'ja' ? 'ja-JP' : 'en-US';
    const cache = new Map<number, Intl.NumberFormat>();
    const nf = (digits: number) => {
      let f = cache.get(digits);
      if (!f) {
        f = new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: digits });
        cache.set(digits, f);
      }
      return f;
    };
    return {
      int: (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf(0).format(Math.round(v))),
      dec: (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf(d).format(v)),
      pct: (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf(d).format(v * 100)}%`),
      signedPct: (v: number | null | undefined, d = 1) =>
        v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${nf(d).format(v * 100)}%`,
    };
  }, [locale]);
}

/** Saves text as a file in the browser. */
export function downloadText(name: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
