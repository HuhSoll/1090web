import { useEffect, useState } from 'react';
import { assetUrl } from '../data/loaders/fetchJson';
import { ISLAND_REGION, type GlobalImportance, type IslandGeo, type IslandMeta, type IslandNetwork, type MeshTable } from './model';

export interface IslandData {
  meta: IslandMeta;
  network: IslandNetwork;
  meshes: MeshTable;
  geo: IslandGeo;
  global: GlobalImportance | null;
}

export type IslandDataState = { state: 'loading' } | { state: 'ready'; data: IslandData } | { state: 'error'; message: string };

let cache: Promise<IslandData> | null = null;

async function json<T>(root: string, name: string): Promise<T> {
  const r = await fetch(`${root}${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function loadIslandData(baseUrl: string, region = ISLAND_REGION): Promise<IslandData> {
  if (!cache) {
    const root = assetUrl(baseUrl, `data/islands/${region}/`);
    cache = Promise.all([
      json<IslandMeta>(root, 'meta.json'),
      json<IslandNetwork>(root, 'network.json'),
      json<MeshTable>(root, 'meshes.json'),
      json<IslandGeo>(root, 'geo.json'),
      json<GlobalImportance>(root, 'global.json').catch(() => null),
    ]).then(([meta, network, meshes, geo, global]) => ({ meta, network, meshes, geo, global }));
    cache.catch(() => { cache = null; });
  }
  return cache;
}

export function useIslandData(): IslandDataState {
  const [s, setS] = useState<IslandDataState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadIslandData(import.meta.env.BASE_URL)
      .then((data) => live && setS({ state: 'ready', data }))
      .catch((e: unknown) => live && setS({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, []);
  return s;
}
