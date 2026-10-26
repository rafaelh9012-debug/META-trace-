// The region manager: which tiles a view needs, loading them a few at a time, a bounded cache, whole-level swaps, missing
// and failing tiles, overlapping packages, the antimeridian. Packages are synthetic (tests/helpers/test-package.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const PM = require('../pmtiles-reader.js');
const MVT = require('../mvt-decoder.js');
const TS = require('../tile-schema.js');
const RM = require('../region-manager.js');
const {makeSyntheticPackage} = require('./helpers/test-package.cjs');

const SYDNEY = [151.19, -33.88, 151.24, -33.84];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(options = {}) {
  const pkg = makeSyntheticPackage({bounds: SYDNEY, minZoom: 9, maxZoom: 15, ...options});
  const reader = await PM.open(PM.bytesSource(new Uint8Array(pkg.bytes)));
  const d = await PM.describe(PM.bytesSource(new Uint8Array(pkg.bytes)));
  return {pkg, reader, info: {bounds: d.bounds, minZoom: d.minZoom, maxZoom: d.maxZoom, name: d.name, attribution: d.attribution}};
}
const manager = (opts = {}) => RM.create({decode: MVT.decodeTile, adapt: TS.adaptTile, schedule: fn => setImmediate(fn), ...opts});
const viewAround = (lat, lon, zoom, halfDeg = 0.01) => ({zoom, west: lon - halfDeg, east: lon + halfDeg, south: lat - halfDeg, north: lat + halfDeg});

test('the tiles for a view cover it completely, one level finer than the map zoom, and are few', async () => {
  const {reader, info} = await open();
  const m = manager(); m.addPackage({id: 'a', name: info.name, reader, info});
  const view = viewAround(-33.86, 151.215, 13.5, 0.012);
  const n = m.needed(view);
  assert.equal(n.tz, 13, 'round(13.5) - 1');
  assert.ok(n.list.length >= 1 && n.list.length <= 12, 'tiles: ' + n.list.length);
  // every point of the view lies inside one of the tiles
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const lon = view.west + (view.east - view.west) * i / 8, lat = view.south + (view.north - view.south) * j / 8;
    const x = Math.floor(RM.lonToX(lon, n.tz)), y = Math.floor(RM.latToY(lat, n.tz));
    assert.ok(n.list.some(t => t.x === x && t.y === y), 'covered: ' + lat.toFixed(4) + ',' + lon.toFixed(4));
  }
  assert.deepEqual([m.needed({...view, zoom: 8}).list.length, m.needed(viewAround(10, 10, 14)).list.length], [0, 0], 'below the zoom packages are used from, or away from the package');
  assert.equal(m.tileZoomFor(20, {minZoom: 9, maxZoom: 15}), 15);
  assert.equal(m.tileZoomFor(9.4, {minZoom: 9, maxZoom: 15}), 9);
});

test('a view is loaded a tile at a time from byte ranges, and only the tiles it needs are read', async () => {
  const {pkg, reader, info} = await open();
  let reads = 0, maxParallel = 0, parallel = 0;
  const counting = {getTile: async (z, x, y) => {reads++; parallel++; maxParallel = Math.max(maxParallel, parallel); await sleep(5); try {return await reader.getTile(z, x, y);} finally {parallel--;}}};
  const m = manager({concurrency: 2}); m.addPackage({id: 'a', reader: counting, info});
  const d0 = m.drawable(viewAround(-33.86, 151.215, 14.2, 0.008));
  assert.equal(d0.tiles.length, 0, 'nothing is drawn before anything has arrived, and nothing blocks');
  assert.equal(d0.loading, true);
  await m.whenIdle();
  const d1 = m.drawable(viewAround(-33.86, 151.215, 14.2, 0.008));
  assert.equal(d1.complete, true);
  assert.ok(d1.tiles.length >= 1);
  assert.ok(maxParallel <= 2, 'at most two reads at once (' + maxParallel + ')');
  assert.equal(reads, m.needed(viewAround(-33.86, 151.215, 14.2, 0.008)).list.length, 'one read per needed tile');
  const s = m.snapshot();
  assert.ok(s.tileBytesRead > 0 && s.tileBytesRead < pkg.bytes.length / 2, 'tile bytes read ' + s.tileBytesRead + ' of ' + pkg.bytes.length);
  assert.equal(s.loaded, reads);
  assert.ok(d1.tiles.every(t => t.model.groups.length > 0 && t.z === 13));
});

