// A real third-party map package: the Protomaps basemap sample for Florence from the PMTiles repository (data/samples).
// Everything else in the package tests uses archives written by this repository; this file is what shows that the reader,
// the vector-tile decoder and the schema adapter agree with an archive somebody else produced (Protomaps basemap 3.7.1,
// built with planetiler). It found that real tiles prefix their properties ("pmap:kind"), which the adapter did not read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const P = require('../pmtiles-reader.js');
const D = require('../mvt-decoder.js');
const S = require('../tile-schema.js');

const FILE = path.join(__dirname, '..', 'data', 'samples', 'protomaps-basemap-firenze.pmtiles');
const UPSTREAM_SHA256 = '7190f3d807a62f4f012b574007c96b809f6842f45a6b0c508639331fc68fd30a';
const bytes = fs.readFileSync(FILE);
const source = {size: bytes.length, name: 'protomaps-basemap-firenze.pmtiles', async read(offset, length) {return new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length).slice();}};
const tileOf = (z, lon, lat) => {const n = 2 ** z; return [z, Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)];};
const DUOMO = [11.2558, 43.7731];
const adapt = async (z, x, y) => {
  const archive = await P.open(source), raw = await archive.getTile(z, x, y);
  assert.ok(raw, 'tile ' + [z, x, y] + ' exists');
  return S.adaptTile(D.decodeTile(new Uint8Array(raw)), {z, x, y});
};
const names = (model, kind) => new Set(model.labels.filter(l => l.kind === kind).map(l => l.text));

test('the sample is the file published in the PMTiles repository, byte for byte', () => {
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), UPSTREAM_SHA256);
  assert.equal(bytes.length, 6601156);
});

test('describe reads a real Protomaps archive: name, credit as plain text, layers, bounds, zooms, compression', async () => {
  const d = await P.describe(source);
  assert.equal(d.name, 'Protomaps Basemap');
  assert.equal(d.version, '3.7.1');
  assert.equal(d.attribution, '© OpenStreetMap contributors', 'the credit is written as "&copy; OpenStreetMap contributors" in the file');
  assert.deepEqual(d.layers, ['boundaries', 'buildings', 'earth', 'landcover', 'landuse', 'natural', 'physical_line', 'physical_point', 'places', 'pois', 'roads', 'transit', 'water']);
  assert.ok(S.recognisesLayers(d.layers));
  assert.deepEqual(d.bounds, [11.221144, 43.745121, 11.287543, 43.789306]);
  assert.deepEqual([d.minZoom, d.maxZoom, d.tiles, d.tileCompression, d.clustered], [0, 15, 92, 'gzip', true]);
  assert.ok(d.bytesRead < 25000, 'describe read ' + d.bytesRead + ' bytes of a 6.6 MB file');
});

test('every tile of the archive decodes and adapts; most of what is in a real tile is drawn, and what is left out is the lane-level and non-drawing detail', async () => {
  const archive = await P.open(source);
  const entries = P.parseDirectory(await P.gunzip(await source.read(archive.header.rootDirOffset, archive.header.rootDirLength)));
  const total = {tiles: 0, features: 0, used: 0, dropped: 0, roads: 0, ms: 0, worstMs: 0};
  for (const e of entries) for (let k = 0; k < Math.max(1, e.runLength); k++) {
    const [z, x, y] = P.tileIdToZxy(e.tileId + k);
    const raw = await archive.getTile(z, x, y);
    assert.ok(raw && raw.length, 'tile ' + [z, x, y]);
    const t0 = performance.now();
    const m = S.adaptTile(D.decodeTile(new Uint8Array(raw)), {z, x, y});
    const ms = performance.now() - t0;
    total.tiles++; total.features += m.stats.features; total.used += m.stats.used; total.dropped += m.stats.dropped; total.roads += m.stats.byKind.road || 0; total.ms += ms; total.worstMs = Math.max(total.worstMs, ms);
    assert.ok(m.labels.length <= S.MAX_LABELS_PER_TILE);
  }
  assert.equal(total.tiles, 92);
  assert.equal(total.features, 136928, 'the number of features in the file');
  assert.ok(total.used / total.features > 0.8, 'drawn share ' + (total.used / total.features).toFixed(3) + ' (it was 0.417 before the "pmap:" prefix was read: buildings and business names were drawn, roads, parks, rivers, rails and place names were all dropped)');
  assert.ok(total.roads > 8000, 'road features drawn: ' + total.roads);
  console.log('    92 real tiles decoded and adapted: ' + total.used + ' of ' + total.features + ' features drawn (' + (100 * total.used / total.features).toFixed(1) + ' %), '
    + 'mean ' + (total.ms / total.tiles).toFixed(1) + ' ms per tile, worst ' + total.worstMs.toFixed(0) + ' ms (Node, one thread)');
});

