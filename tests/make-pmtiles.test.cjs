// tools/make_pmtiles.py, checked from outside: the package it writes is read back with the JavaScript reader, decoder and schema
// adapter, which share no code with it. That cross-checks the tile ids, directories, header, gzip, protocol buffers and the
// geometry encoding in both directions. Needs python3 (skipped without it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const PM = require('../pmtiles-reader.js');
const MVT = require('../mvt-decoder.js');
const TS = require('../tile-schema.js');

const ROOT = path.join(__dirname, '..'), TOOL = path.join(ROOT, 'tools', 'make_pmtiles.py');
const python = spawnSync('python3', ['--version']);
const skip = python.status === 0 ? false : 'python3 is not available';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'make-pmtiles-'));
test.after(() => fs.rmSync(tmp, {recursive: true, force: true}));

function convert(input, output, args = []) {
  const r = spawnSync('python3', ['-I', TOOL, input, '-o', output, ...args], {encoding: 'utf8'});
  assert.equal(r.status, 0, 'converter failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}
const open = file => PM.open(PM.bytesSource(new Uint8Array(fs.readFileSync(file))));
const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => {const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;};
/** The middle of the zoom-16 tile around Gainesville: a place where small test shapes cannot straddle a tile edge. */
const CENTRE = (() => {
  const z = 16, x = Math.floor(lonToX(-82.3379, z)), y = Math.floor(latToY(29.6489, z));
  return {lon: (x + 0.5) / 2 ** z * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z))) * 180 / Math.PI};
})();
const feature = (kind, geometry, properties = {}) => ({type: 'Feature', geometry, properties: {kind, ...properties}});

