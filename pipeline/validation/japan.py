"""
Japan MLIT air transport statistics (航空輸送統計調査, 速報 / monthly flash), via e-Stat.

What the monthly flash contains (checked for 2026-08, published 2026-10-29):
- sheet 3-1: national totals for Japanese air carriers - 運航回数 (flights operated) for
  国内定期 (domestic scheduled: 幹線 trunk + ローカル local), 国内その他 (domestic other) and
  国際 (international, Japanese carriers only).
- sheets 3-2 / 3-3: passengers and cargo by route / region. No flight counts per route.
So only NATIONAL DOMESTIC FLIGHT TOTALS are comparable with the ADS-B data. Passenger numbers
are a different measure and are not compared. Airport-level landing counts (空港管理状況調書)
are annual; the Tokyo Civil Aviation Bureau's monthly airport summary has passengers and cargo
only (checked 2026-04 file), so neither is used.

Files are e-Stat downloads (file-download?statInfId=...&fileKind=0). The table id per month is
read from the e-Stat list page of that month.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from validation import common  # noqa: E402

SOURCE = "MLIT_AIR_TRANSPORT_FLASH"
LIST_URL = ("https://www.e-stat.go.jp/stat-search/files?page=1&layout=datalist&cycle=1&toukei=00600360"
            "&tstat=000001136503&tclass1val=0&year={year}0&month={code}&result_back=1")
FILE_URL = "https://www.e-stat.go.jp/stat-search/file-download?statInfId={sid}&fileKind=0"
# e-Stat month parameter for this table (taken from the list page links, 2026)
MONTH_CODES = {1: "11010301", 2: "11010302", 3: "11010303", 4: "12040604", 5: "12040605",
               6: "12040606", 7: "23070907", 8: "23070908", 9: "23070909", 10: "34101010",
               11: "34101011", 12: "34101012"}
RAW_DIR = common.EXTERNAL_RAW / "mlit"
USER_AGENT = "Mozilla/5.0 (compatible; 1090web-research/1.0)"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def fetch_month(year: int, month: int) -> Path:
    req = urllib.request.Request(LIST_URL.format(year=year, code=MONTH_CODES[month]), headers={"User-Agent": USER_AGENT})
    page = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    if f"{year}年{month}月" not in page:
        raise RuntimeError(f"e-Stat list for {year}-{month:02d} not found (not published yet?)")
    sids = re.findall(r"statInfId=(\d+)&(?:amp;)?fileKind=0", page)
    if len(set(sids)) != 1:
        raise RuntimeError(f"expected one Excel table for {year}-{month:02d}, found {sorted(set(sids))}")
    url = FILE_URL.format(sid=sids[0])
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = RAW_DIR / f"koku_sokuho_{year}_{month:02d}.xlsx"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    body = urllib.request.urlopen(req, timeout=120).read()
    if not body.startswith(b"PK"):
        raise RuntimeError(f"{url} did not return an xlsx file")
    dest.write_bytes(body)
    common.register(dest, source=SOURCE, url=url, retrieved=common.now_utc(),
                    note=f"航空輸送統計速報 {year}年{month}月 (e-Stat statInfId {sids[0]})")
    return dest


def read_xlsx(path: Path) -> dict[str, list[list[str]]]:
    """Minimal xlsx reader (standard library): sheet name -> rows of cell strings."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                # phonetic readings (rPh) are not part of the text
                shared.append("".join(t.text or "" for r in si if r.tag != f"{{{NS['m']}}}rPh"
                                      for t in r.iter(f"{{{NS['m']}}}t")))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        out = {}
        for s in wb.find("m:sheets", NS):
            rid = s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            name = "xl/" + target[rid].lstrip("/").removeprefix("xl/")
            rows = []
            for row in ET.fromstring(z.read(name)).find("m:sheetData", NS):
                vals = []
                for c in row:
                    v = c.find("m:v", NS)
                    if v is None:
                        is_ = c.find("m:is", NS)
                        vals.append("".join(t.text or "" for t in is_.iter(f"{{{NS['m']}}}t")) if is_ is not None else "")
                        continue
                    vals.append(shared[int(v.text)] if c.get("t") == "s" else v.text)
                rows.append(vals)
            out[s.get("name")] = rows
    return out


def national_flights(path: Path) -> dict[str, int]:
    """運航回数 from sheet 3-1: domestic scheduled (total, trunk, local), domestic other, international."""
    sheets = read_xlsx(path)
    name = next(n for n in sheets if n.replace("－", "-").replace("３", "3").replace("１", "1") == "3-1")
    for row in sheets[name]:
        label = next((i for i, x in enumerate(row) if x.strip().startswith("運航回数")), None)
        if label is not None:
            # the layout varies between months (leading empty columns): take the numbers after the label
            nums = [int(float(x)) for x in row[label + 1:] if x.strip().replace(".", "", 1).isdigit()][:5]
            if len(nums) != 5:
                raise ValueError(f"{path.name}: unexpected 運航回数 row {row}")
            return {"domestic_scheduled": nums[0], "domestic_scheduled_trunk": nums[1],
                    "domestic_scheduled_local": nums[2], "domestic_other": nums[3], "international": nums[4]}
    raise ValueError(f"{path.name}: 運航回数 row not found in sheet {name}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--months", required=True)
    a = p.parse_args()
    months = []
    for part in a.months.split(","):
        lo, _, hi = part.partition("-")
        months += list(range(int(lo), int(hi or lo) + 1))
    for m in months:
        path = fetch_month(a.year, m)
        print(path.name, national_flights(path))


if __name__ == "__main__":
    main()
