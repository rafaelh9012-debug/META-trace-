#!/usr/bin/env python3
"""Turn GeoJSON in this app's street format into a PMTiles v3 package of vector tiles (standard library only).

This is the converter that made the size and speed measurements in docs/MAP_DATA.md, and the way to turn the bundled
Gainesville data (data/map-data.json) into a package that the "Map data" dialog accepts. It is NOT a general OpenStreetMap
pipeline. For a real region, cut a package out of a Protomaps basemap build instead (docs/MAP_DATA.md); the app reads that
schema too.

Input: a GeoJSON FeatureCollection whose features carry properties.kind, one of
    road (LineString; properties.highway), building, green, parking, paved, water (Polygon),
    barrier (LineString), tree, furniture, bus, poi (Point; properties.type is the OSM value)
and optionally properties.name. Coordinates are WGS84 longitude, latitude.

Output tiles use the Protomaps layer vocabulary (roads, buildings, landuse, water, barriers, pois) with the extra property
"mt_kind" on points so the app draws exactly the kind the source had. Tiles are Mapbox Vector Tile 2.1, gzip-compressed,
extent 4096, buffer 64. Lower zoom levels are generalised: small or minor features are left out and lines are simplified
(Douglas-Peucker, half a pixel of a 512 px tile); the top zoom level is not simplified. Everything written comes from the
input; nothing is invented.

    python3 tools/make_pmtiles.py data/map-data.json -o gainesville.pmtiles --name "Gainesville (bundled data)" \\
        --attribution "(c) OpenStreetMap contributors" --license "ODbL 1.0"
"""
import argparse, gzip, hashlib, json, math, struct, sys, time
from pathlib import Path

EXTENT = 4096
BUFFER = 64
ROOT_BUDGET = 16384 - 127           # the header and root directory should fit the first 16 KiB request

# First tile zoom at which each road class is written (the app styles show them from about one map zoom later).
ROAD_MIN_Z = {'motorway': 6, 'trunk': 7, 'primary': 9, 'secondary': 10, 'tertiary': 11, 'residential': 12, 'unclassified': 12,
              'living_street': 13, 'construction': 13, 'service': 14, 'pedestrian': 14, 'track': 14, 'footway': 14, 'path': 14,
              'cycleway': 14, 'steps': 15, 'corridor': 15, 'elevator': 15, 'bus_stop': 15}
MIN_Z = {'building': 12, 'green': 11, 'parking': 13, 'paved': 13, 'water': 10, 'barrier': 15, 'point': 15}
MAJOR = {'motorway': 'major_road', 'trunk': 'major_road', 'primary': 'major_road', 'secondary': 'medium_road', 'tertiary': 'medium_road',
         'residential': 'minor_road', 'unclassified': 'minor_road', 'living_street': 'minor_road', 'service': 'other',
         'footway': 'path', 'path': 'path', 'cycleway': 'path', 'steps': 'path', 'pedestrian': 'path', 'track': 'other'}
FURNITURE = {'crossing', 'bench', 'street_lamp', 'waste_basket', 'bicycle_parking', 'drinking_water', 'fountain', 'traffic_signals'}
LAYER_OF = {'road': 'roads', 'building': 'buildings', 'green': 'landuse', 'parking': 'landuse', 'paved': 'landuse', 'water': 'water',
            'barrier': 'barriers', 'tree': 'pois', 'furniture': 'pois', 'bus': 'pois', 'poi': 'pois'}
LANDUSE_KIND = {'green': 'park', 'parking': 'parking', 'paved': 'paved'}

# ---- projection and tiles --------------------------------------------------------------------------------------------
def world(lon, lat):
    """Web Mercator in the unit square (x east, y south)."""
    lat = max(-85.05112878, min(85.05112878, lat))
    s = math.sin(math.radians(lat))
    return (lon + 180.0) / 360.0, 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)

def hilbert_id(z, x, y):
    """The PMTiles tile id: tiles of lower zooms first, each zoom in Hilbert-curve order."""
    acc = (4 ** z - 1) // 3
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = n - 1 - x
                y = n - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d

