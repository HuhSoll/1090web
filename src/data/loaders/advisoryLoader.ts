import type { AdvisoryFile } from '../model/advisory';
import { assetUrl, fetchJson } from './fetchJson';
import { SchemaError } from './validate';

const isDate = (v: unknown) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

export function validateAdvisories(raw: unknown): AdvisoryFile {
  const f = raw as AdvisoryFile;
  if (!f || typeof f !== 'object' || f.schemaVersion !== 1 || !Array.isArray(f.items) || !f.source?.url) {
    throw new SchemaError('advisories: bad file');
  }
  for (const a of f.items) {
    if (typeof a.id !== 'string' || typeof a.title !== 'string') throw new SchemaError('advisories: bad item');
    if (!isDate(a.issued) || !isDate(a.end)) throw new SchemaError(`advisories: bad dates in ${a.id}`);
    if (!Array.isArray(a.countries)) throw new SchemaError(`advisories: bad countries in ${a.id}`);
  }
  return f;
}

/** Advisory files live outside the flight datasets so they can be updated independently. */
export async function loadAdvisories(baseUrl: string, file = 'easa-czib.json'): Promise<AdvisoryFile> {
  return validateAdvisories(await fetchJson<unknown>(assetUrl(baseUrl, `data/advisories/${file}`)));
}
