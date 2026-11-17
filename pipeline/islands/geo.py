"""Small geometry helpers for the island lab (no GIS dependencies)."""

from __future__ import annotations

import math

import numpy as np

EARTH_R = 6371008.8


def mesh_bounds(code: str) -> tuple[float, float, float, float]:
    """Japanese standard grid square -> (south, west, dlat, dlon) in degrees.

    8 digits = 3rd level (1 km), 9 = 4th level (500 m, half), 10 = 5th level (250 m, quarter).
    The 4th and 5th level digit is 1 SW, 2 SE, 3 NW, 4 NE.
    """
    if len(code) not in (8, 9, 10) or not code.isdigit():
        raise ValueError(f"not a 3rd/4th/5th level mesh code: {code}")
    lat = int(code[0:2]) / 1.5
    lon = int(code[2:4]) + 100.0
    lat += int(code[4]) * 5 / 60
    lon += int(code[5]) * 7.5 / 60
    lat += int(code[6]) * 30 / 3600
    lon += int(code[7]) * 45 / 3600
    dlat, dlon = 30 / 3600, 45 / 3600
    for d in code[8:]:
        q = int(d)
        if q not in (1, 2, 3, 4):
            raise ValueError(f"bad subdivision digit in {code}")
        dlat, dlon = dlat / 2, dlon / 2
        if q in (3, 4):
            lat += dlat
        if q in (2, 4):
            lon += dlon
    return lat, lon, dlat, dlon


def mesh_samples(code: str) -> np.ndarray:
    """Nine points of a mesh (centre, corners inset by 10 %, edge midpoints) as [[lon, lat], ...]."""
    s, w, dlat, dlon = mesh_bounds(code)
    fr = (0.1, 0.5, 0.9)
    return np.array([[w + fx * dlon, s + fy * dlat] for fy in fr for fx in fr])


def haversine_m(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(np.minimum(1.0, a)))


class Polygon:
    """Even-odd polygon (outer ring and holes) in lon/lat."""

    def __init__(self, rings: list[list[list[float]]]):
        self.rings = [np.asarray(r, dtype=float)[:, :2] for r in rings if len(r) >= 4]
        allp = np.concatenate(self.rings)
        self.bbox = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())

    def area_km2(self) -> float:
        """Approximate area (equirectangular around the polygon), outer minus holes."""
        lat0 = math.radians((self.bbox[1] + self.bbox[3]) / 2)
        tot = 0.0
        for i, r in enumerate(self.rings):
            x = np.radians(r[:, 0]) * math.cos(lat0) * EARTH_R / 1000
            y = np.radians(r[:, 1]) * EARTH_R / 1000
            a = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
            tot += a if i == 0 else -a
        return tot

    def contains(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, dtype=float).reshape(-1, 2)
        x, y = pts[:, 0], pts[:, 1]
        b = self.bbox
        out = np.zeros(len(pts), dtype=bool)
        cand = (x >= b[0]) & (x <= b[2]) & (y >= b[1]) & (y <= b[3])
        if not cand.any():
            return out
        cx, cy = x[cand], y[cand]
        inside = np.zeros(len(cx), dtype=bool)
        for r in self.rings:
            x1, y1 = r[:-1, 0], r[:-1, 1]
            x2, y2 = r[1:, 0], r[1:, 1]
            for j in range(0, len(x1), 4096):  # chunks keep memory small for long rings
                a1, b1, a2, b2 = x1[j:j + 4096], y1[j:j + 4096], x2[j:j + 4096], y2[j:j + 4096]
                cond = (b1[None, :] > cy[:, None]) != (b2[None, :] > cy[:, None])
                with np.errstate(divide="ignore", invalid="ignore"):
                    xi = a1[None, :] + (cy[:, None] - b1[None, :]) * (a2 - a1)[None, :] / (b2 - b1)[None, :]
                hit = cond & (cx[:, None] < xi)
                inside ^= (hit.sum(axis=1) % 2).astype(bool)
        out[np.where(cand)[0]] = inside
        return out


def simplify(coords: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker in degrees (iterative), keeps the end points."""
    p = np.asarray(coords, dtype=float)
    n = len(p)
    if n <= 2:
        return p.tolist()
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = p[i], p[j]
        seg = b - a
        L = float(np.hypot(*seg))
        q = p[i + 1:j] - a
        d = np.abs(seg[0] * q[:, 1] - seg[1] * q[:, 0]) / L if L > 0 else np.hypot(q[:, 0], q[:, 1])
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return p[keep].tolist()