test('a repeated view asks for nothing new, and a tile that is not in the archive is remembered as missing', async () => {
  const {reader, info} = await open();
  const reads = new Map();
  const m = manager(); m.addPackage({id: 'a', reader: {getTile: (z, x, y) => {const k = z + '/' + x + '/' + y; reads.set(k, (reads.get(k) || 0) + 1); return x % 2 === 1 ? Promise.resolve(null) : reader.getTile(z, x, y);}}, info});
  const v = viewAround(-33.86, 151.215, 14.6, 0.02);
  m.ensure(v); await m.whenIdle();
  const total = [...reads.values()].reduce((a, b) => a + b, 0);
  assert.ok(m.snapshot().empty > 0 && m.snapshot().ready > 0, 'some tiles are missing and some are not: ' + JSON.stringify(m.snapshot()));
  for (let i = 0; i < 5; i++) m.drawable(v);
  m.ensure({...v, zoom: 14.7, west: v.west + 0.0002}); await m.whenIdle();
  assert.equal([...reads.values()].reduce((a, b) => a + b, 0), total, 'nothing was read again, the missing tiles included');
  assert.ok([...reads.values()].every(n => n === 1), 'each tile was asked for once');
  const d = m.drawable(v);
  assert.equal(d.complete, true, 'a missing tile is a settled tile: the view is not held back');
  assert.ok(d.tiles.every(t => t.x % 2 === 0), 'only tiles that exist are drawn');
});

test('crossing to a new tile level holds the old level until the whole new level is in: never a hole, never a mix', async () => {
  const {reader, info} = await open();
  let slow = false;
  const m = manager({swapTimeoutMs: 5000}); m.addPackage({id: 'a', reader: {getTile: async (z, x, y) => {if (slow) await sleep(40); return reader.getTile(z, x, y);}}, info});
  const low = viewAround(-33.86, 151.215, 13.5, 0.008), high = viewAround(-33.86, 151.215, 15.6, 0.004);
  m.ensure(low); await m.whenIdle();
  const base = m.drawable(low);
  assert.ok(base.complete && base.tiles.length > 0 && base.tiles.every(t => t.z === 13));
  slow = true;
  const seen = [];
  let d = m.drawable(high);
  seen.push(d);
  assert.equal(d.complete, false);
  assert.ok(d.tiles.length > 0 && d.tiles.every(t => t.z === 13), 'still the old level while the new one arrives');
  for (let i = 0; i < 400 && !d.complete; i++) {await sleep(10); d = m.drawable(high); seen.push(d);}
  assert.ok(d.complete);
  assert.ok(d.tiles.length > 0 && d.tiles.every(t => t.z === 15), 'then the new level, all of it');
  for (const s of seen) assert.equal(new Set(s.tiles.map(t => t.z)).size <= 1, true, 'one level at a time');
});

test('if the new level is slow, it takes over after the timeout with what has arrived', async () => {
  const {reader, info} = await open();
  let delay = 0, clock = 0;
  const m = manager({swapTimeoutMs: 300, now: () => clock}); m.addPackage({id: 'a', reader: {getTile: async (z, x, y) => {if (delay) await sleep(delay); return reader.getTile(z, x, y);}}, info});
  const low = viewAround(-33.86, 151.215, 13.5, 0.008), high = viewAround(-33.86, 151.215, 15.6, 0.004);
  m.ensure(low); await m.whenIdle(); m.drawable(low);
  delay = 5000;
  assert.ok(m.drawable(high).tiles.every(t => t.z === 13));
  clock += 301;
  const after = m.drawable(high);
  assert.equal(after.complete, false);
  assert.equal(after.tz, 15, 'the new level takes over, however little of it is there');
});

test('the cache stays inside its budget, never evicts what the view needs, and reloads what it dropped', async () => {
  const {reader, info} = await open({spacing: 0.001});
  let reads = 0;
  // zoom 16.6 reads zoom-15 tiles (0.011 degrees wide): the 0.05 x 0.04 degree package has about twenty of them
  const m = manager({maxTiles: 6, concurrency: 3}); m.addPackage({id: 'a', reader: {getTile: (z, x, y) => {reads++; return reader.getTile(z, x, y);}}, info});
  for (const [lat, lon] of [[-33.875, 151.195], [-33.865, 151.205], [-33.855, 151.215], [-33.845, 151.225], [-33.855, 151.235], [-33.865, 151.215]]) {
    const v = viewAround(lat, lon, 16.6, 0.004);
    m.ensure(v); await m.whenIdle();
    const d = m.drawable(v);
    assert.ok(d.tiles.length > 0 && d.complete, 'the current view is drawn in full');
    assert.ok(m.snapshot().tiles <= 6 + m.needed(v).list.length, 'tiles cached: ' + m.snapshot().tiles + ' for a budget of 6 and ' + m.needed(v).list.length + ' in view');
  }
  const s = m.snapshot();
  assert.ok(s.evicted > 0, 'something was evicted');
  const before = reads; const back = viewAround(-33.875, 151.195, 16.6, 0.004);
  m.ensure(back); await m.whenIdle();
  assert.ok(reads > before, 'an evicted tile is read again when the view comes back');
});

