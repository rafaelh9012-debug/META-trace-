#!/usr/bin/env python3
"""Build data/globe-pack.json: the vector data the globe draws, inline in the HTML.

Standard library only. By default it uses what the repository already contains:

  data/world-source.geojson   Natural Earth 1:110m admin-0 countries (public domain)
  data/sources/zone.tab       IANA time-zone table with one reference city per zone region (public domain)

and derives the coastline and the national borders from the country polygons (an edge that two country rings share is
a border; an edge only one ring has is coast; edges that lie on the antimeridian or on the pole are neither).

Optional inputs let you rebuild the pack from richer Natural Earth GeoJSON at any scale (1:110m, 1:50m, 1:10m). That is
the supported way to get a more detailed global basemap; it needs files this repository does not contain:

  --countries FILE     ne_*_admin_0_countries.geojson (polygons; also gives country labels)
  --coastline FILE     ne_*_coastline.geojson
  --borders FILE       ne_*_admin_0_boundary_lines_land.geojson (otherwise derived)
  --admin1 FILE        ne_*_admin_1_states_provinces_lines.geojson
  --lakes FILE         ne_*_lakes.geojson
  --rivers FILE        ne_*_rivers_lake_centerlines.geojson
  --roads FILE         ne_*_roads.geojson
  --railroads FILE     ne_*_railroads.geojson
  --places FILE        ne_*_populated_places_simple.geojson
  --simplify DEGREES   Douglas-Peucker tolerance for line and ring layers (0 = off)
  --max-inline-mb N    refuse to write a pack larger than this (default 8): bigger data belongs in a .pmtiles package

Coordinates are stored as integers in units of 1e-4 degree (about 11 m), the precision Natural Earth 1:110m already has.
Nothing is invented: every vertex comes from an input file.
"""
import argparse, hashlib, json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
Q = 10000
DATELINE = 180 * Q
POLE = 90 * Q


def q(v):
    return int(round(v * Q))


