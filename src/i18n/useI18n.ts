import { useMemo } from 'react';
import { useAppStore } from '../state/store';
import { format, MESSAGES, type Locale, type MessageKey } from './messages';

export interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  number: (n: number) => string;
  monthLabel: (ym: string, style?: 'long' | 'short') => string;
  countryName: (iso2: string) => string;
  dateTime: (iso: string) => string;
}

export function createI18n(locale: Locale): I18n {
  const dict = MESSAGES[locale];
  const intlLocale = locale === 'ja' ? 'ja-JP' : 'en-US';
  const nf = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 0 });
  const monthLong = new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const monthShort = new Intl.DateTimeFormat(intlLocale, { month: 'short', timeZone: 'UTC' });
  const dtf = new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  let regions: Intl.DisplayNames | null = null;
  try {
    regions = new Intl.DisplayNames([intlLocale], { type: 'region' });
  } catch {
    regions = null;
  }
  return {
    locale,
    t: (key, params) => format(dict[key], params),
    number: (n) => nf.format(n),
    monthLabel: (ym, style = 'long') => {
      const m = /^(\d{4})-(\d{2})$/.exec(ym);
      if (!m) return ym;
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      return (style === 'long' ? monthLong : monthShort).format(d);
    },
    countryName: (iso2) => {
      try {
        return regions?.of(iso2) ?? iso2;
      } catch {
        return iso2;
      }
    },
    dateTime: (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : `${dtf.format(d)} UTC`;
    },
  };
}

export function useI18n(): I18n {
  const locale = useAppStore((s) => s.locale);
  return useMemo(() => createI18n(locale), [locale]);
}
