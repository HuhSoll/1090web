"""
Data-quality measurements for the research-readiness audit (docs/research-readiness-audit.md).

Reads the local audit database built by build_audit_db.py and the published dataset, and
writes data/quality/audit-<year>.json. Every number quoted as "measured" in the audit document
comes from this file.

Usage: python pipeline/audit/audit_queries.py --year 2026 --dataset observed-2026
"""

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2026)
    p.add_argument("--dataset", default="observed-2026")
    p.add_argument("--only", default="", help="comma-separated section names to run")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    con = duckdb.connect(str(ROOT / "data" / "interim" / f"audit-{args.year}.duckdb"), read_only=True)
    q = lambda sql: con.execute(sql).fetchall()
    one = lambda sql: con.execute(sql).fetchone()
    out_path = ROOT / "data" / "quality" / f"audit-{args.year}.json"
    out = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    only = set(filter(None, args.only.split(",")))

    def section(name):
        def deco(fn):
            if only and name not in only:
                return
            r = fn()
            out[name] = r
            # Save after every section so a failing query does not lose earlier results.
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
            print(f"[{time.time() - t0:6.1f}s] {name}", flush=True)
            print(json.dumps(r, ensure_ascii=False, default=str)[:1500], flush=True)
        return deco

    published = json.loads((ROOT / "data" / "quality" / f"{args.dataset}.json").read_text(encoding="utf-8"))

    @section("reproduces_published_totals")
    def _():
        basis = dict(q("SELECT basis, count(*) FROM resolved GROUP BY 1"))
        conflicts = {"origin": one("SELECT count(*) FROM resolved WHERE org_conflict")[0],
                     "destination": one("SELECT count(*) FROM resolved WHERE dst_conflict")[0]}
        same = one("SELECT count(*) FROM resolved WHERE basis <> 'unknown' AND org = dst")[0]
        return {
            "flights_in_scope": {"audit": one("SELECT count(*) FROM resolved")[0], "published": published["flights_in_scope"]},
            "basis": {"audit": basis, "published": published["basis"]},
            "conflicts": {"audit": conflicts, "published": published["observed_vs_callsign_conflicts"]},
            "same_airport": {"audit": same, "published": published["same_airport_excluded"]},
            "match": basis == published["basis"] and conflicts == published["observed_vs_callsign_conflicts"]
                     and same == published["same_airport_excluded"],
        }

    @section("rules")
    def _():
        r = {}
        for side in ("org", "dst"):
            r[side] = dict(q(f"SELECT {side}_rule, count(*) FROM resolved GROUP BY 1 ORDER BY 1"))
        r["ambiguous_near_multi_candidate"] = {
            "origin": one("SELECT count(*) FROM org_res r JOIN flights f USING (fid) WHERE f.org_near AND r.n_valid > 1 AND (r.d2 - r.d1) < 1.0")[0],
            "destination": one("SELECT count(*) FROM dst_res r JOIN flights f USING (fid) WHERE f.dst_near AND r.n_valid > 1 AND (r.d2 - r.d1) < 1.0")[0],
        }
        r["near_but_no_known_candidate"] = {
            "origin": one("SELECT count(*) FROM org_res r JOIN flights f USING (fid) WHERE f.org_near AND r.n_valid = 0")[0],
            "destination": one("SELECT count(*) FROM dst_res r JOIN flights f USING (fid) WHERE f.dst_near AND r.n_valid = 0")[0],
        }
        return r

    @section("conflicts")
    def _():
        flights = dict(q("""SELECT CASE WHEN org_conflict AND dst_conflict THEN 'both'
                                        WHEN org_conflict THEN 'origin_only'
                                        WHEN dst_conflict THEN 'destination_only' ELSE 'none' END k, count(*)
                             FROM resolved GROUP BY 1"""))
        # How far apart are the track airport and the callsign-route airport?
        dist = {}
        for side in ("org", "dst"):
            dist[side] = dict(q(f"""
              WITH c AS (
                SELECT r.{side}_track t, r.{side.replace('org','val1').replace('dst','val2')} v FROM resolved r WHERE r.{side}_conflict)
              SELECT CASE WHEN a.code IS NULL OR b.code IS NULL THEN 'callsign_airport_unknown'
                          WHEN d < 10 THEN '<10km' WHEN d < 50 THEN '10-50km' WHEN d < 200 THEN '50-200km'
                          WHEN d < 1000 THEN '200-1000km' ELSE '>=1000km' END bucket, count(*)
              FROM (SELECT c.*, a.code ac, b.code bc,
                      2*6371*asin(sqrt(pow(sin(radians(b.lat-a.lat)/2),2)+cos(radians(a.lat))*cos(radians(b.lat))*pow(sin(radians(b.lon-a.lon)/2),2))) d
                    FROM c LEFT JOIN ap a ON a.code = c.t LEFT JOIN ap b ON b.code = c.v) x
              LEFT JOIN ap a ON a.code = x.t LEFT JOIN ap b ON b.code = x.v
              GROUP BY 1 ORDER BY 2 DESC"""))
        # Callsign route stored in the opposite direction (track A->B, callsign B->A)
        reversed_route = one("""SELECT count(*) FROM resolved
                                 WHERE org_conflict AND dst_conflict AND org_track = val2 AND dst_track = val1""")[0]
        # Both ends conflict and the callsign route is a completely different city pair
        by_month = q("""SELECT month, count(*) FILTER (WHERE org_conflict OR dst_conflict) * 1.0 / count(*)
                        FROM resolved GROUP BY 1 ORDER BY 1""")
        by_continent = q("""SELECT a.continent, count(*) FILTER (WHERE r.dst_conflict) n_conf, count(*) n,
                                   round(count(*) FILTER (WHERE r.dst_conflict) * 100.0 / count(*), 1) pct
                            FROM resolved r JOIN ap a ON a.code = r.dst_track
                            GROUP BY 1 ORDER BY n DESC""")
        top_airlines = q("""SELECT airline, count(*) n, round(count(*) FILTER (WHERE org_conflict OR dst_conflict) * 100.0 / count(*), 1) pct
                            FROM resolved GROUP BY 1 HAVING count(*) > 100000 ORDER BY pct DESC LIMIT 12""")
        # What did the published data do with conflicting sides? (observed airport kept)
        examples = q("""SELECT callsign, org_track, dst_track, val1, val2, month FROM resolved
                        WHERE org_conflict AND dst_conflict AND org_track <> val2 USING SAMPLE 12 ROWS (reservoir, 42)""")
        return {"flights_by_conflict_side": flights, "side_distance_track_vs_callsign": dist,
                "both_sides_reversed_callsign_route": reversed_route, "share_by_month": by_month,
                "destination_conflict_by_continent": by_continent, "top_airlines_by_conflict_rate": top_airlines,
                "sample": examples}

    @section("same_airport")
    def _():
        rules = q("""SELECT org_rule, dst_rule, count(*) n FROM resolved
                     WHERE basis <> 'unknown' AND org = dst GROUP BY 1,2 ORDER BY n DESC LIMIT 8""")
        classes = dict(q("SELECT class, count(*) FROM resolved WHERE basis <> 'unknown' AND org = dst GROUP BY 1"))
        types = q("""SELECT ac_type, count(*) n FROM resolved WHERE basis <> 'unknown' AND org = dst
                     GROUP BY 1 ORDER BY n DESC LIMIT 12""")
        callsign_says_different = one("""SELECT count(*) FROM resolved WHERE basis <> 'unknown' AND org = dst
                                         AND val1 IS NOT NULL AND val2 IS NOT NULL AND val1 <> val2""")[0]
        return {"by_rule_pair": rules, "by_class": classes, "top_aircraft_types": types,
                "callsign_route_names_two_airports": callsign_says_different}

    @section("airport_codes")
    def _():
        used = json.loads((ROOT / "public" / "data" / args.dataset / "airports.json").read_text(encoding="utf-8"))
        iata = Counter(a["iata"] for a in used if a["iata"])
        dup_iata = {k: [a["id"] for a in used if a["iata"] == k] for k, v in iata.items() if v > 1}
        non_icao = [a["id"] for a in used if not a.get("icao")]
        multi_ident = q("""SELECT code, n_idents FROM ap WHERE n_idents > 1
                           AND code IN (SELECT org FROM resolved UNION SELECT dst FROM resolved) ORDER BY n_idents DESC LIMIT 20""")
        unmatched = q("""WITH c AS (SELECT unnest(org_cands) code FROM flights UNION ALL SELECT unnest(dst_cands) FROM flights)
                         SELECT c.code, count(*) n FROM c LEFT JOIN ap USING (code) WHERE ap.code IS NULL
                         GROUP BY 1 ORDER BY n DESC LIMIT 15""")
        unmatched_total = one("""WITH c AS (SELECT unnest(org_cands) code FROM flights UNION ALL SELECT unnest(dst_cands) FROM flights)
                                 SELECT count(*) FILTER (WHERE ap.code IS NULL), count(*) FROM c LEFT JOIN ap USING (code)""")
        callsign_unknown = one("""SELECT count(*) FROM flights f LEFT JOIN ap a ON a.code = f.val1 WHERE f.val1 IS NOT NULL AND a.code IS NULL""")[0]
        ties = one("""SELECT count(*) FROM (SELECT code, count(*) c FROM (
                        SELECT icao_code code, ident FROM ap_raw WHERE icao_code IS NOT NULL AND type NOT IN ('heliport','balloonport','closed'))
                      GROUP BY code HAVING count(*) > 1)""")[0]
        return {"published_airports": len(used), "duplicate_iata_in_published": dup_iata,
                "published_ids_not_icao_shaped": len(non_icao), "examples_not_icao": non_icao[:15],
                "codes_with_several_idents_used": multi_ident, "icao_code_shared_by_several_open_airports": ties,
                "candidate_codes_not_in_ourairports": {"rows": unmatched_total[0], "of": unmatched_total[1], "top": unmatched},
                "callsign_origin_codes_not_in_ourairports": callsign_unknown}

    @section("duplicates")
    def _():
        cross_file = one("""SELECT count(*) FROM (
                              SELECT ICAO_Hex, Track_Origin_DateTime_UTC, Track_Destination_DateTime_UTC, count(DISTINCT quarter) nq
                              FROM raw WHERE Track_Origin_DateTime_UTC <> '-' GROUP BY 1,2,3 HAVING count(DISTINCT quarter) > 1)""")[0]
        exact_in_scope = one("""SELECT count(*) - count(DISTINCT (hex, org_time_raw, dst_time_raw)) FROM flights
                                WHERE org_time_raw <> '-' AND dst_time_raw <> '-'""")[0]
        # Same aircraft, same callsign, departures within 30 min: likely one flight split/duplicated
        near_dup = one("""WITH s AS (
                            SELECT hex, callsign, ref_time,
                                   lag(ref_time) OVER (PARTITION BY hex, callsign ORDER BY ref_time) prev
                            FROM flights WHERE hex <> '-' AND callsign <> '-')
                          SELECT count(*) FROM s WHERE prev IS NOT NULL AND ref_time - prev < INTERVAL 30 MINUTE""")[0]
        overlap_rows = one("SELECT count(*) FROM raw WHERE Airline <> '-'")[0] - one("SELECT count(*) FROM flights")[0]
        return {"rows_identical_across_quarter_files": cross_file,
                "rows_removed_as_out_of_quarter_or_bad_time": overlap_rows,
                "exact_duplicates_after_overlap_removal": exact_in_scope,
                "same_aircraft_and_callsign_within_30min": near_dup}

    @section("classification")
    def _():
        by_month = q("""SELECT month, class, count(*) FROM resolved WHERE basis <> 'unknown' GROUP BY 1,2 ORDER BY 1,2""")
        sanity = q("""SELECT airline, class, count(*) FROM resolved WHERE basis <> 'unknown'
                      AND airline IN ('FDX','UPS','GTI','CLX','RYR','DAL','JAL','ANA') GROUP BY 1,2 ORDER BY 1,2""")
        unknown_types = q("""SELECT ac_type, count(*) n FROM resolved WHERE basis <> 'unknown' AND class = 'unknown'
                             GROUP BY 1 ORDER BY n DESC LIMIT 20""")
        return {"by_month": by_month, "airline_sanity": sanity, "unknown_top_types": unknown_types}

    @section("coverage")
    def _():
        by_cont = q("""SELECT a.continent, r.month, count(*) n,
                              round(count(*) FILTER (WHERE r.basis = 'observed') * 100.0 / count(*), 1) obs_pct,
                              round(count(*) FILTER (WHERE r.basis = 'unknown') * 100.0 / count(*), 1) unk_pct
                       FROM resolved r JOIN ap a ON a.code = coalesce(r.org, r.dst)
                       GROUP BY 1,2 ORDER BY 1,2""")
        daily = q("""WITH d AS (SELECT a.continent c, r.ref_time::DATE d_day, count(*) n
                                FROM resolved r JOIN ap a ON a.code = coalesce(r.org, r.dst) GROUP BY 1,2),
                          m AS (SELECT c, median(n) med FROM d GROUP BY 1)
                     SELECT d.c, d.d_day, d.n, round(d.n / m.med, 2) ratio FROM d JOIN m USING (c)
                     WHERE d.n < 0.8 * m.med ORDER BY ratio LIMIT 40""")
        days = q("""SELECT month, count(DISTINCT ref_time::DATE), min(ref_time::DATE), max(ref_time::DATE)
                    FROM resolved GROUP BY 1 ORDER BY 1""")
        missing_days = q("""WITH d AS (SELECT DISTINCT ref_time::DATE d_day FROM resolved),
                                 cal AS (SELECT unnest(generate_series(DATE '2026-01-01', DATE '2026-09-30', INTERVAL 1 DAY))::DATE d_day)
                            SELECT cal.d_day FROM cal LEFT JOIN d USING (d_day) WHERE d.d_day IS NULL""")
        low_days = q("""WITH d AS (SELECT ref_time::DATE d_day, count(*) n FROM resolved GROUP BY 1), m AS (SELECT median(n) med FROM d)
                        SELECT d_day, n, round(n / med, 2) FROM d, m WHERE n < 0.85 * med ORDER BY d_day""")
        return {"by_continent_month": by_cont, "low_days_by_continent": daily, "days_per_month": days,
                "missing_days": missing_days, "low_days_global": low_days}

    @section("callsign_reliability")
    def _():
        # Where an end is checkable (track ends at/near an airport AND a callsign route exists),
        # how often does the callsign route name a different airport? This is the measurable error
        # rate of the callsign route, which is the ONLY evidence for "callsign" (R4) ends.
        by_cont = q("""
          WITH s AS (
            SELECT a.continent c, r.dst_conflict conf FROM resolved r JOIN ap a ON a.code = r.dst_track
            WHERE r.val2 IS NOT NULL
            UNION ALL
            SELECT a.continent, r.org_conflict FROM resolved r JOIN ap a ON a.code = r.org_track
            WHERE r.val1 IS NOT NULL)
          SELECT c, count(*) checkable, round(avg(conf::INT) * 100, 2) pct_mismatch FROM s GROUP BY 1 ORDER BY 2 DESC""")
        by_airline = q("""
          WITH s AS (
            SELECT airline, dst_conflict conf FROM resolved WHERE dst_track IS NOT NULL AND val2 IS NOT NULL
            UNION ALL SELECT airline, org_conflict FROM resolved WHERE org_track IS NOT NULL AND val1 IS NOT NULL)
          SELECT airline, count(*) n, round(avg(conf::INT) * 100, 1) pct FROM s GROUP BY 1 HAVING count(*) > 200000 ORDER BY pct DESC""")
        r4_by_cont = q("""
          SELECT a.continent, count(*) FROM resolved r JOIN ap a ON a.code = r.org
          WHERE r.org_rule = 'R4_callsign_only' GROUP BY 1 ORDER BY 2 DESC""")
        swa_like = one("""SELECT count(*) FROM resolved WHERE airline IN ('SWA') AND basis = 'callsign'""")[0]
        return {"mismatch_rate_where_checkable_by_continent": by_cont,
                "mismatch_rate_by_airline_(n>200k_checkable_ends)": by_airline,
                "callsign_only_origins_by_continent": r4_by_cont, "SWA_flights_with_callsign_basis": swa_like}

    @section("classification_rule_issue")
    def _():
        rows = q("""SELECT ac_type, ac_type_detailed, count(*) n FROM resolved r
                    JOIN aircls c USING (ac_type, ac_type_detailed)
                    WHERE c.class = 'unknown' AND r.basis <> 'unknown'
                      AND ac_type IN ('A19N','A20N','A21N','B37M','B38M','B39M','B3XM','A338','A339','A359','A35K')
                    GROUP BY 1,2 ORDER BY n DESC LIMIT 15""")
        total = one("""SELECT count(*) FROM resolved r JOIN aircls c USING (ac_type, ac_type_detailed)
                       WHERE c.class = 'unknown' AND r.basis <> 'unknown'
                         AND ac_type IN ('A19N','A20N','A21N','B37M','B38M','B39M','B3XM','A338','A339','A359','A35K')""")[0]
        return {"flights_on_map_classified_unknown_although_passenger_only_type": total, "top": rows}

    @section("route_persistence")
    def _():
        d = ROOT / "public" / "data" / args.dataset
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        months = [m["month"] for m in manifest["months"]]
        per_route = defaultdict(lambda: [0] * len(months))
        for mi, m in enumerate(months):
            for rid, _dir, _al, p_, c_, u_, _b in json.loads((d / "months" / f"{m}.json").read_text(encoding="utf-8"))["records"]:
                per_route[rid][mi] += p_ + c_ + u_
        present = Counter(sum(1 for v in fl if v > 0) for fl in per_route.values())
        flights_by_present = Counter()
        for fl in per_route.values():
            flights_by_present[sum(1 for v in fl if v > 0)] += sum(fl)
        total = sum(flights_by_present.values())
        regular = sum(1 for fl in per_route.values() if all(v >= 4 for v in fl))
        tiny = sum(1 for fl in per_route.values() if max(fl) < 4)
        tiny_flights = sum(sum(fl) for fl in per_route.values() if max(fl) < 4)
        # Degree inflation at a sample of airports: distinct partners with any flight vs >=4/month in Aug
        aug = months.index("2026-08")
        routes = json.loads((d / "routes.json").read_text(encoding="utf-8"))
        deg_all, deg_reg = Counter(), Counter()
        for rid, a, b in routes:
            v = per_route.get(rid, [0] * len(months))[aug]
            if v > 0:
                deg_all[a] += 1; deg_all[b] += 1
            if v >= 4:
                deg_reg[a] += 1; deg_reg[b] += 1
        sample = {ap: [deg_all[ap], deg_reg[ap]] for ap in ["RJTT", "KORD", "EGLL", "EDDF", "OMDB", "LFPG", "KJFK", "WSSS"]}
        return {"routes_by_months_present": dict(sorted(present.items())),
                "flight_share_by_months_present": {k: round(v / total, 4) for k, v in sorted(flights_by_present.items())},
                "routes_with_4plus_every_month": regular, "routes_never_reaching_4_in_a_month": tiny,
                "flights_on_those_routes": tiny_flights, "total_routes": len(per_route),
                "aug_degree_all_vs_4plus": sample}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