# ---- geometry --------------------------------------------------------------------------------------------------------
def clip_line(pts, lo, hi):
    """Liang-Barsky against the square [lo, hi]; returns the pieces that are inside."""
    out, cur = [], None
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        dx, dy = x1 - x0, y1 - y0
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, x0 - lo), (dx, hi - x0), (-dy, y0 - lo), (dy, hi - y0)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    if r > t1: ok = False; break
                    if r > t0: t0 = r
                else:
                    if r < t0: ok = False; break
                    if r < t1: t1 = r
        if not ok:
            if cur and len(cur) > 1: out.append(cur)
            cur = None
            continue
        a = (x0 + t0 * dx, y0 + t0 * dy)
        b = (x0 + t1 * dx, y0 + t1 * dy)
        if cur is None or t0 > 0:
            if cur and len(cur) > 1: out.append(cur)
            cur = [a]
        cur.append(b)
        if t1 < 1:
            out.append(cur)
            cur = None
    if cur and len(cur) > 1: out.append(cur)
    return out

def clip_ring(ring, lo, hi):
    """Sutherland-Hodgman against the square [lo, hi]."""
    def side(pts, inside, cross):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia: out.append(cross(a, b))
                out.append(b)
            elif ia:
                out.append(cross(a, b))
        return out
    def at_x(v):
        return lambda a, b: (v, a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]))
    def at_y(v):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]), v)
    pts = ring
    for inside, cross in ((lambda p: p[0] >= lo, at_x(lo)), (lambda p: p[0] <= hi, at_x(hi)), (lambda p: p[1] >= lo, at_y(lo)), (lambda p: p[1] <= hi, at_y(hi))):
        if not pts: return []
        pts = side(pts, inside, cross)
    return pts

def simplify(pts, tol, closed=False):
    """Douglas-Peucker without recursion."""
    n = len(pts)
    if tol <= 0 or n < 3: return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best: best, idx = d, i
        if best > t2:
            keep[idx] = True
            stack.append((a, idx)); stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]

def quantise(pts):
    out = []
    for x, y in pts:
        p = (int(round(x)), int(round(y)))
        if not out or p != out[-1]: out.append(p)
    return out

def signed_area(ring):
    return sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring))) / 2.0

# ---- protobuf / MVT ------------------------------------------------------------------------------------------------
def varint(n):
    out = bytearray()
    n &= 0xFFFFFFFFFFFFFFFF
    while True:
        b = n & 0x7F
        n >>= 7
        if n: out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def zigzag(n):
    return (n << 1) ^ (n >> 31)

def field(num, wire, payload):
    return varint((num << 3) | wire) + payload

def lendelim(num, data):
    return field(num, 2, varint(len(data)) + data)

def encode_geometry(kind, parts):
    cmds, cx, cy = [], 0, 0
    def move_line(pts, closed):
        nonlocal cx, cy
        x, y = pts[0]
        cmds.extend([(1 & 7) | (1 << 3), zigzag(x - cx), zigzag(y - cy)])
        cx, cy = x, y
        if len(pts) > 1:
            cmds.append(2 | ((len(pts) - 1) << 3))
            for x, y in pts[1:]:
                cmds.extend([zigzag(x - cx), zigzag(y - cy)])
                cx, cy = x, y
        if closed: cmds.append(7 | (1 << 3))
    if kind == 1:
        cmds.append(1 | (len(parts) << 3))
        for x, y in parts:
            cmds.extend([zigzag(x - cx), zigzag(y - cy)])
            cx, cy = x, y
    elif kind == 2:
        for line in parts: move_line(line, False)
    else:
        for ring in parts: move_line(ring, True)
    return cmds

def encode_layer(name, feats):
    keys, values, kidx, vidx, body = [], [], {}, {}, bytearray()
    for f in feats:
        tags = []
        for k, v in f['props'].items():
            if v is None: continue
            if k not in kidx: kidx[k] = len(keys); keys.append(k)
            vk = (type(v).__name__, v)
            if vk not in vidx: vidx[vk] = len(values); values.append(v)
            tags.extend([kidx[k], vidx[vk]])
        feat = bytearray()
        if tags: feat += lendelim(2, b''.join(varint(t) for t in tags))
        feat += field(3, 0, varint(f['type']))
        feat += lendelim(4, b''.join(varint(c) for c in f['geom']))
        body += lendelim(2, bytes(feat))
    out = bytearray()
    out += field(15, 0, varint(2))
    out += lendelim(1, name.encode())
    out += body
    for k in keys: out += lendelim(3, k.encode())
    for v in values:
        if isinstance(v, bool): val = field(7, 0, varint(1 if v else 0))
        elif isinstance(v, int): val = field(4, 0, varint(v)) if v >= 0 else field(6, 0, varint(zigzag(v)))
        elif isinstance(v, float): val = field(3, 1, struct.pack('<d', v))
        else: val = lendelim(1, str(v).encode())
        out += lendelim(4, val)
    out += field(5, 0, varint(EXTENT))
    return bytes(out)