test('the tile under the Duomo at zoom 14: a street network, rail, a river, parks, buildings, names of streets, places and businesses', async () => {
  const m = await adapt(...tileOf(14, ...DUOMO));
  assert.ok(m.stats.byKind.road > 400, 'roads: ' + m.stats.byKind.road + ' of 590 (none before the fix)');
  assert.ok(m.stats.byKind.rail > 50 && m.stats.byKind.building >= 8 && m.stats.byKind.green > 50 && m.stats.byKind.paved > 10, JSON.stringify(m.stats.byKind));
  assert.ok(m.stats.byKind.poi > 150 && m.stats.byKind.place >= 4);
  assert.ok(m.groups.some(g => g.kind === 'road' && g.highway === 'residential') && m.groups.some(g => g.kind === 'road' && g.highway === 'pedestrian'));
  assert.ok(m.groups.some(g => g.kind === 'rail'));
  assert.ok(names(m, 'road').has('Via dell\'Oriuolo'), 'a street named in the file is labelled');
  assert.ok(names(m, 'poi').has('Cupola del Brunelleschi'), 'a named landmark is labelled');
  assert.ok(names(m, 'waterway').has('Torrente Mugnone'), 'a named stream is labelled');
  assert.ok(m.stats.dropped / m.stats.features < 0.2, 'dropped share ' + (m.stats.dropped / m.stats.features).toFixed(3));
});

test('the tile at zoom 12: the Arno and the city are named; the road net is already there for the five-mile view', async () => {
  const m = await adapt(...tileOf(12, ...DUOMO));
  assert.ok(m.stats.byKind.road > 60 && m.stats.byKind.waterway > 10, JSON.stringify(m.stats.byKind));
  const places = m.labels.filter(l => l.kind === 'place');
  assert.ok(places.length > 50, 'place names: ' + places.length);
  for (const l of places) assert.ok(l.minZoom >= 5 && l.minZoom <= 15, l.text + ' appears at zoom ' + l.minZoom + ' (the file\'s own min_zoom)');
  const tenZ = await adapt(...tileOf(10, ...DUOMO));
  assert.ok(names(tenZ, 'waterway').has('Fiume Arno'), 'the river is named at zoom 10');
  assert.ok(names(tenZ, 'place').has('Firenze') || names(m, 'place').has('Firenze') || names(await adapt(...tileOf(15, ...DUOMO)), 'place').has('Firenze'), 'the city is named');
});

test('at the street zoom the names are ranked: street names first, then the businesses the file ranks highest', async () => {
  const m = await adapt(...tileOf(15, ...DUOMO));
  assert.equal(m.labels.length, S.MAX_LABELS_PER_TILE, 'a dense tile is cut to the limit');
  const kinds = {}; for (const l of m.labels) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  assert.ok(kinds.road > 40 && kinds.poi > 300, JSON.stringify(kinds));
  assert.ok(m.labels.indexOf(m.labels.find(l => l.kind === 'road')) < m.labels.indexOf(m.labels.find(l => l.kind === 'poi')), 'streets sort ahead of businesses');
  assert.ok(m.stats.byKind.poi > 2000, 'every named business is still drawn as a point: ' + m.stats.byKind.poi);
});
