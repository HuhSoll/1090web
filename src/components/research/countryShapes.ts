import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { FeatureCollection } from 'geojson';
import countriesUrl from 'world-atlas/countries-110m.json?url';

let cache: Promise<FeatureCollection> | null = null;

/** Country outlines (the basemap data of the globe), loaded once. */
export function loadCountryShapes(): Promise<FeatureCollection> {
  cache ??= fetch(countriesUrl)
    .then((r) => r.json() as Promise<Topology>)
    .then((topo) => feature(topo, topo.objects.countries as GeometryCollection) as FeatureCollection);
  cache.catch(() => { cache = null; });
  return cache;
}