# ---- features --------------------------------------------------------------------------------------------------------
def load_features(path, bbox):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    feats, skipped = [], {}
    for f in data.get('features', []):
        p = f.get('properties') or {}
        kind = p.get('kind')
        g = f.get('geometry') or {}
        t = g.get('type')
        if kind not in LAYER_OF:
            skipped[kind] = skipped.get(kind, 0) + 1
            continue
        if kind in ('tree', 'furniture', 'bus', 'poi'):
            if t != 'Point': continue
            geoms = [[tuple(g['coordinates'][:2])]]
            gtype, parts_kind = 1, 'point'
        elif kind in ('road', 'barrier'):
            lines = [g['coordinates']] if t == 'LineString' else g['coordinates'] if t == 'MultiLineString' else []
            geoms = [[tuple(c[:2]) for c in l] for l in lines]
            gtype, parts_kind = 2, kind
        else:
            polys = [g['coordinates']] if t == 'Polygon' else g['coordinates'] if t == 'MultiPolygon' else []
            geoms = [[[tuple(c[:2]) for c in ring] for ring in poly] for poly in polys]
            gtype, parts_kind = 3, kind
        if not geoms: continue
        props = {'kind': None}
        if kind == 'road':
            hw = str(p.get('highway') or 'road')
            props = {'kind': MAJOR.get(hw.replace('_link', ''), 'other'), 'kind_detail': hw}
            for k in ('bridge', 'tunnel', 'oneway', 'surface'):
                if p.get(k) not in (None, '', 'no'): props[k] = str(p[k])
        elif kind in LANDUSE_KIND: props = {'kind': LANDUSE_KIND[kind]}
        elif kind == 'building': props = {'kind': 'building'};
        elif kind == 'water': props = {'kind': 'water'}
        elif kind == 'barrier': props = {'kind': str(p.get('type') or 'barrier')}
        else:
            ty = str(p.get('type') or kind)
            props = {'kind': {'tree': 'tree', 'bus': 'bus_stop'}.get(kind, ty), 'mt_kind': kind}
        if p.get('name'): props['name'] = str(p['name'])
        if kind == 'building' and p.get('levels'): props['levels'] = str(p['levels'])
        # world coordinates and a bounding box for tile selection
        if gtype == 1:
            wp = [[world(*geoms[0][0])]]
        elif gtype == 2:
            wp = [[world(*c) for c in line] for line in geoms]
        else:
            wp = [[[world(*c) for c in ring] for ring in poly] for poly in geoms]
        xs, ys = [], []
        def collect(o):
            for item in o:
                if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], float): xs.append(item[0]); ys.append(item[1])
                else: collect(item)
        collect(wp)
        lons = [c[0] for c in (geoms[0] if gtype == 1 else sum((l for l in geoms), []) if gtype == 2 else sum((r for poly in geoms for r in poly), []))]
        lats = [c[1] for c in (geoms[0] if gtype == 1 else sum((l for l in geoms), []) if gtype == 2 else sum((r for poly in geoms for r in poly), []))]
        if bbox and not (max(lons) >= bbox[0] and min(lons) <= bbox[2] and max(lats) >= bbox[1] and min(lats) <= bbox[3]): continue
        feats.append({'kind': kind, 'type': gtype, 'props': props, 'wp': wp, 'bbox': (min(xs), min(ys), max(xs), max(ys)),
                      'lonlat': (min(lons), min(lats), max(lons), max(lats)),
                      'minz': ROAD_MIN_Z.get(str(p.get('highway') or '').replace('_link', ''), 14) if kind == 'road' else MIN_Z['point' if gtype == 1 else kind]})
    return feats, skipped

