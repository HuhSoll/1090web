/** Public datasets shipped under /data/<id>/. */
/** observed-2026-v2 is the default since Phase 6A; observed-2026 (v1) is kept for comparison. */
export const DATASETS = ['observed-2026-v2', 'observed-2026', 'demo'] as const;
export type DatasetId = (typeof DATASETS)[number];

const isDatasetId = (v: unknown): v is DatasetId => (DATASETS as readonly unknown[]).includes(v);

/**
 * Which dataset to load: `?dataset=<id>` (e.g. ?dataset=demo), else the build-time
 * VITE_DATASET_ID, else the observed 2026 data (version 2).
 */
export function resolveDatasetId(search = typeof window !== 'undefined' ? window.location.search : ''): DatasetId {
  const fromUrl = new URLSearchParams(search).get('dataset');
  if (isDatasetId(fromUrl)) return fromUrl;
  const fromEnv = import.meta.env.VITE_DATASET_ID;
  if (isDatasetId(fromEnv)) return fromEnv;
  return 'observed-2026-v2';
}

export const PLAYBACK_INTERVAL_MS = 1600;
