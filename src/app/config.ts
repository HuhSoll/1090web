/** Public datasets shipped under /data/<id>/. */
export const DATASETS = ['observed-2026', 'demo'] as const;
export type DatasetId = (typeof DATASETS)[number];

const isDatasetId = (v: unknown): v is DatasetId => (DATASETS as readonly unknown[]).includes(v);

/**
 * Which dataset to load: `?dataset=<id>` (e.g. ?dataset=demo), else the build-time
 * VITE_DATASET_ID, else the observed 2026 data.
 */
export function resolveDatasetId(search = typeof window !== 'undefined' ? window.location.search : ''): DatasetId {
  const fromUrl = new URLSearchParams(search).get('dataset');
  if (isDatasetId(fromUrl)) return fromUrl;
  const fromEnv = import.meta.env.VITE_DATASET_ID;
  if (isDatasetId(fromEnv)) return fromEnv;
  return 'observed-2026';
}

export const PLAYBACK_INTERVAL_MS = 1600;