def tile_features(feats, z, tx, ty, maxzoom):
    n = 1 << z
    lo, hi = -BUFFER, EXTENT + BUFFER
    tol = 0 if z >= maxzoom else EXTENT / 512.0 / 2.0
    layers = {}
    x0, x1, y0, y1 = tx / n, (tx + 1) / n, ty / n, (ty + 1) / n
    pad = BUFFER / EXTENT / n
    for f in feats:
        if z < f['minz']: continue
        bx0, by0, bx1, by1 = f['bbox']
        if bx1 < x0 - pad or bx0 > x1 + pad or by1 < y0 - pad or by0 > y1 + pad: continue
        def tc(p): return ((p[0] * n - tx) * EXTENT, (p[1] * n - ty) * EXTENT)
        if f['type'] == 1:
            x, y = tc(f['wp'][0][0])
            if not (0 <= x <= EXTENT and 0 <= y <= EXTENT): continue
            geom = encode_geometry(1, [(int(round(x)), int(round(y)))])
            out = {'type': 1, 'props': f['props'], 'geom': geom}
        elif f['type'] == 2:
            parts = []
            for line in f['wp']:
                for piece in clip_line([tc(p) for p in line], lo, hi):
                    q = quantise(simplify(piece, tol))
                    if len(q) >= 2: parts.append(q)
            if not parts: continue
            out = {'type': 2, 'props': f['props'], 'geom': encode_geometry(2, parts)}
        else:
            rings = []
            small = (EXTENT / 256.0) ** 2 * (4 if z < 15 else 0)          # a 2 px square or less is dropped on the coarser levels
            for poly in f['wp']:
                for i, ring in enumerate(poly):
                    c = clip_ring([tc(p) for p in ring[:-1] if True] if ring[0] == ring[-1] else [tc(p) for p in ring], lo, hi)
                    if len(c) < 3: continue
                    q = quantise(simplify(c, tol, True))
                    if len(q) > 1 and q[0] == q[-1]: q.pop()
                    if len(q) < 3: continue
                    a = signed_area(q)
                    if abs(a) <= small: continue
                    exterior = (i == 0)
                    if (a > 0) != exterior: q.reverse()               # exterior rings: positive area in y-down tile space, holes the opposite
                    rings.append(q)
            if not rings: continue
            out = {'type': 3, 'props': f['props'], 'geom': encode_geometry(3, rings)}
        layers.setdefault(LAYER_OF[f['kind']], []).append(out)
    return layers

# ---- PMTiles -------------------------------------------------------------------------------------------------------
def gz(data):
    return gzip.compress(data, compresslevel=9, mtime=0)

def serialise_directory(entries):
    buf = bytearray(varint(len(entries)))
    last = 0
    for e in entries:
        buf += varint(e[0] - last); last = e[0]
    for e in entries: buf += varint(e[3])
    for e in entries: buf += varint(e[2])
    for i, e in enumerate(entries):
        if i > 0 and e[1] == entries[i - 1][1] + entries[i - 1][2]: buf += varint(0)
        else: buf += varint(e[1] + 1)
    return bytes(buf)

def build_directories(entries):
    """(root bytes, leaf bytes): everything in the root when it fits, otherwise leaf directories under a small root."""
    root = gz(serialise_directory(entries))
    if len(root) <= ROOT_BUDGET: return root, b''
    size = 4096
    while True:
        leaves, blobs, off = [], bytearray(), 0
        for i in range(0, len(entries), size):
            chunk = entries[i:i + size]
            blob = gz(serialise_directory(chunk))
            leaves.append((chunk[0][0], off, len(blob), 0))
            blobs += blob; off += len(blob)
        root = gz(serialise_directory(leaves))
        if len(root) <= ROOT_BUDGET or size >= len(entries): return root, bytes(blobs)
        size *= 2

