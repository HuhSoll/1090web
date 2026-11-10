/**
 * Official advisories shown as an overlay. The kinds are kept distinct on purpose:
 * a safety warning is not an airspace closure, a weather warning or a cancellation, and none of
 * them is used to remove routes from the observed network.
 */
export type AdvisoryKind = 'safety-warning' | 'airspace-restriction' | 'weather-warning' | 'cancellation';

export interface AdvisoryCountry {
  iso2: string;
  /** ISO 3166-1 numeric code (as used by the world-atlas base map) */
  isoNumeric: string;
  name: string;
}

export interface Advisory {
  id: string;
  kind: AdvisoryKind;
  title: string;
  status: 'active' | 'withdrawn' | 'suspended' | string;
  /** YYYY-MM-DD */
  issued: string | null;
  /** YYYY-MM-DD; null = no end date published */
  end: string | null;
  /** The source does not publish withdrawal dates; the end was inferred from the last update. */
  endIsApproximate: boolean;
  validUntilNote: string;
  countries: AdvisoryCountry[];
  /** Covers part of a country or a region; the map tints whole countries as an approximation. */
  partialArea: boolean;
}

export interface AdvisorySource {
  id: string;
  name: string;
  url: string;
  license: string;
  retrievedAt: string;
}

export interface AdvisoryFile {
  schemaVersion: 1;
  source: AdvisorySource;
  items: Advisory[];
}
