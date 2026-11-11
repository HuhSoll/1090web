"""
US DOT BTS T-100 Segment (All Carriers): download, manual import and parsing.

Source: https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG (TranStats, public domain
U.S. Government data). The download is the page's own form submission (one request per month,
the same fields a person would tick); nothing is scraped and no access control is bypassed.

If the automatic download stops working, download the month by hand on that page (Geography
"All", the year, the month, the FIELDS below, "Download zip") and import it:
  python pipeline/validation/bts.py import path/to/T_T100_SEGMENT_ALL_CARRIER.zip --year 2026 --month 1

Service classes (official lookup L_SERVICE_CLASS):
  F scheduled passenger/cargo   G scheduled all-cargo
  L non-scheduled civilian passenger/cargo   P non-scheduled civilian all-cargo
  (A C E H K N Q R V Z exist in the lookup; K/V/Z are sums and must never be added to F/G/L/P)
T-100 is reported by certificated U.S. carriers and by foreign carriers for flights touching the
U.S. It does not cover business aviation, general aviation or on-demand air taxis.
"""

from __future__ import annotations

import argparse
import csv
import html
import http.cookiejar
import io
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from validation import common  # noqa: E402

SOURCE = "BTS_T100_SEGMENT"
FORM_URL = "https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG&QO_fu146_anzr=Nv4%20Pn44vr45"
HOME_URL = "https://transtats.bts.gov/Homepage.asp"
FIELDS = ["YEAR", "MONTH", "ORIGIN", "DEST", "ORIGIN_COUNTRY", "DEST_COUNTRY", "ORIGIN_AIRPORT_ID",
          "DEST_AIRPORT_ID", "UNIQUE_CARRIER", "CARRIER", "CARRIER_GROUP_NEW", "CLASS", "AIRCRAFT_TYPE",
          "AIRCRAFT_CONFIG", "DEPARTURES_SCHEDULED", "DEPARTURES_PERFORMED", "SEATS", "PASSENGERS",
          "FREIGHT", "DATA_SOURCE"]
SERVICE_CLASSES = {
    "F": "Scheduled Passenger/ Cargo Service",
    "G": "Scheduled All Cargo Service",
    "L": "Non-Scheduled Civilian Passenger/ Cargo Service",
    "P": "Non-Scheduled Civilian All Cargo Service",
}
AGGREGATE_CLASSES = {"K", "V", "Z"}  # sums of other classes in the lookup; never mixed with F/G/L/P
CLASS_SETS = {
    "scheduled_pax": ("F",),
    "scheduled": ("F", "G"),
    "all_reported": ("F", "G", "L", "P"),
}
RAW_DIR = common.EXTERNAL_RAW / "bts"
USER_AGENT = "Mozilla/5.0 (compatible; 1090web-research/1.0)"


def file_name(year: int, month: int) -> str:
    return f"T100_SEGMENT_ALL_CARRIER_{year}_{month:02d}.zip"


def fetch_month(year: int, month: int, out_dir: Path = RAW_DIR, timeout: int = 300) -> Path:
    """Submit the TranStats form for one month and save the zip. Raises if the reply is not a zip."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", USER_AGENT)]
    op.open(HOME_URL, timeout=60).read()
    page = op.open(FORM_URL, timeout=60).read().decode("latin-1")
    hidden = {html.unescape(n): html.unescape(v) for n, v in
              re.findall(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', page)}
    if "__VIEWSTATE" not in hidden:
        raise RuntimeError("TranStats form not found (page layout changed?) - use the manual import")
    data = dict(hidden)
    data.update({"cboGeography": "All", "cboYear": str(year), "cboPeriod": str(month),
                 "chkDownloadZip": "on", "btnDownload": "Download"})
    for f in FIELDS:
        data[f] = "on"
    req = urllib.request.Request(FORM_URL, data=urllib.parse.urlencode(data).encode(), headers={"Referer": FORM_URL})
    with op.open(req, timeout=timeout) as r:
        body = r.read()
        ctype = r.headers.get("Content-Type", "")
    if "zip" not in ctype or not body.startswith(b"PK"):
        raise RuntimeError(f"TranStats returned {ctype!r}, not a zip - use the manual import")
    path = out_dir / file_name(year, month)
    path.write_bytes(body)
    check_zip(path, year, month)
    common.register(path, source=SOURCE, url=FORM_URL, retrieved=common.now_utc(),
                    note=f"form download: geography All, year {year}, period {month}, fields {','.join(FIELDS)}")
    return path


def import_manual(zip_path: Path, year: int, month: int, out_dir: Path = RAW_DIR) -> Path:
    """Register a zip downloaded by hand (checked for the expected columns and period)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / file_name(year, month)
    shutil.copyfile(zip_path, dest)
    check_zip(dest, year, month)
    common.register(dest, source=SOURCE, url=FORM_URL, retrieved=common.now_utc(),
                    note=f"manual import of {Path(zip_path).name}")
    return dest