test('the byte budget evicts too', async () => {
  const {reader, info} = await open({spacing: 0.0007});
  const m = manager({maxBytes: 150000, maxTiles: 1000}); m.addPackage({id: 'a', reader, info});
  for (const lat of [-33.875, -33.86, -33.845]) {m.ensure(viewAround(lat, 151.215, 14.6, 0.006)); await m.whenIdle();}
  const s = m.snapshot();
  assert.ok(s.evicted > 0 && s.bytes <= 150000 * 1.6, 'estimated bytes held: ' + s.bytes);
});

test('a tile that fails is reported and left out, the rest of the view still draws, and it is retried only after a pause', async () => {
  const {reader, info} = await open();
  let clock = 0, broken = true, errors = [];
  const needed = RM.create({decode: MVT.decodeTile, adapt: TS.adaptTile}).needed;   // (unused: just to prove create() needs no package)
  assert.equal(typeof needed, 'function');
  const m = manager({now: () => clock, errorRetryMs: 1000, onError: (id, e) => errors.push([id, e.message])});
  const v = viewAround(-33.86, 151.215, 14.6, 0.01);
  m.addPackage({id: 'a', reader: {getTile: async (z, x, y) => {if (broken && x % 2 === 0) throw new PM.PMTilesError('bad_range', 'the file ended early'); return reader.getTile(z, x, y);}}, info});
  m.ensure(v); await m.whenIdle();
  const d = m.drawable(v);
  assert.ok(errors.length > 0 && errors.every(e => e[0] === 'a' && /ended early/.test(e[1])));
  assert.ok(d.tiles.length > 0, 'the tiles that loaded are drawn');
  assert.equal(d.complete, true, 'a failed tile counts as settled: the view is not held back by it');
  const failed = m.snapshot().failed;
  m.ensure({...v, zoom: 14.7}); await m.whenIdle();
  assert.equal(m.snapshot().failed, failed, 'not retried straight away');
  broken = false; clock += 1500;
  m.ensure({...v, zoom: 14.8, west: v.west - 0.0001}); await m.whenIdle();
  assert.ok(m.drawable(v).tiles.length > d.tiles.length, 'after the pause the tile is tried again and arrives');
});

test('removing a package drops its tiles, cancels what is queued and ignores what was in flight', async () => {
  const {reader, info} = await open();
  const m = manager({concurrency: 1}); let release;
  const gate = new Promise(r => {release = r;});
  m.addPackage({id: 'a', reader: {getTile: async (z, x, y) => {await gate; return reader.getTile(z, x, y);}}, info});
  const v = viewAround(-33.86, 151.215, 14.6, 0.01);
  m.ensure(v);
  assert.equal(m.removePackage('a'), true);
  assert.equal(m.removePackage('a'), false);
  release(); await sleep(30);
  const s = m.snapshot();
  assert.deepEqual([s.packages, s.ready, s.bytes], [0, 0, 0], 'nothing of it is left');
  assert.equal(m.drawable(v).tiles.length, 0);
  assert.equal(m.covers(-33.86, 151.215), null);
});

test('overlapping packages: the smaller one wins where both cover, and each tile is drawn from exactly one', async () => {
  const wide = await open({name: 'Wide', bounds: [151.15, -33.92, 151.28, -33.8], maxZoom: 13});
  const smallBounds = [151.195, -33.875, 151.235, -33.845];
  const smallPkg = makeSyntheticPackage({bounds: smallBounds, minZoom: 9, maxZoom: 15, name: 'Small'});
  const smallReader = await PM.open(PM.bytesSource(new Uint8Array(smallPkg.bytes)));
  const m = manager();
  m.addPackage({id: 'wide', name: 'Wide', reader: wide.reader, info: wide.info});
  m.addPackage({id: 'small', name: 'Small', reader: smallReader, info: {bounds: smallBounds, minZoom: 9, maxZoom: 15}});
  assert.equal(m.covers(-33.86, 151.215).id, 'small');
  assert.equal(m.covers(-33.9, 151.17).id, 'wide');
  assert.equal(m.covers(0, 0), null);
  assert.deepEqual(m.packages().map(p => p.id), ['small', 'wide']);
  const n = m.needed(viewAround(-33.86, 151.215, 14.6, 0.04));
  const keys = n.list.map(t => t.z + '/' + t.x + '/' + t.y);
  assert.equal(new Set(keys).size, keys.length, 'no tile twice');
  assert.ok(n.list.some(t => t.pkg === 'small') && n.list.some(t => t.pkg === 'wide'));
  assert.equal(m.coverageBoxes().length, 2);
});