test('every kind survives the round trip with its geometry to within a fraction of a metre', {skip}, async () => {
  const lon = CENTRE.lon, lat = CENTRE.lat, d = 0.0004;
  const input = path.join(tmp, 'small.geojson'), output = path.join(tmp, 'small.pmtiles');
  fs.writeFileSync(input, JSON.stringify({type: 'FeatureCollection', features: [
    feature('road', {type: 'LineString', coordinates: [[lon - d, lat], [lon + d, lat + d]]}, {highway: 'primary', name: 'Archer Road'}),
    feature('road', {type: 'LineString', coordinates: [[lon - d, lat - d], [lon + d, lat - d]]}, {highway: 'footway'}),
    feature('road', {type: 'LineString', coordinates: [[lon, lat - 2 * d], [lon, lat + 2 * d]]}, {highway: 'elevator'}),
    feature('building', {type: 'Polygon', coordinates: [[[lon - d, lat + d], [lon, lat + d], [lon, lat + 2 * d], [lon - d, lat + 2 * d], [lon - d, lat + d]]]}, {name: 'Test Hall', levels: '3'}),
    feature('green', {type: 'Polygon', coordinates: [[[lon + d, lat + d], [lon + 2 * d, lat + d], [lon + 2 * d, lat + 2 * d], [lon + d, lat + d]]]}),
    feature('water', {type: 'Polygon', coordinates: [[[lon - 2 * d, lat - 2 * d], [lon + 2 * d, lat - 2 * d], [lon + 2 * d, lat + 2 * d], [lon - 2 * d, lat + 2 * d], [lon - 2 * d, lat - 2 * d]], [[lon - d, lat - d], [lon - d, lat], [lon, lat], [lon, lat - d], [lon - d, lat - d]]]}),
    feature('barrier', {type: 'LineString', coordinates: [[lon - d, lat + 3 * d], [lon + d, lat + 3 * d]]}, {type: 'fence'}),
    feature('tree', {type: 'Point', coordinates: [lon + d / 2, lat - d / 2]}),
    feature('furniture', {type: 'Point', coordinates: [lon - d / 2, lat + d / 2]}, {type: 'bicycle_parking'}),
    feature('bus', {type: 'Point', coordinates: [lon + d, lat]}),
    feature('poi', {type: 'Point', coordinates: [lon, lat]}, {type: 'cafe'})
  ]}));
  const stats = convert(input, output, ['--minzoom', '12', '--maxzoom', '16', '--name', 'Round trip', '--attribution', 'test credit', '--license', 'test licence']);
  assert.equal(stats.features, 11);

  const info = await PM.describe(PM.bytesSource(new Uint8Array(fs.readFileSync(output))));
  assert.equal(info.name, 'Round trip');
  assert.equal(info.attribution, 'test credit');
  assert.equal(info.licenseNote, 'test licence');
  assert.equal(info.synthetic, false);
  assert.deepEqual([info.minZoom, info.maxZoom], [12, 16]);
  assert.ok(TS.recognisesLayers(info.layers), 'layers: ' + info.layers.join(','));
  assert.ok(info.bounds[0] < lon && info.bounds[2] > lon && info.bounds[1] < lat && info.bounds[3] > lat);
  assert.equal(info.tileCompression, 'gzip');

  const r = await open(output);
  const z = 16, tx = Math.floor(lonToX(lon, z)), ty = Math.floor(latToY(lat, z));
  const bytes = await r.getTile(z, tx, ty);
  assert.ok(bytes && bytes.length, 'the tile the data sits in is found by its Hilbert id');
  const decoded = MVT.decodeTile(bytes);
  assert.deepEqual(decoded.layers.map(l => l.name).sort(), ['barriers', 'buildings', 'landuse', 'pois', 'roads', 'water']);
  const byName = Object.fromEntries(decoded.layers.map(l => [l.name, l]));
  assert.ok(decoded.layers.every(l => l.extent === 4096));

  // geometry: a decoded vertex, put back on the map, lies within 0.2 m of where it was written (1 tile unit at zoom 16 is 0.15 m)
  const back = (px, py) => ({lon: (tx + px / 4096) / 2 ** z * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py / 4096) / 2 ** z))) * 180 / Math.PI});
  const metres = (a, b) => Math.hypot((a.lon - b.lon) * 111320 * Math.cos(lat * Math.PI / 180), (a.lat - b.lat) * 110540);
  const archer = byName.roads.features.find(f => f.props.name === 'Archer Road');
  assert.deepEqual([archer.props.kind, archer.props.kind_detail], ['major_road', 'primary']);
  const g = archer.geometry[0];
  assert.ok(metres(back(g[0], g[1]), {lon: lon - d, lat}) < 0.2 && metres(back(g[2], g[3]), {lon: lon + d, lat: lat + d}) < 0.2, 'road endpoints');
  const hall = byName.buildings.features[0];
  assert.equal(hall.props.name, 'Test Hall');
  assert.equal(hall.props.levels, '3');
  assert.equal(hall.geometry[0].length, 8, 'the closing vertex is implicit: four corners');
  assert.ok(MVT.ringArea(hall.geometry[0]) > 0, 'exterior ring orientation follows the spec');
  const water = byName.water.features[0];
  assert.equal(water.geometry.length, 2, 'the pond keeps its island hole');
  assert.ok(MVT.ringArea(water.geometry[0]) > 0 && MVT.ringArea(water.geometry[1]) < 0, 'hole wound the other way');
  assert.deepEqual(byName.landuse.features.map(f => f.props.kind), ['park']);
  assert.deepEqual(byName.barriers.features.map(f => f.props.kind), ['fence']);

  // and through the schema adapter, the app sees what the source had
  const m = TS.adaptTile(decoded, {z, x: tx, y: ty});
  assert.deepEqual(m.points.map(p => p.kind).sort(), ['bus', 'furniture', 'poi', 'tree'], 'points keep the kind the source drew them as, even the unnamed cafe');
  assert.deepEqual(m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort(), ['elevator', 'footway', 'primary']);
  for (const kind of ['building', 'green', 'water', 'barrier']) assert.ok(m.groups.some(g => g.kind === kind), kind);
  assert.ok(m.labels.some(l => l.text === 'Archer Road') && m.labels.some(l => l.text === 'Test Hall'));
});

