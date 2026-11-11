import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/useI18n';

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="stat" title={note}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <p className={warn ? 'hint warn r-note' : 'hint r-note'}>{children}</p>;
}

export interface Column<T> {
  key: string;
  label: string;
  value: (row: T) => number | string | null;
  render?: (row: T) => ReactNode;
  numeric?: boolean;
  title?: string;
}

/** Sortable table (click a header). Shows `limit` rows with a "show more" button. */
export function SortTable<T>({
  columns,
  rows,
  rowKey,
  initialSort,
  limit = 50,
  onRowClick,
  selectedKey,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  initialSort?: { key: string; desc: boolean };
  limit?: number;
  onRowClick?: (r: T) => void;
  selectedKey?: string | null;
  caption?: ReactNode;
}) {
  const { t } = useI18n();
  const [sort, setSort] = useState(initialSort ?? { key: columns[0]!.key, desc: false });
  const [shown, setShown] = useState(limit);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0]!;
    const out = [...rows];
    out.sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, columns, sort]);
  return (
    <div className="r-table-wrap">
      <table className="r-table">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.numeric ? 'num' : undefined} title={c.title} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button type="button" onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : !!c.numeric }))}>
                  {c.label}
                  {sort.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, shown).map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={selectedKey === k ? 'is-selected' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'num' : undefined}>
                    {c.render ? c.render(r) : c.value(r) ?? '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > shown && (
        <button type="button" className="link-btn r-more" onClick={() => setShown((n) => n + limit)}>
          {t('r.table.more', { shown: Math.min(shown, sorted.length), total: sorted.length })}
        </button>
      )}
      {sorted.length === 0 && <p className="hint">{t('r.table.empty')}</p>}
    </div>
  );
}
