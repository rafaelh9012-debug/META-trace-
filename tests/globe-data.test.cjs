// Pure-logic tests for the globe data loader: pack decoding, edge subdivision, bounding caps and chunking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GD = require('../globe-data.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a + ' (tolerance ' + tol + ')');
const P = 10000;
const flat = (...pairs) => pairs.flatMap(([lon, lat]) => [Math.round(lon * P), Math.round(lat * P)]);
const unit = (xyz, i) => Math.hypot(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
const lonLat = (xyz, i) => ({lon: Math.atan2(xyz[3 * i + 1], xyz[3 * i]) * 180 / Math.PI, lat: Math.asin(Math.max(-1, Math.min(1, xyz[3 * i + 2]))) * 180 / Math.PI});

test('densify keeps every original vertex and puts all points on the unit sphere', () => {
  const xyz = GD.densify(flat([10, 20], [14, 20], [14, 26]), P, 1);
  assert.ok(xyz.length / 3 > 3);
  for (let i = 0; i < xyz.length / 3; i++) near(unit(xyz, i), 1, 1e-6, 'unit length');
  const a = lonLat(xyz, 0), z = lonLat(xyz, xyz.length / 3 - 1);
  near(a.lon, 10, 1e-4);near(a.lat, 20, 1e-4);near(z.lon, 14, 1e-4);near(z.lat, 26, 1e-4);
});

test('no step spans more than the requested maximum in longitude or latitude (so no arc exceeds it times root two)', () => {
  const xyz = GD.densify(flat([-60, -10], [40, 50], [100, -30]), P, 2);
  const n = xyz.length / 3;
  for (let i = 1; i < n; i++) {
    const a = lonLat(xyz, i - 1), b = lonLat(xyz, i);
    assert.ok(Math.abs(b.lon - a.lon) <= 2.0001, 'longitude step ' + i + ' is ' + (b.lon - a.lon));
    assert.ok(Math.abs(b.lat - a.lat) <= 2.0001, 'latitude step ' + i + ' is ' + (b.lat - a.lat));
    const arc = Math.acos(Math.min(1, xyz[3 * i] * xyz[3 * i - 3] + xyz[3 * i + 1] * xyz[3 * i - 2] + xyz[3 * i + 2] * xyz[3 * i - 1])) * 180 / Math.PI;
    assert.ok(arc <= 2 * Math.SQRT2 + .01, 'arc ' + i + ' is ' + arc + ' degrees');
  }
});

test('subdivided points sit on the original edge in Web Mercator space, so globe and flat map agree', () => {
  const xyz = GD.densify(flat([0, 10], [30, 60]), P, 1);
  const n = xyz.length / 3;
  const y0 = GD.mercY(10), y1 = GD.mercY(60);
  for (let i = 0; i < n; i++) {
    const p = lonLat(xyz, i), t = (p.lon - 0) / 30;
    near(GD.mercY(p.lat), y0 + (y1 - y0) * t, 2e-5, 'mercator y at point ' + i);
  }
});

test('an edge across the antimeridian goes the short way', () => {
  const xyz = GD.densify(flat([179, 10], [-179, 12]), P, 0.5);
  for (let i = 0; i < xyz.length / 3; i++) assert.ok(Math.abs(Math.abs(lonLat(xyz, i).lon) - 180) <= 1.0001, 'lon ' + lonLat(xyz, i).lon);
  assert.ok(xyz.length / 3 >= 5);
});

test('edges that touch the poles do not produce NaN', () => {
  const xyz = GD.densify(flat([0, 80], [90, 90], [180, 80], [-90, -90]), P, 2);
  for (const v of xyz) assert.ok(Number.isFinite(v));
});

test('densify refuses fewer than two points', () => {
  assert.equal(GD.densify(flat([1, 2]), P, 2), null);
  assert.equal(GD.densify([], P, 2), null);
});

test('a cap contains every vertex of its geometry', () => {
  const xyz = GD.densify(flat([100, -20], [120, -30], [130, -10], [110, 0], [100, -20]), P, 1);
  const c = GD.cap(xyz);
  near(Math.hypot(c.cx, c.cy, c.cz), 1, 1e-9);
  for (let i = 0; i < xyz.length / 3; i++) assert.ok(xyz[3 * i] * c.cx + xyz[3 * i + 1] * c.cy + xyz[3 * i + 2] * c.cz >= c.cosR, 'vertex ' + i + ' outside the cap');
});

test('a ring that wraps the whole world still gets a usable cap', () => {
  const pts = [];for (let lon = -180; lon <= 180; lon += 10) pts.push([lon, 0]);
  const xyz = GD.densify(flat(...pts), P, 5), c = GD.cap(xyz);
  assert.ok(Number.isFinite(c.cx + c.cy + c.cz + c.cosR));
  for (let i = 0; i < xyz.length / 3; i++) assert.ok(xyz[3 * i] * c.cx + xyz[3 * i + 1] * c.cy + xyz[3 * i + 2] * c.cz >= c.cosR);
});

test('chunking covers the whole line, joins chunks at a shared vertex and bounds each one', () => {
  const pts = [];for (let i = 0; i <= 300; i++) pts.push([i * .2, 30 + Math.sin(i / 9) * 5]);
  const xyz = GD.densify(flat(...pts), P, 2), chunks = GD.chunkLine(xyz, 40);
  assert.ok(chunks.length > 5);
  assert.deepEqual([...chunks[0].xyz.slice(0, 3)], [...xyz.slice(0, 3)]);
  const lastChunk = chunks[chunks.length - 1];
  assert.deepEqual([...lastChunk.xyz.slice(-3)], [...xyz.slice(-3)]);
  for (let k = 1; k < chunks.length; k++) assert.deepEqual([...chunks[k].xyz.slice(0, 3)], [...chunks[k - 1].xyz.slice(-3)], 'chunk ' + k + ' starts where the last ended');
  for (const c of chunks) for (let i = 0; i < c.xyz.length / 3; i++) assert.ok(c.xyz[3 * i] * c.cx + c.xyz[3 * i + 1] * c.cy + c.xyz[3 * i + 2] * c.cz >= c.cosR);
});

test('load rejects anything that is not a globe pack', () => {
  assert.equal(GD.load(null), null);
  assert.equal(GD.load({}), null);
  assert.equal(GD.load({format: 'something-else', layers: {}}), null);
});

test('load skips malformed entries and keeps good ones', () => {
  const pack = {format: 'meta-trace-globe-pack', version: 1, scale: '1:test', precision: P, attribution: 'test', layers: {
    land: {kind: 'polygon', rings: [flat([0, 0], [10, 0], [10, 10], [0, 10], [0, 0]), flat([1, 1]), []]},
    borders: {kind: 'line', lines: [flat([0, 0], [5, 5]), flat([3, 3])], ranks: [0, 1]},
    places: {kind: 'point', basis: 'test', items: [[10, 20, 'Alpha', 'XX', 1, 100], [NaN, 3, 'Bad'], [4, 5, '']]},
    mystery: {kind: 'hologram'}
  }, countryLabels: [[1, 2, 'Land', 5], [0, 0, '']]};
  const d = GD.load(pack, {maxStepDeg: 2});
  assert.equal(d.layers.land.rings.length, 1);
  assert.equal(d.layers.borders.chunks.length, 1);
  assert.equal(d.places.length, 1);assert.equal(d.places[0].text, 'Alpha');
  assert.equal(d.countries.length, 1);
  assert.equal(d.layers.mystery, undefined);
  assert.equal(d.placesBasis, 'test');
  assert.equal(d.attribution, 'test');
});

test('the bundled world pack decodes, stays small in memory and keeps its provenance', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'globe-pack.json'), 'utf8'));
  const d = GD.load(pack);
  assert.ok(d.layers.land.rings.length >= 200, 'land rings');
  assert.ok(d.layers.coast.chunks.length >= 100, 'coast chunks');
  assert.ok(d.layers.borders.chunks.length >= 100, 'border chunks');
  assert.ok(d.places.length >= 300, 'places');
  assert.ok(d.countries.length >= 150, 'countries');
  assert.ok(d.stats.vertices < 400000, 'decoded vertices ' + d.stats.vertices);
  // Float32 x y z, 12 bytes per vertex: the whole decoded world must stay well under 8 MB.
  assert.ok(d.stats.vertices * 12 < 8 * 1024 * 1024);
  assert.ok(pack.attribution && pack.sources.length >= 2);
  for (const s of pack.sources) assert.match(s.sha256, /^[0-9a-f]{64}$/);
  // Every land ring has a cap that really contains its vertices (sampled).
  for (const r of d.layers.land.rings.slice(0, 60)) for (let i = 0; i < r.xyz.length / 3; i += 7) assert.ok(r.xyz[3 * i] * r.cx + r.xyz[3 * i + 1] * r.cy + r.xyz[3 * i + 2] * r.cz >= r.cosR - 1e-7);
});

test('the bundled pack puts well-known places where they belong and never invents any', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'globe-pack.json'), 'utf8'));
  const d = GD.load(pack);
  const find = n => d.places.find(p => p.text === n);
  for (const [name, lat, lon] of [['New York', 40.71, -74.0], ['Sydney', -33.87, 151.21], ['Tokyo', 35.68, 139.69], ['London', 51.51, -0.13]]) {
    const p = find(name);
    if (!p) continue;      // the set is one city per time-zone region, so not every famous city is in it
    near(p.lat, lat, 1.2, name + ' latitude');near(p.lon, lon, 1.2, name + ' longitude');
  }
  assert.ok(d.places.every(p => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180));
  assert.match(d.placesBasis, /time.?zone/i);
});
