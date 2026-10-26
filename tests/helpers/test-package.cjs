// A synthetic regional map package for tests: a street grid, blocks of buildings, a pond, a place name and a few points, laid
// over any bounding box, as real PMTiles bytes (gzip vector tiles in the Protomaps layer vocabulary).
//
// It is test data, not geography. The metadata says so (meta_trace.synthetic) and the app shows that flag, so it can never be
// mistaken for a map of the place it is laid over. It exists to prove the loader, the cache and the drawing against a package
// that is not the bundled Gainesville data.
const MVT = require('./mvt-writer.cjs');
const PM = require('./pmtiles-writer.cjs');

const EXTENT = 4096, BUFFER = 64;
const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => {const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;};

/**
 * options: bounds [w,s,e,n], minZoom, maxZoom, spacing (degrees between streets, default 0.002), name.
 * Returns {bytes, tiles, features, bounds, info}.
 */
function makeSyntheticPackage({bounds, minZoom = 10, maxZoom = 15, spacing = 0.002, name = 'Synthetic test region', compression = 2, leafSize = 0, extra = {}} = {}) {
  const [W, S, E, N] = bounds, tiles = [];
  let features = 0;
  const kMin = Math.ceil(W / spacing), kMax = Math.floor(E / spacing), jMin = Math.ceil(S / spacing), jMax = Math.floor(N / spacing);
  const pond = [W + (E - W) * 0.3, S + (N - S) * 0.3, W + (E - W) * 0.4, S + (N - S) * 0.4];
  const centre = [(W + E) / 2, (S + N) / 2];

  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z, x0 = Math.floor(lonToX(W, z)), x1 = Math.floor(lonToX(E, z)), y0 = Math.floor(latToY(N, z)), y1 = Math.floor(latToY(S, z));
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      const px = lon => (lonToX(lon, z) - tx) * EXTENT, py = lat => (latToY(lat, z) - ty) * EXTENT;
      const lo = -BUFFER, hi = EXTENT + BUFFER, clamp = v => Math.max(lo, Math.min(hi, v));
      const inside = (a, b) => b >= lo && a <= hi;
      const roads = [], buildings = [], water = [], places = [], pois = [];
      const yTop = clamp(py(N)), yBot = clamp(py(S)), xL = clamp(px(W)), xR = clamp(px(E));
      for (let k = kMin; k <= kMax; k++) {
        const x = Math.round(px(k * spacing));
        if (x < lo || x > hi || yBot <= yTop) continue;
        const major = k % 5 === 0;
        roads.push({type: 2, geometry: [[x, Math.round(yTop), x, Math.round(yBot)]], props: {kind: major ? 'major_road' : 'minor_road', kind_detail: major ? 'primary' : 'residential', name: (major ? 'Avenue ' : 'Street ') + k}});
      }
      for (let j = jMin; j <= jMax; j++) {
        const y = Math.round(py(j * spacing));
        if (y < lo || y > hi || xR <= xL) continue;
        const major = j % 5 === 0;
        roads.push({type: 2, geometry: [[Math.round(xL), y, Math.round(xR), y]], props: {kind: major ? 'major_road' : 'minor_road', kind_detail: major ? 'primary' : 'residential', name: (major ? 'Boulevard ' : 'Lane ') + j}});
      }
      if (z >= 13) {
        for (let k = kMin; k < kMax; k++) for (let j = jMin; j < jMax; j++) {
          const bx0 = Math.round(px((k + 0.25) * spacing)), bx1 = Math.round(px((k + 0.75) * spacing)), by0 = Math.round(py((j + 0.75) * spacing)), by1 = Math.round(py((j + 0.25) * spacing));
          if (!inside(bx0, bx1) || !inside(by0, by1)) continue;
          const cx0 = Math.round(clamp(bx0)), cx1 = Math.round(clamp(bx1)), cy0 = Math.round(clamp(by0)), cy1 = Math.round(clamp(by1));
          if (cx1 - cx0 < 2 || cy1 - cy0 < 2) continue;
          buildings.push({type: 3, geometry: [[cx0, cy0, cx1, cy0, cx1, cy1, cx0, cy1]], props: {kind: 'building', height: 6 + (k + j) % 5, ...((k + j) % 9 === 0 ? {name: 'Block ' + k + '-' + j} : {})}});
        }
      }
      {
        const ax0 = px(pond[0]), ax1 = px(pond[2]), ay0 = py(pond[3]), ay1 = py(pond[1]);
        if (inside(ax0, ax1) && inside(ay0, ay1)) {
          const cx0 = Math.round(clamp(ax0)), cx1 = Math.round(clamp(ax1)), cy0 = Math.round(clamp(ay0)), cy1 = Math.round(clamp(ay1));
          if (cx1 - cx0 > 2 && cy1 - cy0 > 2) water.push({type: 3, geometry: [[cx0, cy0, cx1, cy0, cx1, cy1, cx0, cy1]], props: {kind: 'lake', name: 'Test Pond'}});
        }
      }
      const cx = Math.round(px(centre[0])), cy = Math.round(py(centre[1]));
      if (cx >= 0 && cx < EXTENT && cy >= 0 && cy < EXTENT) {
        places.push({type: 1, geometry: [cx, cy], props: {kind: 'locality', kind_detail: 'city', name: 'Testville'}});
        pois.push({type: 1, geometry: [Math.min(EXTENT, cx + 40), cy + 40], props: {kind: 'bus_stop'}}, {type: 1, geometry: [Math.min(EXTENT, cx + 80), cy + 80], props: {kind: 'tree'}});
      }
      const layers = [];
      if (roads.length) layers.push({name: 'roads', features: roads});
      if (buildings.length) layers.push({name: 'buildings', features: buildings});
      if (water.length) layers.push({name: 'water', features: water});
      if (places.length) layers.push({name: 'places', features: places});
      if (pois.length) layers.push({name: 'pois', features: pois});
      if (!layers.length) continue;
      features += layers.reduce((s, l) => s + l.features.length, 0);
      tiles.push({z, x: tx, y: ty, data: MVT.encodeTile(layers)});
    }
  }
  const metadata = {
    name, description: 'A street grid generated for tests. It is not a map of this place.',
    attribution: '<a href="https://example.org/test">Synthetic test data</a>', version: '1',
    vector_layers: ['roads', 'buildings', 'water', 'places', 'pois'].map(id => ({id})),
    meta_trace: {license: 'None: generated test pattern', synthetic: true}, ...extra
  };
  const bytes = PM.build(tiles, {bounds, metadata, tileCompression: compression, internalCompression: 2, leafSize});
  return {bytes, tiles: tiles.length, features, bounds, info: {minZoom, maxZoom, name}, list: tiles, metadata};
}

module.exports = {makeSyntheticPackage, EXTENT, lonToX, latToY};