def read_features(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if data.get('type') == 'FeatureCollection':
        return data['features']
    if data.get('type') == 'Feature':
        return [data]
    raise SystemExit(f'{path}: not a GeoJSON FeatureCollection')


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def polygon_rings(feature):
    """Yield (is_outer, ring) for every ring of a Polygon or MultiPolygon, rings as lists of (x, y) in 1e-4 degree."""
    g = feature.get('geometry') or {}
    polys = [g['coordinates']] if g.get('type') == 'Polygon' else g['coordinates'] if g.get('type') == 'MultiPolygon' else []
    for poly in polys:
        for i, ring in enumerate(poly):
            pts = [(q(c[0]), q(c[1])) for c in ring]
            if len(pts) >= 4:
                yield i == 0, pts


def line_strings(feature):
    g = feature.get('geometry') or {}
    lines = [g['coordinates']] if g.get('type') == 'LineString' else g['coordinates'] if g.get('type') == 'MultiLineString' else []
    for line in lines:
        pts = [(q(c[0]), q(c[1])) for c in line]
        if len(pts) >= 2:
            yield pts


def simplify(points, tol_units, closed=False):
    """Douglas-Peucker, iterative. tol_units is in 1e-4 degree. Keeps the end points."""
    if tol_units <= 0 or len(points) <= (4 if closed else 2):
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    t2 = tol_units * tol_units
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if den == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, idx = d, i
        if best > t2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    out = [p for p, k in zip(points, keep) if k]
    return out if len(out) >= (4 if closed else 2) else points


def flat(points):
    out = []
    for x, y in points:
        out.append(x)
        out.append(y)
    return out


def derive_coast_and_borders(rings):
    """rings: list of closed rings (x, y). Returns (coast_lines, border_lines)."""
    counts = {}
    for ring in rings:
        for a, b in zip(ring, ring[1:]):
            k = (a, b) if a <= b else (b, a)
            counts[k] = counts.get(k, 0) + 1

    def skip(a, b):
        return (abs(a[0]) == DATELINE and abs(b[0]) == DATELINE) or (abs(a[1]) == POLE and abs(b[1]) == POLE)

    emitted = set()
    coast, borders = [], []
    for ring in rings:
        run, kind = [], None
        for a, b in zip(ring, ring[1:]):
            k = (a, b) if a <= b else (b, a)
            if skip(a, b):
                c = None
            elif counts[k] >= 2:
                c = 'border' if k not in emitted else None
                if c:
                    emitted.add(k)
            else:
                c = 'coast'
            if c != kind or (run and run[-1] != a):
                if run and kind:
                    (coast if kind == 'coast' else borders).append(run)
                run, kind = ([a, b] if c else []), c
            elif c:
                run.append(b)
        if run and kind:
            (coast if kind == 'coast' else borders).append(run)
    return coast, borders


def tz_places(path):
    """One reference city per time-zone region from the IANA zone table. This is NOT a ranking of the largest cities."""
    out = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        cols = line.split('\t')
        if len(cols) < 3:
            continue
        cc, coord, zone = cols[0], cols[1], cols[2]
        i = max(coord.rfind('+'), coord.rfind('-'))
        lat_s, lon_s = coord[:i], coord[i:]

        def dms(s, deg_digits):
            sign = -1 if s[0] == '-' else 1
            body = s[1:]
            d = int(body[:deg_digits])
            m = int(body[deg_digits:deg_digits + 2])
            sec = int(body[deg_digits + 2:deg_digits + 4]) if len(body) > deg_digits + 2 else 0
            return sign * (d + m / 60 + sec / 3600)

        lat, lon = dms(lat_s, 2), dms(lon_s, 3)
        name = zone.split('/')[-1].replace('_', ' ')
        out.append((round(lon, 4), round(lat, 4), name, cc))
    return out


def country_labels(features):
    out = []
    for f in features:
        p = f.get('properties') or {}
        name = p.get('NAME') or p.get('NAME_EN') or p.get('name') or p.get('ADMIN')
        if not name:
            continue
        lon, lat = p.get('LABEL_X'), p.get('LABEL_Y')
        if lon is None or lat is None:
            continue
        out.append([round(float(lon), 4), round(float(lat), 4), name, int(p.get('POP_EST') or 0)])
    out.sort(key=lambda r: -r[3])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--countries', default=str(ROOT / 'data' / 'world-source.geojson'))
    ap.add_argument('--coastline')
    ap.add_argument('--borders')
    ap.add_argument('--admin1')
    ap.add_argument('--lakes')
    ap.add_argument('--rivers')
    ap.add_argument('--roads')
    ap.add_argument('--railroads')
    ap.add_argument('--places')
    ap.add_argument('--zone-tab', default=str(ROOT / 'data' / 'sources' / 'zone.tab'))
    ap.add_argument('--scale', default='1:110m', help='label recorded in the pack (informational)')
    ap.add_argument('--simplify', type=float, default=0.0)
    ap.add_argument('--max-inline-mb', type=float, default=8.0)
    ap.add_argument('--out', default=str(ROOT / 'data' / 'globe-pack.json'))
    args = ap.parse_args(argv)
    tol = args.simplify * Q
    t0 = time.time()
    sources = []

    def note(name, path, count):
        sources.append({'layer': name, 'file': Path(path).name, 'sha256': sha256(path), 'features': count})

    countries = read_features(args.countries)
    note('countries', args.countries, len(countries))
    outer, every = [], []
    for f in countries:
        for is_outer, ring in polygon_rings(f):
            every.append(ring)
            if is_outer:
                outer.append(ring)
    layers = {}
    layers['land'] = {'kind': 'polygon', 'rings': [flat(simplify(r, tol, True)) for r in outer]}

    if args.coastline:
        feats = read_features(args.coastline)
        note('coast', args.coastline, len(feats))
        coast = [l for f in feats for l in line_strings(f)]
        derived_borders = None
    else:
        coast, derived_borders = derive_coast_and_borders(every)
    layers['coast'] = {'kind': 'line', 'lines': [flat(simplify(l, tol)) for l in coast]}
    if args.borders:
        feats = read_features(args.borders)
        note('borders', args.borders, len(feats))
        borders = [l for f in feats for l in line_strings(f)]
    elif derived_borders is not None:
        borders = derived_borders
    else:
        _, borders = derive_coast_and_borders(every)
    layers['borders'] = {'kind': 'line', 'lines': [flat(simplify(l, tol)) for l in borders]}

    def add_lines(name, path, rank_keys=('scalerank', 'SCALERANK')):
        feats = read_features(path)
        note(name, path, len(feats))
        lines, ranks = [], []
        for f in feats:
            p = f.get('properties') or {}
            r = next((int(p[k]) for k in rank_keys if p.get(k) is not None), 5)
            for l in line_strings(f):
                lines.append(flat(simplify(l, tol)))
                ranks.append(r)
        layers[name] = {'kind': 'line', 'lines': lines, 'ranks': ranks}

    if args.admin1:
        add_lines('admin1', args.admin1)
    if args.rivers:
        add_lines('rivers', args.rivers)
    if args.roads:
        add_lines('roads', args.roads)
    if args.railroads:
        add_lines('rail', args.railroads)
    if args.lakes:
        feats = read_features(args.lakes)
        note('lakes', args.lakes, len(feats))
        layers['lakes'] = {'kind': 'polygon', 'rings': [flat(simplify(ring, tol, True)) for f in feats for is_outer, ring in polygon_rings(f) if is_outer]}

    if args.places:
        feats = read_features(args.places)
        note('places', args.places, len(feats))
        items = []
        for f in feats:
            p = f.get('properties') or {}
            g = f.get('geometry') or {}
            if g.get('type') != 'Point':
                continue
            name = p.get('nameascii') or p.get('NAME') or p.get('name')
            if not name:
                continue
            rank = p.get('scalerank', p.get('SCALERANK'))
            items.append([round(g['coordinates'][0], 4), round(g['coordinates'][1], 4), name, 'ne', int(rank if rank is not None else 8), int(p.get('pop_max') or p.get('POP_MAX') or 0)])
        layers['places'] = {'kind': 'point', 'items': items, 'basis': 'Natural Earth populated places'}
    else:
        note('places', args.zone_tab, 0)
        items = [[lon, lat, name, cc, 5, 0] for lon, lat, name, cc in tz_places(args.zone_tab)]
        sources[-1]['features'] = len(items)
        layers['places'] = {'kind': 'point', 'items': items, 'basis': 'IANA time-zone reference cities: one city per zone region, not a ranking of the largest cities'}

    pack = {
        'format': 'meta-trace-globe-pack', 'version': 1, 'scale': args.scale, 'precision': Q,
        'built': time.strftime('%Y-%m-%d', time.gmtime()),
        'attribution': 'Natural Earth (public domain). Reference cities: IANA time zone database (public domain).',
        'layers': layers,
        'countryLabels': country_labels(countries),
        'sources': sources,
    }
    text = json.dumps(pack, ensure_ascii=True, separators=(',', ':'))
    mb = len(text.encode()) / 1e6
    if mb > args.max_inline_mb:
        raise SystemExit(f'The pack would be {mb:.1f} MB, over the {args.max_inline_mb} MB inline limit. Simplify it (--simplify 0.01) '
                         'or build a .pmtiles package with tools/make_pmtiles.py instead.')
    Path(args.out).write_text(text, encoding='utf-8')
    verts = {k: (sum(len(r) // 2 for r in v.get('rings', [])) + sum(len(l) // 2 for l in v.get('lines', [])) + len(v.get('items', []))) for k, v in layers.items()}
    print(f'Wrote {args.out}: {len(text.encode()):,} bytes in {time.time() - t0:.1f} s')
    for k, v in verts.items():
        print(f'  {k:8s} {v:>9,} vertices/points')
    print(f'  country labels {len(pack["countryLabels"])}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
