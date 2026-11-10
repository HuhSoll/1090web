export class DataLoadError extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(message: string, url: string, status: number | null = null) {
    super(message);
    this.name = 'DataLoadError';
    this.url = url;
    this.status = status;
  }
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new DataLoadError(`Network error while loading ${url}`, url);
  }
  if (!res.ok) throw new DataLoadError(`HTTP ${res.status} while loading ${url}`, url, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new DataLoadError(`Invalid JSON in ${url}`, url, res.status);
  }
}

/** Joins Vite's BASE_URL (normally ends with "/") with a relative path. */
export function assetUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}
