# Research files

Derived from ADS-B observations (MrAirspace/aircraft-flight-schedules, ODbL-1.0) and OurAirports.
Not an official timetable. See docs/research-readiness-audit.md and docs/phase6a-report.md.

## routes_monthly.parquet
One row per (month, origin, destination, airline code, class, origin_rule, destination_rule,
origin_conflict, destination_conflict, tier, same_airport) with `flights` = number of flights.
Directed: origin -> destination. Includes unresolved ends (NULL airport, rule R5) and flights
from an airport to itself (`same_airport`), which the map excludes.

- class: passenger / cargo / unknown, from the aircraft VARIANT (aircraft-based evidence, not the
  purpose of the flight).
- rules (per end): R1 track end near one candidate airport; R2 nearest of several candidates;
  R3 callsign-route airport among the track-end candidates; R4 callsign route only; R5 unresolved.
- conflict: the track pointed at an airport and the callsign route names another one.
- tier (per flight): T1_track, T2_track_conflict, T3_track_callsign, T4_callsign_only,
  X_unresolved. "Track" means supported by the track end, not certain. Callsign-route mismatch
  rates measured on checkable ends (e.g. ~26% in North America) are NOT the error rate of
  unverified R4 ends.

## airports.csv / airport_aliases.csv
Canonical airport per OurAirports record. Codes are merged only when they belong to the same
OurAirports record. Codes matching several records are listed as `unresolved`.

## coverage_daily.csv
Flights per day and region (continent of the origin airport, else destination; WORLD = all).
`baseline` = median of the same weekday within +-28 days (excluding the day).
`suspected_low` = flights < 0.8 x baseline. This is a DETECTION flag only: holidays, seasonality,
regional differences and receiver changes also move the ratio. Nothing is imputed.