def _csv_member(z: zipfile.ZipFile) -> str:
    names = [n for n in z.namelist() if n.upper().endswith(".CSV") and "DOCUMENTATION" not in n.upper()]
    if len(names) != 1:
        raise ValueError(f"expected one data CSV in the zip, found {names}")
    return names[0]


def check_zip(path: Path, year: int, month: int) -> None:
    """The file must contain the needed columns and only the requested year and month."""
    with zipfile.ZipFile(path) as z, z.open(_csv_member(z)) as fh:
        rd = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))
        missing = {"YEAR", "MONTH", "ORIGIN", "DEST", "CLASS", "DEPARTURES_PERFORMED"} - set(rd.fieldnames or [])
        if missing:
            raise ValueError(f"{path.name}: missing columns {sorted(missing)}")
        periods = {(int(r["YEAR"]), int(r["MONTH"])) for r in rd}
    if periods != {(year, month)}:
        raise ValueError(f"{path.name}: contains periods {sorted(periods)}, expected {(year, month)} only")


def _country(value: str | None):
    """T-100 reports U.S. territories (Puerto Rico, Virgin Islands, Guam, ...) as 'US'."""
    v = (value or "").strip()
    return common.US_AND_TERRITORIES if v == "US" else v


def read_zip(path: Path) -> list[common.ExternalCount]:
    """Rows -> ExternalCount (one per published row; DEPARTURES_PERFORMED as reported_flights)."""
    out = []
    with zipfile.ZipFile(path) as z, z.open(_csv_member(z)) as fh:
        for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig")):
            cls = r["CLASS"].strip()
            if cls in AGGREGATE_CLASSES:
                continue
            out.append(common.ExternalCount(
                source=SOURCE, year=int(r["YEAR"]), month=int(r["MONTH"]),
                origin_airport=r["ORIGIN"].strip(), destination_airport=r["DEST"].strip(),
                service_class=cls, reported_flights=float(r["DEPARTURES_PERFORMED"] or 0),
                carrier=(r.get("UNIQUE_CARRIER") or r.get("CARRIER") or "").strip(),
                source_version=path.name, source_reference=FORM_URL,
                origin_country=_country(r.get("ORIGIN_COUNTRY")),
                destination_country=_country(r.get("DEST_COUNTRY")),
                extra=(("aircraft_config", (r.get("AIRCRAFT_CONFIG") or "").strip()),
                       ("data_source", (r.get("DATA_SOURCE") or "").strip()),
                       ("carrier_group", (r.get("CARRIER_GROUP_NEW") or "").strip())),
            ))
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--year", type=int, required=True)
    f.add_argument("--months", required=True, help="e.g. 1,4 or 1-7")
    i = sub.add_parser("import")
    i.add_argument("zip")
    i.add_argument("--year", type=int, required=True)
    i.add_argument("--month", type=int, required=True)
    a = p.parse_args()
    if a.cmd == "fetch":
        months = []
        for part in a.months.split(","):
            lo, _, hi = part.partition("-")
            months += list(range(int(lo), int(hi or lo) + 1))
        for m in months:
            path = fetch_month(a.year, m)
            print(f"{path.name}: {path.stat().st_size} bytes, sha256 {common.sha256_file(path)[:16]}…")
    else:
        path = import_manual(Path(a.zip), a.year, a.month)
        print(f"imported {path}")


if __name__ == "__main__":
    main()
