/**
 * Which public dataset to load from /data/<id>/. Phase 2 will add an "observed-2026" dataset
 * produced by the Python/DuckDB pipeline; switching is a one-line change (or a build env var).
 */
export const DATASET_ID: string = import.meta.env.VITE_DATASET_ID ?? 'demo';

export const PLAYBACK_INTERVAL_MS = 1600;
