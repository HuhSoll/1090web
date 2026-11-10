import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { searchAirports } from '../../domain/search';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

export function AirportSearch() {
  const { t, countryName } = useI18n();
  const network = useAppStore((s) => s.network);
  const selectAirport = useAppStore((s) => s.selectAirport);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const results = useMemo(() => (network ? searchAirports(network.airports, query, 8) : []), [network, query]);

  const choose = (index: number) => {
    const a = results[index];
    if (!a) return;
    selectAirport(a.index);
    setDrawerOpen(false);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="search">
      <label className="field-label" htmlFor={`${listId}-input`}>
        {t('search.label')}
      </label>
      <div className="search-box">
        <Icon name="search" />
        <input
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('search.placeholder')}
          value={query}
          disabled={!network}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button type="button" className="icon-btn small" aria-label={t('search.clear')} onClick={() => setQuery('')}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {showList && (
        <ul className="search-results" id={listId} role="listbox">
          {results.length === 0 && <li className="search-empty">{t('search.noResults')}</li>}
          {results.map((a, i) => (
            <li
              key={a.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="code">{a.iata ?? a.icao ?? a.id}</span>
              <span className="search-name">
                <span>{a.name}</span>
                <span className="muted">
                  {a.city} · {countryName(a.country)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
