import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

const MAX_RESULTS = 12;

/**
 * Airline filter as a type-ahead: observed data has thousands of airline codes, too many for a
 * dropdown. Codes are listed busiest first (manifest order), with their total flights.
 */
export function AirlinePicker() {
  const { t, number } = useI18n();
  const network = useAppStore((s) => s.network);
  const carrierId = useAppStore((s) => s.filters.carrierId);
  const setFilters = useAppStore((s) => s.setFilters);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const carriers = useMemo(() => network?.carriers ?? [], [network]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = q
      ? carriers.filter((c) => c.id.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q))
      : carriers;
    return match.slice(0, MAX_RESULTS);
  }, [carriers, query]);

  const choose = (i: number) => {
    const c = results[i];
    if (!c) return;
    setFilters({ carrierId: c.id });
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

  const selected = carrierId ? carriers.find((c) => c.id === carrierId) : null;

  return (
    <div className="field search">
      <label className="field-label" htmlFor={`${listId}-input`}>
        {t('filters.carrier')}
      </label>
      {selected ? (
        <div className="search-box chosen">
          <span className="code">{selected.id}</span>
          {selected.name !== selected.id && <span>{selected.name}</span>}
          <button
            type="button"
            className="icon-btn small push"
            aria-label={t('filters.carrierClear')}
            title={t('filters.carrierClear')}
            onClick={() => setFilters({ carrierId: null })}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : (
        <div className="search-box">
          <Icon name="search" />
          <input
            id={`${listId}-input`}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('filters.carrierSearch')}
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
        </div>
      )}
      {open && !selected && (
        <ul className="search-results" id={listId} role="listbox">
          {results.length === 0 && <li className="search-empty">{t('filters.carrierNone')}</li>}
          {results.map((c, i) => (
            <li
              key={c.id}
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
              <span className="code">{c.id}</span>
              <span className="search-name">
                <span>{c.name !== c.id ? c.name : ''}</span>
              </span>
              {c.flights !== undefined && <span className="muted small push">{t('unit.flights', { value: number(c.flights) })}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
