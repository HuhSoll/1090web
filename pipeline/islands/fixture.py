"""Write tests/islands/crosscheck.fixture.json: Python results that src/islands/access.ts must reproduce.

  python pipeline/islands/fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import access as X  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PUB = ROOT / "public" / "data" / "islands" / "okinawa-pilot"

SCENARIOS = [
    ({}, {"stopped_airports": ["ROIG"]}),
    ({"service_level": "daily"}, {"service_level": "daily", "stopped_airports": ["ROMY"]}),
    ({}, {"stopped_airports": ["RORS"]}),
    ({"bridges": False}, {"bridges": False, "stopped_airports": ["RORS"]}),
    ({"destination": "tokyo"}, {"destination": "tokyo", "stopped_airports": ["ROMY"]}),
    ({"destination": "fukuoka", "service_level": "weekly"}, {"destination": "fukuoka", "service_level": "weekly", "stopped_airports": ["ROYN"]}),
    ({"sea": False}, {"sea": False, "stopped_airports": ["ROMD"]}),
    ({"air": False}, {"air": False}),
    ({}, {"stopped_services": ["S_HIRARA_TARAMA"]}),
    ({"include_seasonal": True, "destination": "fukuoka"}, {"include_seasonal": True, "destination": "fukuoka", "stopped_airports": ["ROIG"]}),
]


def main() -> None:
    net = json.loads((PUB / "network.json").read_text(encoding="utf-8"))
    me = json.loads((PUB / "meshes.json").read_text(encoding="utf-8"))
    cases = []
    for b, a in SCENARIOS:
        r = X.compare(net, me, X.Scenario(**b), X.Scenario(**a))
        ea = X.evaluate(net, me, X.Scenario(**a))
        sample = []
        for i in range(0, len(me["rows"]), 23):
            e = ea[i]
            sample.append([i, e["status"], e.get("time"), e.get("bound"), e.get("legs"), e.get("minFreq"), e.get("board"), r_change(r, me, i)])
        cases.append({"base": b, "after": a, "totals": r["totals"], "sample": sample})
    out = ROOT / "tests" / "islands" / "crosscheck.fixture.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"note": "written by pipeline/islands/fixture.py", "cases": cases}, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print("cases", len(cases), "->", out.relative_to(ROOT))


def r_change(r: dict, me: dict, i: int):
    code = me["rows"][i][0]
    for row in r["rows"]:
        if row[0] == code:
            return row[5]
    return None


if __name__ == "__main__":
    main()