test('across the antimeridian a tile is drawn in the world copy it belongs to', async () => {
  const west = makeSyntheticPackage({bounds: [-180, -17.8, -179.95, -17.7], minZoom: 9, maxZoom: 14});
  const reader = await PM.open(PM.bytesSource(new Uint8Array(west.bytes)));
  const m = manager(); m.addPackage({id: 'w', reader, info: {bounds: west.bounds, minZoom: 9, maxZoom: 14}});
  const view = {zoom: 14.6, west: 179.97, east: 180.03, south: -17.76, north: -17.74};      // runs past +180 into the next world copy
  const n = m.needed(view);
  assert.ok(n.list.length > 0 && n.list.every(t => t.shift === 256 && t.x < 4), 'tiles from the western edge of the map, drawn one world to the right: ' + JSON.stringify(n.list.slice(0, 2)));
  m.ensure(view); await m.whenIdle();
  const d = m.drawable(view);
  assert.ok(d.tiles.length > 0 && d.tiles.every(t => t.shift === 256));
  const east = makeSyntheticPackage({bounds: [179.95, -17.8, 180, -17.7], minZoom: 9, maxZoom: 14});
  const m2 = manager(); m2.addPackage({id: 'e', reader: await PM.open(PM.bytesSource(new Uint8Array(east.bytes))), info: {bounds: east.bounds, minZoom: 9, maxZoom: 14}});
  const n2 = m2.needed(view);
  assert.ok(n2.list.length > 0 && n2.list.every(t => t.shift === 0 && t.x > 2 ** 14 - 4));
});

test('labels of the drawn tiles come out once each, only when due, with the longest-lived names first in priority', async () => {
  const {reader, info} = await open({spacing: 0.002});
  const m = manager(); m.addPackage({id: 'a', reader, info});
  const v = viewAround(-33.86, 151.215, 15.6, 0.006);
  m.ensure(v); await m.whenIdle();
  const all = m.labels(v);
  assert.ok(all.length > 5);
  const keys = all.map(l => l.text + l.lat.toFixed(4) + l.lon.toFixed(4));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(all.some(l => l.text === 'Testville' && l.kind === 'place'));
  assert.ok(all.some(l => l.kind === 'road' && /^(Avenue|Street|Boulevard|Lane)/.test(l.text)));
  const early = m.labels({...v, zoom: 11});
  assert.ok(!early.some(l => l.kind === 'road' && l.minZoom > 11), 'nothing before its zoom');
});

test('a package must describe itself, and bad bounds are refused', async () => {
  const {reader, info} = await open();
  const m = manager();
  assert.throws(() => m.addPackage({id: 'x', reader}), /description/);
  assert.throws(() => m.addPackage({id: 'x', reader, info: {...info, bounds: [1, 2, 3]}}), /bounds/);
  assert.throws(() => m.addPackage({id: 'x', reader, info: {...info, bounds: [1, 2, NaN, 4]}}), /bounds/);
  assert.equal(m.size, 0);
});

test('featuresIn: looks at where the geometry is, never starts a load, and is not settled until the tiles are', async () => {
  // Data in one corner of a box that the header claims is much larger.
  const small = makeSyntheticPackage({bounds: [151.19, -33.88, 151.2, -33.87], minZoom: 9, maxZoom: 15});
  const bytes = Buffer.from(small.bytes);
  [151.1, -33.95, 151.3, -33.78].forEach((v, i) => bytes.writeInt32LE(Math.round(v * 1e7), 102 + 4 * i));
  const reader = await PM.open(PM.bytesSource(new Uint8Array(bytes))), d = await PM.describe(PM.bytesSource(new Uint8Array(bytes)));
  const m = manager();
  m.addPackage({id: 'p', name: 'sparse', reader, info: {bounds: d.bounds, minZoom: d.minZoom, maxZoom: d.maxZoom}});
  const onData = {zoom: 13.5, west: 151.192, east: 151.198, south: -33.876, north: -33.872};
  const away = {zoom: 13.5, west: 151.27, east: 151.28, south: -33.93, north: -33.92};

  assert.equal(m.featuresIn(onData).settled, false, 'nothing has been loaded yet');
  assert.equal(m.snapshot().tiles, 0, 'asking started no load');
  m.ensure(onData); m.ensure(away);
  await m.whenIdle();
  const a = m.featuresIn(onData);
  assert.deepEqual([a.settled, a.features], [true, true]);
  m.ensure(away); await m.whenIdle();
  const b = m.featuresIn(away);
  assert.equal(b.settled, true);
  assert.equal(b.features, false, 'the header covers it, the tiles hold nothing there');
  assert.ok(b.tiles > 0, 'tiles were needed, they were just empty');
});
