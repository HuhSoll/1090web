import { useState } from 'react';
import { periodOf } from '../../research/periods';
import { useI18n } from '../../i18n/useI18n';
import type { AreaPair, AreaStat } from '../../research/network';
import type { AnalysisResult } from '../../research/results';
import { useAppStore } from '../../state/store';
import { Note, SortTable, type Column } from './common';
import { useFormat } from './format';

export function GeographyPanel({ result }: { result: AnalysisResult }) {
  const { t, countryName, monthLabel } = useI18n();
  const f = useFormat();
  const patch = useAppStore((s) => s.patchResearchConfig);
  const [unit, setUnit] = useState<'country' | 'region'>('country');
  const area = unit === 'country' ? result.countries : result.regions;
  const name = (code: string) => (unit === 'country' ? countryName(code) : code === '?' ? '?' : t(`r.region.${code}` as 'r.region.EU'));

  const statCols: Column<AreaStat>[] = [
    { key: 'area', label: t(unit === 'country' ? 'r.geo.country' : 'r.geo.region'), value: (s) => name(s.area) },
    { key: 'international', label: t('r.geo.international'), numeric: true, value: (s) => s.international, render: (s) => f.int(s.international) },
    { key: 'domestic', label: t(unit === 'country' ? 'r.geo.domestic' : 'r.geo.withinRegion'), numeric: true, value: (s) => s.domestic, render: (s) => f.int(s.domestic) },
    { key: 'partners', label: t('r.geo.partners'), numeric: true, value: (s) => s.partners, render: (s) => f.int(s.partners) },
    { key: 'top', label: t('r.geo.topPartners'), value: (s) => s.topPartners[0]?.area ?? '', render: (s) => s.topPartners.slice(0, 3).map((p) => `${unit === 'country' ? p.area : name(p.area)} ${f.int(p.flights)}`).join(' · ') },
  ];
  const pairCols: Column<AreaPair>[] = [
    { key: 'from', label: result.config.directed ? t('r.geo.from') : t('r.geo.areaA'), value: (p) => name(p.from) },
    { key: 'to', label: result.config.directed ? t('r.geo.to') : t('r.geo.areaB'), value: (p) => name(p.to) },
    { key: 'flights', label: t('r.col.flights'), numeric: true, value: (p) => p.flights, render: (p) => f.int(p.flights) },
  ];

  return (
    <div className="r-stack">
      <div className="r-toolbar">
        <div className="segmented" role="radiogroup" aria-label={t('r.geo.unit')}>
          {(['country', 'region'] as const).map((u) => (
            <button key={u} type="button" role="radio" aria-checked={unit === u} className={unit === u ? 'is-active' : ''} onClick={() => setUnit(u)}>
              {t(u === 'country' ? 'r.geo.unitCountry' : 'r.geo.unitRegion')}
            </button>
          ))}
        </div>
      </div>
      <Note warn>{t('r.geo.note')}</Note>
      <section>
        <h3 className="r-h">{t(unit === 'country' ? 'r.geo.countriesTitle' : 'r.geo.regionsTitle', { month: monthLabel(periodOf(result.config)) })}</h3>
        <p className="hint">{t('r.geo.definition')}</p>
        <SortTable
          key={`s-${unit}`}
          columns={statCols}
          rows={area.stats}
          rowKey={(s) => s.area}
          initialSort={{ key: 'international', desc: true }}
          onRowClick={unit === 'country' ? (s) => s.area !== '?' && patch({ country: s.area, region: null }) : (s) => s.area !== '?' && patch({ region: s.area, country: null })}
        />
        <p className="hint">{t('r.geo.clickToFilter')}</p>
      </section>
      <section>
        <h3 className="r-h">{t(unit === 'country' ? 'r.geo.pairsCountry' : 'r.geo.pairsRegion')}</h3>
        <SortTable key={`p-${unit}`} columns={pairCols} rows={area.pairs} rowKey={(p) => `${p.from}>${p.to}`} initialSort={{ key: 'flights', desc: true }} />
      </section>
    </div>
  );
}
