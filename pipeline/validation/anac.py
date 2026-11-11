"""
Brazil ANAC open data: download, registration and parsing.

Two official files are used (https://sistemas.anac.gov.br/dadosabertos/):

1. Dados Estatísticos do Transporte Aéreo (Dados_Estatisticos.csv): monthly totals per company
   and airport pair, with DECOLAGENS (take-offs), NATUREZA (DOMÉSTICA / INTERNACIONAL) and
   GRUPO_DE_VOO (REGULAR / NÃO REGULAR / IMPRODUTIVO). Brazilian companies report all their
   flights; foreign companies report flights to/from Brazil.
2. VRA - Voo Regular Ativo (VRA_<yyyy><m>.csv): one row per scheduled flight with its status
   (REALIZADO = operated, CANCELADO = cancelled, ...). Scheduled (regular) services only.

Both use ICAO airport codes. Times in VRA are local; the month is taken from the actual
departure (Partida Real), else the scheduled one.
"""

from __future__ import annotations

import argparse
import csv
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from validation import common  # noqa: E402

BASE = "https://sistemas.anac.gov.br/dadosabertos/Voos e operações aéreas/"
STATS_URL = BASE + "Dados Estatísticos do Transporte Aéreo/Dados_Estatisticos.csv"
VRA_URL = BASE + "Voo Regular Ativo (VRA)/{year}/{folder}/VRA_{year}{month}.csv"
MONTH_FOLDERS = {1: "01 - Janeiro", 2: "02 - Fevereiro", 3: "03 - Março", 4: "04 - Abril", 5: "05 - Maio",
                 6: "06 - Junho", 7: "07 - Julho", 8: "08 - Agosto", 9: "09 - Setembro", 10: "10 - Outubro",
                 11: "11 - Novembro", 12: "12 - Dezembro"}
RAW_DIR = common.EXTERNAL_RAW / "anac"
USER_AGENT = "Mozilla/5.0 (compatible; 1090web-research/1.0)"
SOURCE_STATS = "ANAC_DADOS_ESTATISTICOS"
SOURCE_VRA = "ANAC_VRA"
BRAZIL = "BR"


def _quote(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(parts.path)))


def _download(url: str, dest: Path, source: str, note: str) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(_quote(url), headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=600) as r, tmp.open("wb") as fh:
        while chunk := r.read(1 << 20):
            fh.write(chunk)
    tmp.replace(dest)
    common.register(dest, source=source, url=url, retrieved=common.now_utc(), note=note)
    return dest


def fetch_vra(year: int, month: int) -> Path:
    url = VRA_URL.format(year=year, folder=MONTH_FOLDERS[month], month=month)
    return _download(url, RAW_DIR / f"VRA_{year}{month}.csv", SOURCE_VRA, "Voo Regular Ativo, monthly file")


def fetch_stats() -> Path:
    return _download(STATS_URL, RAW_DIR / "Dados_Estatisticos.csv", SOURCE_STATS,
                     "Dados Estatísticos do Transporte Aéreo (all years; only the requested year is read)")


def _rows(path: Path):
    """Semicolon CSV with a first line 'Atualizado em: ...' before the header."""
    with Path(path).open(encoding="utf-8-sig", newline="") as fh:
        first = fh.readline()
        updated = first.split(":", 1)[1].strip() if first.lower().startswith("atualizado") else ""
        if not updated:
            fh.seek(0)
        for r in csv.DictReader(fh, delimiter=";"):
            yield updated, r


def read_stats(path: Path, year: int) -> list[common.ExternalCount]:
    """Dados Estatísticos rows of one year -> ExternalCount (DECOLAGENS as reported_flights).
    service_class = '<NATUREZA>/<GRUPO_DE_VOO>' as published."""
    acc: dict[tuple, float] = defaultdict(float)
    version = ""
    for updated, r in _rows(path):
        if r.get("ANO") != str(year):
            continue
        version = updated
        dec = float((r.get("DECOLAGENS") or "0").replace(",", ".") or 0)
        key = (int(r["MES"]), r["AEROPORTO_DE_ORIGEM_SIGLA"].strip(), r["AEROPORTO_DE_DESTINO_SIGLA"].strip(),
               r["EMPRESA_SIGLA"].strip(), f'{r["NATUREZA"].strip()}/{r["GRUPO_DE_VOO"].strip()}',
               r.get("EMPRESA_NACIONALIDADE", "").strip())
        acc[key] += dec
    out = []
    for (m, o, d, carrier, cls, nat), n in sorted(acc.items()):
        out.append(common.ExternalCount(
            source=SOURCE_STATS, year=year, month=m, origin_airport=o, destination_airport=d,
            service_class=cls, reported_flights=n, carrier=carrier,
            source_version=f"Dados_Estatisticos.csv, atualizado em {version}", source_reference=STATS_URL,
            extra=(("company_nationality", nat),)))
    return out


def read_vra(path: Path, statuses: tuple[str, ...] = ("REALIZADO",)) -> list[common.ExternalCount]:
    """VRA flights with the given status, counted per month / route / company / line type."""
    acc: dict[tuple, float] = defaultdict(float)
    version = ""
    for updated, r in _rows(path):
        version = updated
        status = (r.get("Situação Voo") or "").strip().upper()
        if status not in statuses:
            continue
        t = (r.get("Partida Real") or "").strip() or (r.get("Partida Prevista") or "").strip()
        if len(t) < 7:
            continue
        key = (int(t[:4]), int(t[5:7]), r["ICAO Aeródromo Origem"].strip(), r["ICAO Aeródromo Destino"].strip(),
               r["ICAO Empresa Aérea"].strip(), (r.get("Código Tipo Linha") or "").strip())
        acc[key] += 1
    return [common.ExternalCount(source=SOURCE_VRA, year=y, month=m, origin_airport=o, destination_airport=d,
                                 service_class=line, reported_flights=n, carrier=c,
                                 source_version=f"{Path(path).name}, atualizado em {version}",
                                 source_reference=VRA_URL)
            for (y, m, o, d, c, line), n in sorted(acc.items())]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("fetch-vra")
    v.add_argument("--year", type=int, required=True)
    v.add_argument("--months", required=True)
    sub.add_parser("fetch-stats")
    a = p.parse_args()
    if a.cmd == "fetch-vra":
        months = []
        for part in a.months.split(","):
            lo, _, hi = part.partition("-")
            months += list(range(int(lo), int(hi or lo) + 1))
        for m in months:
            path = fetch_vra(a.year, m)
            print(f"{path.name}: {path.stat().st_size} bytes")
    else:
        path = fetch_stats()
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