test('lower zooms are generalised: minor features wait for their zoom, and the top zoom is not simplified', {skip}, async () => {
  const lon = CENTRE.lon - 0.0006, lat = CENTRE.lat;
  const wiggle = Array.from({length: 60}, (_, i) => [lon + i * 0.00002, lat + Math.sin(i / 3) * 0.000004]);
  const input = path.join(tmp, 'zoom.geojson'), output = path.join(tmp, 'zoom.pmtiles');
  fs.writeFileSync(input, JSON.stringify({type: 'FeatureCollection', features: [
    feature('road', {type: 'LineString', coordinates: wiggle}, {highway: 'footway'}),
    feature('road', {type: 'LineString', coordinates: wiggle.map(([x, y]) => [x, y + 0.0002])}, {highway: 'primary'}),
    feature('tree', {type: 'Point', coordinates: [lon, lat]})
  ]}));
  convert(input, output, ['--minzoom', '9', '--maxzoom', '16']);
  const r = await open(output);
  const read = async z => {
    const b = await r.getTile(z, Math.floor(lonToX(lon + 0.0006, z)), Math.floor(latToY(lat, z)));
    return b ? MVT.decodeTile(b) : null;
  };
  const kinds = async z => {const t = await read(z); return t ? t.layers.flatMap(l => l.features.map(f => l.name + ':' + (f.props.kind_detail || f.props.kind))).sort() : [];};
  assert.deepEqual(await kinds(10), ['roads:primary'], 'zoom 10: only the primary road');
  assert.deepEqual(await kinds(14), ['roads:footway', 'roads:primary'], 'zoom 14: footways arrive');
  assert.ok((await kinds(15)).includes('pois:tree') && (await kinds(16)).includes('pois:tree'), 'trees from zoom 15');
  assert.ok(!(await kinds(14)).includes('pois:tree'));
  const verts = async (z, d) => (await read(z)).layers.find(l => l.name === 'roads').features.find(f => f.props.kind_detail === d).geometry.reduce((n, line) => n + line.length / 2, 0);
  assert.ok(await verts(12, 'primary') < await verts(16, 'primary'), 'a coarser zoom keeps fewer vertices');
  assert.equal(await verts(16, 'primary'), 60, 'the top zoom keeps every vertex');
});

test('the bundled Gainesville data converts completely: nothing lost, every tile found and decodable', {skip}, async () => {
  const output = path.join(tmp, 'gainesville.pmtiles');
  const stats = convert(path.join(ROOT, 'data', 'map-data.json'), output, ['--name', 'Gainesville', '--minzoom', '9', '--maxzoom', '16']);
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'map-data.json'), 'utf8')).features;
  const counts = {};
  for (const f of source) counts[f.properties.kind] = (counts[f.properties.kind] || 0) + 1;
  assert.equal(stats.features, source.length);
  assert.deepEqual(stats.skippedKinds, {});

  const r = await open(output);
  const info = await PM.describe(PM.bytesSource(new Uint8Array(fs.readFileSync(output))));
  assert.equal(info.tiles, stats.tiles);
  const seen = {}, bad = [];
  let tilesRead = 0;
  for (let z = 9; z <= 16; z++) {
    const x0 = Math.floor(lonToX(info.bounds[0], z)), x1 = Math.floor(lonToX(info.bounds[2], z)), y0 = Math.floor(latToY(info.bounds[3], z)), y1 = Math.floor(latToY(info.bounds[1], z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const b = await r.getTile(z, x, y);
      if (!b) continue;
      tilesRead++;
      try {
        const m = TS.adaptTile(MVT.decodeTile(b), {z, x, y});
        if (z === 16) for (const [k, n] of Object.entries(m.stats.byKind)) seen[k] = (seen[k] || 0) + n;
        assert.equal(m.stats.dropped, 0, 'z' + z + '/' + x + '/' + y + ' dropped features');
      } catch (e) {bad.push(z + '/' + x + '/' + y + ': ' + e.message);}
    }
  }
  assert.deepEqual(bad, []);
  assert.equal(tilesRead, stats.tiles, 'every tile the converter wrote is found through the directory');
  // points sit in exactly one tile, so their counts must match exactly
  for (const [kind, key] of [['tree', 'tree'], ['furniture', 'furniture'], ['bus', 'bus'], ['poi', 'poi']]) assert.equal(seen[key], counts[kind], kind + ' points');
  // lines and polygons can appear in several tiles (the buffer), but never fewer than the source
  for (const [kind, key] of [['road', 'road'], ['building', 'building'], ['green', 'green'], ['parking', 'parking'], ['paved', 'paved'], ['water', 'water'], ['barrier', 'barrier']]) {
    assert.ok(seen[key] >= counts[kind], kind + ': ' + seen[key] + ' in the tiles for ' + counts[kind] + ' in the source');
    assert.ok(seen[key] <= counts[kind] * 4, kind + ': no more than a few copies per feature');
  }
  console.log('    Gainesville package: ' + stats.bytes + ' bytes, ' + stats.tiles + ' tiles, ' + stats.features + ' features in ' + stats.seconds + ' s');
});