def write_pmtiles(path, tiles, bounds, minz, maxz, metadata):
    tiles.sort(key=lambda t: t[0])
    data, entries, seen = bytearray(), [], {}
    for tid, blob in tiles:
        h = hashlib.sha1(blob).digest()
        if h in seen: off, ln = seen[h]
        else: off, ln = len(data), len(blob); data += blob; seen[h] = (off, ln)
        if entries and entries[-1][1] == off and entries[-1][2] == ln and entries[-1][0] + entries[-1][3] == tid:
            entries[-1] = (entries[-1][0], off, ln, entries[-1][3] + 1)
        else: entries.append((tid, off, ln, 1))
    root, leaves = build_directories(entries)
    meta = gz(json.dumps(metadata, separators=(',', ':'), ensure_ascii=False).encode())
    root_off = 127
    meta_off = root_off + len(root)
    leaf_off = meta_off + len(meta)
    data_off = leaf_off + len(leaves)
    e7 = lambda v: int(round(v * 1e7))
    header = (b'PMTiles' + bytes([3])
              + struct.pack('<11Q', root_off, len(root), meta_off, len(meta), leaf_off, len(leaves), data_off, len(data), len(tiles), len(entries), len(seen))
              + bytes([1, 2, 2, 1, minz, maxz])
              + struct.pack('<4i', e7(bounds[0]), e7(bounds[1]), e7(bounds[2]), e7(bounds[3]))
              + bytes([maxz]) + struct.pack('<2i', e7((bounds[0] + bounds[2]) / 2), e7((bounds[1] + bounds[3]) / 2)))
    assert len(header) == 127, len(header)
    Path(path).write_bytes(header + root + meta + leaves + bytes(data))
    return {'bytes': 127 + len(root) + len(meta) + len(leaves) + len(data), 'tiles': len(tiles), 'uniqueTiles': len(seen), 'entries': len(entries),
            'rootBytes': len(root), 'leafBytes': len(leaves), 'tileDataBytes': len(data)}

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='GeoJSON in this app\'s street format (see the module docstring)')
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--minzoom', type=int, default=9)
    ap.add_argument('--maxzoom', type=int, default=16)
    ap.add_argument('--bbox', type=float, nargs=4, metavar=('W', 'S', 'E', 'N'), help='keep only features that touch this box')
    ap.add_argument('--name', default='Map data package')
    ap.add_argument('--description', default='')
    ap.add_argument('--attribution', default='')
    ap.add_argument('--license', default='')
    ap.add_argument('--source', default='')
    args = ap.parse_args(argv)
    t0 = time.time()
    feats, skipped = load_features(args.input, args.bbox)
    if not feats: raise SystemExit('No usable features in ' + args.input)
    lon0 = min(f['lonlat'][0] for f in feats); lat0 = min(f['lonlat'][1] for f in feats)
    lon1 = max(f['lonlat'][2] for f in feats); lat1 = max(f['lonlat'][3] for f in feats)
    bounds = (lon0, lat0, lon1, lat1)
    tiles, per_zoom, used_layers = [], {}, {}
    for z in range(args.minzoom, args.maxzoom + 1):
        n = 1 << z
        wx0, wy0 = world(lon0, lat1)
        wx1, wy1 = world(lon1, lat0)
        count = 0
        for tx in range(int(wx0 * n), min(n - 1, int(wx1 * n)) + 1):
            for ty in range(int(wy0 * n), min(n - 1, int(wy1 * n)) + 1):
                layers = tile_features(feats, z, tx, ty, args.maxzoom)
                if not layers: continue
                tile = b''.join(lendelim(3, encode_layer(name, fs)) for name, fs in sorted(layers.items()))
                for name, fs in layers.items(): used_layers[name] = used_layers.get(name, 0) + len(fs)
                tiles.append((hilbert_id(z, tx, ty), gz(tile)))
                count += 1
        per_zoom[z] = count
    metadata = {
        'name': args.name, 'description': args.description, 'version': '1', 'type': 'baselayer',
        'attribution': args.attribution, 'format': 'pbf',
        'vector_layers': [{'id': name, 'minzoom': args.minzoom, 'maxzoom': args.maxzoom} for name in sorted(used_layers)],
        'meta_trace': {'license': args.license, 'generator': 'tools/make_pmtiles.py', 'source': args.source or Path(args.input).name,
                       'extent': EXTENT, 'buffer': BUFFER, 'synthetic': False}
    }
    stats = write_pmtiles(args.output, tiles, bounds, args.minzoom, args.maxzoom, metadata)
    stats.update({'features': len(feats), 'skippedKinds': skipped, 'tilesPerZoom': per_zoom, 'bounds': bounds, 'seconds': round(time.time() - t0, 2)})
    print(json.dumps(stats, indent=2))

if __name__ == '__main__':
    main()
