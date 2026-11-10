import { useMemo } from 'react';
import { DEFAULT_FILTERS, thresholdStepsFor, type NetworkView, type TrafficMode } from '../../domain/networkView';
import { useAppStore } from '../../state/store';
import { AirlinePicker } from './AirlinePicker';
import { useI18n } from '../../i18n/useI18n';

export function FilterPanel({ view }: { view: NetworkView | null }) {
  const { t, countryName, number, locale } = useI18n();
  const network = useAppStore((s) => s.network);
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);
  const resetFilters = useAppStore((s) => s.resetFilters);
  const disabled = !network;
  const isObserved = network?.manifest.kind === 'observed';

  const countries = useMemo(() => {
    if (!network) return [];
    const codes = [...new Set(network.airports.map((a) => a.country))];
    return codes
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [network, countryName, locale]);

  // Derived from the max *before* thresholding so the slider range is stable while dragging.
  const maxBefore = view?.maxRouteFlightsUnthresholded ?? 0;
  const steps = useMemo(() => thresholdStepsFor(maxBefore), [maxBefore]);
  const stepIndex = Math.max(0, steps.findIndex((s) => s >= filters.minFlights));

  const isDefault =
    filters.country === DEFAULT_FILTERS.country &&
    filters.carrierId === DEFAULT_FILTERS.carrierId &&
    filters.mode === DEFAULT_FILTERS.mode &&
    filters.minFlights === DEFAULT_FILTERS.minFlights &&
    filters.includeCallsign === DEFAULT_FILTERS.includeCallsign;

  const modes: { value: TrafficMode; label: string }[] = [
    { value: 'all', label: t('filters.trafficAll') },
    { value: 'passenger', label: t('filters.trafficPassenger') },
  ];

  return (
    <section className="section" aria-labelledby="filters-title">
      <div className="section-head">
        <h2 id="filters-title" className="section-title">
          {t('filters.title')}
        </h2>
        <button type="button" className="link-btn" onClick={resetFilters} disabled={isDefault}>
          {t('filters.reset')}
        </button>
      </div>

      <label className="field">
        <span className="field-label">{t('filters.country')}</span>
        <select
          value={filters.country ?? ''}
          disabled={disabled}
          onChange={(e) => setFilters({ country: e.target.value || null })}
        >
          <option value="">{t('filters.countryAll')}</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <AirlinePicker />

      <div className="field" role="radiogroup" aria-label={t('filters.traffic')}>
        <span className="field-label">{t('filters.traffic')}</span>
        <div className="segmented">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={filters.mode === m.value}
              className={filters.mode === m.value ? 'is-active' : ''}
              disabled={disabled}
              onClick={() => setFilters({ mode: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>
        {filters.mode === 'passenger' && <p className="hint">{t('filters.trafficNote')}</p>}
      </div>

      {isObserved && (
        <div className="field" role="radiogroup" aria-label={t('filters.basis')}>
          <span className="field-label">{t('filters.basis')}</span>
          <div className="segmented">
            {[
              { value: true, label: t('filters.basisAll') },
              { value: false, label: t('filters.basisObserved') },
            ].map((o) => (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={filters.includeCallsign === o.value}
                className={filters.includeCallsign === o.value ? 'is-active' : ''}
                onClick={() => setFilters({ includeCallsign: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="hint">{t('filters.basisNote')}</p>
        </div>
      )}

      <label className="field">
        <span className="field-row">
          <span className="field-label">{t('filters.threshold')}</span>
          <span className="field-value">
            {filters.minFlights > 0 ? t('filters.thresholdValue', { value: number(filters.minFlights) }) : t('filters.thresholdOff')}
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, steps.length - 1)}
          step={1}
          value={stepIndex}
          disabled={disabled || steps.length < 2}
          onChange={(e) => setFilters({ minFlights: steps[Number(e.target.value)] ?? 0 })}
        />
      </label>
    </section>
  );
}
