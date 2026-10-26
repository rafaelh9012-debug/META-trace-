// The PMTiles v3 reader: tile ids against the specification's vectors, header and directory decoding, leaf directories,
// compression, refusals with readable reasons, and the property the whole design rests on: reading touches kilobytes, not the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../pmtiles-reader.js');
const W = require('./helpers/pmtiles-writer.cjs');

const tile = (z, x, y, n = 40) => ({z, x, y, data: Buffer.from(Array.from({length: n}, (_, i) => (z * 31 + x * 7 + y * 13 + i) & 255))});
const rejects = (promise, code) => assert.rejects(promise, e => e instanceof P.PMTilesError && (!code || e.code === code));

test('tile ids follow the specification: zoom 0, then the Hilbert order of zoom 1, then zoom 2', () => {
  assert.equal(P.zxyToTileId(0, 0, 0), 0);
  assert.deepEqual([[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]].map(t => P.zxyToTileId(...t)), [1, 2, 3, 4]);
  assert.equal(P.zxyToTileId(2, 0, 0), 5);
  for (let z = 0; z <= 12; z++) assert.equal(P.zxyToTileId(z, 0, 0), (4 ** z - 1) / 3, 'the first id of zoom ' + z);
});

test('a well-known tile keeps its published id (zoom 12, x 3423, y 1763 is 19078479 in the upstream test suite)', () => {
  assert.equal(P.zxyToTileId(12, 3423, 1763), 19078479);
  assert.deepEqual(P.tileIdToZxy(19078479), [12, 3423, 1763]);
});

test('ids and coordinates are inverses, for every tile up to zoom 6 and a spread of larger ones', () => {
  const seen = new Set();
  for (let z = 0; z <= 6; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
    const id = P.zxyToTileId(z, x, y);
    assert.ok(!seen.has(id), 'ids are unique'); seen.add(id);
    assert.deepEqual(P.tileIdToZxy(id), [z, x, y]);
  }
  for (const z of [10, 14, 17, 20, 24, 26]) for (const f of [0, 0.3, 0.77, 1]) {
    const n = 2 ** z, x = Math.min(n - 1, Math.floor(n * f)), y = Math.min(n - 1, Math.floor(n * (1 - f * 0.9)));
    assert.deepEqual(P.tileIdToZxy(P.zxyToTileId(z, x, y)), [z, x, y], 'zoom ' + z);
  }
});

test('consecutive ids are neighbouring tiles (the curve never jumps), which is what makes clustered archives read in runs', () => {
  for (let z = 1; z <= 7; z++) {
    let prev = P.tileIdToZxy((4 ** z - 1) / 3);
    for (let i = 1; i < 4 ** z; i++) {
      const cur = P.tileIdToZxy((4 ** z - 1) / 3 + i);
      assert.equal(Math.abs(cur[1] - prev[1]) + Math.abs(cur[2] - prev[2]), 1, 'zoom ' + z + ' step ' + i);
      prev = cur;
    }
  }
});

test('out-of-range tiles are refused', () => {
  assert.throws(() => P.zxyToTileId(27, 0, 0), P.PMTilesError);
  assert.throws(() => P.zxyToTileId(2, 4, 0), P.PMTilesError);
  assert.throws(() => P.zxyToTileId(2, 0, -1), P.PMTilesError);
  assert.throws(() => P.zxyToTileId(1.5, 0, 0), P.PMTilesError);
  assert.throws(() => P.tileIdToZxy(-1), P.PMTilesError);
});

test('the header is decoded field by field', async () => {
  const bytes = W.build([tile(3, 1, 2), tile(5, 9, 11)], {bounds: [150.5, -34.25, 151.75, -33.5], metadata: {name: 'x'}});
  const h = P.parseHeader(new Uint8Array(bytes.subarray(0, 127)));
  assert.equal(h.specVersion, 3);
  assert.deepEqual([h.minZoom, h.maxZoom, h.numAddressedTiles, h.numTileContents], [3, 5, 2, 2]);
  assert.deepEqual([h.minLon, h.minLat, h.maxLon, h.maxLat], [150.5, -34.25, 151.75, -33.5]);
  assert.deepEqual([h.clustered, h.internalCompressionName, h.tileCompressionName, h.tileTypeName], [true, 'gzip', 'gzip', 'mvt']);
  assert.equal(h.rootDirOffset, 127);
});

test('files that are not PMTiles, are another version or are cut short are refused with a reason', async () => {
  const good = W.build([tile(0, 0, 0)]);
  assert.throws(() => P.parseHeader(new Uint8Array(10)), e => e.code === 'not_pmtiles');
  assert.throws(() => P.parseHeader(new Uint8Array(200).fill(65)), e => e.code === 'not_pmtiles' && /does not start with/.test(e.message));
  const v2 = Buffer.from(good); v2[7] = 2;
  assert.throws(() => P.parseHeader(new Uint8Array(v2)), e => e.code === 'unsupported_version' && /version 2/.test(e.message));
  await rejects(P.open(P.bytesSource(new Uint8Array(good.subarray(0, good.length - 5)))), 'truncated');
  const badZoom = Buffer.from(good); badZoom[100] = 9; badZoom[101] = 3;
  assert.throws(() => P.parseHeader(new Uint8Array(badZoom)), e => e.code === 'bad_header');
  const badBounds = Buffer.from(good); badBounds.writeInt32LE(2000000000, 102);
  assert.throws(() => P.parseHeader(new Uint8Array(badBounds)), e => e.code === 'bad_header');
});

test('MapLibre Tile (type 6, spec 3.5+) packages are named and refused, not read as MVT', async () => {
  const bytes = new Uint8Array(W.build([tile(0, 0, 0)], {tileType: 6}));
  assert.equal(P.parseHeader(bytes).tileTypeName, 'MapLibre Tile (mlt)');
  await assert.rejects(P.open(P.bytesSource(bytes)), e => e.code === 'unsupported_tiles' && /MapLibre Tile/.test(e.message) && /MVT/.test(e.message));
});

test('unsupported content is named, not guessed at: raster tiles, brotli and zstd', async () => {
  await rejects(P.open(P.bytesSource(new Uint8Array(W.build([tile(0, 0, 0)], {tileType: 2})))), 'unsupported_tiles');
  for (const kind of [3, 4]) {
    const b = Buffer.from(W.build([tile(0, 0, 0)])); b[98] = kind;
    await assert.rejects(P.open(P.bytesSource(new Uint8Array(b))), e => e.code === 'unsupported_compression' && /gzip/.test(e.message));
    const c = Buffer.from(W.build([tile(0, 0, 0)])); c[97] = kind;
    await rejects(P.open(P.bytesSource(new Uint8Array(c))), 'unsupported_compression');
  }
});

test('a tile comes back exactly as stored, with gzip or without, and a missing tile is null', async () => {
  for (const [tc, ic] of [[2, 2], [1, 1], [2, 1], [1, 2]]) {
    const tiles = [tile(0, 0, 0), tile(2, 1, 3, 200), tile(4, 7, 7, 1000), tile(4, 8, 9)];
    const r = await P.open(P.bytesSource(new Uint8Array(W.build(tiles, {tileCompression: tc, internalCompression: ic}))));
    for (const t of tiles) assert.deepEqual(Buffer.from(await r.getTile(t.z, t.x, t.y)), t.data, 'tile ' + [t.z, t.x, t.y] + ' (tiles ' + tc + ', directories ' + ic + ')');
    assert.equal(await r.getTile(4, 0, 0), null, 'an addressable tile that is not in the archive');
    assert.equal(await r.getTile(9, 0, 0), null, 'beyond the archive\'s zoom range');
    assert.equal(await r.getTile(1, 0, 0), null, 'below it');
  }
});

test('integers beyond 32 bits survive: offsets and lengths are read as numbers up to 2^53', () => {
  const big = [{tileId: 5e9, offset: 6e9, length: 123456789, runLength: 1}, {tileId: 5e9 + 7, offset: 6e9 + 123456789, length: 99, runLength: 3}];
  const entries = P.parseDirectory(new Uint8Array(W.serializeDirectory(big)));
  assert.deepEqual(entries, big);
});

test('identical neighbouring tiles share bytes and are found through run lengths', async () => {
  const same = Buffer.from('same tile');
  const tiles = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) tiles.push({z: 2, x, y, data: same});
  tiles.push(tile(3, 5, 5));
  const bytes = W.build(tiles), h = P.parseHeader(new Uint8Array(bytes.subarray(0, 127)));
  assert.equal(h.numAddressedTiles, 17);
  assert.equal(h.numTileContents, 2, 'sixteen tiles, one stored copy');
  assert.ok(h.numTileEntries < 17, 'runs are merged into fewer entries (' + h.numTileEntries + ')');
  const r = await P.open(P.bytesSource(new Uint8Array(bytes)));
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) assert.deepEqual(Buffer.from(await r.getTile(2, x, y)), same);
});

test('leaf directories: thousands of tiles, every sampled one found, few directories read', async () => {
  const tiles = []; for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) tiles.push(tile(6, x, y, 12 + ((x * y) % 5)));
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) tiles.push(tile(4, x, y, 20));
  const bytes = W.build(tiles, {leafSize: 200}), h = P.parseHeader(new Uint8Array(bytes.subarray(0, 127)));
  assert.ok(h.leafDirsLength > 0, 'the archive has leaf directories');
  const r = await P.open(P.bytesSource(new Uint8Array(bytes)));
  let checked = 0;
  for (let i = 0; i < tiles.length; i += 37) {const t = tiles[i]; assert.deepEqual(Buffer.from(await r.getTile(t.z, t.x, t.y)), t.data); checked++;}
  assert.ok(checked > 100);
  assert.ok(r.stats.directoriesRead < 60, 'directories read: ' + r.stats.directoriesRead);
  const again = r.stats.directoriesRead; await r.getTile(6, 3, 3); await r.getTile(6, 3, 3);
  assert.equal(r.stats.directoriesRead, again, 'a directory already read is not read again');
});

test('reading touches kilobytes, not the file: opening and fetching three tiles from a 40 MB archive', async () => {
  const tiles = []; const payload = Buffer.alloc(20000);
  for (let i = 0; i < 2000; i++) {payload.writeUInt32LE(i * 2654435761 >>> 0, 0); tiles.push({z: 11, x: i % 45, y: Math.floor(i / 45), data: Buffer.from(Buffer.concat([payload, Buffer.from(String(i))]))});}
  const bytes = new Uint8Array(W.build(tiles, {tileCompression: 1, leafSize: 500}));
  assert.ok(bytes.length > 38e6, 'archive size ' + bytes.length);
  const r = await P.open(P.bytesSource(bytes));
  for (const i of [3, 900, 1999]) assert.equal((await r.getTile(11, i % 45, Math.floor(i / 45))).length, 20000 + String(i).length);
  assert.ok(r.stats.bytesRead < 150000, 'bytes read ' + r.stats.bytesRead + ' of ' + bytes.length + ' (' + (r.stats.bytesRead / bytes.length * 100).toFixed(2) + ' %)');
  assert.equal(r.stats.tilesRead, 3);
});

test('blob sources read only the range asked for, and refuse reads past the end', async () => {
  const bytes = new Uint8Array(W.build([tile(1, 0, 1)]));
  const blob = new Blob([bytes]);
  let sliced = 0; const spy = {size: blob.size, slice: (a, b) => {sliced += b - a; return blob.slice(a, b);}};
  const src = P.blobSource(spy);
  const r = await P.open(src);
  assert.deepEqual(Buffer.from(await r.getTile(1, 0, 1)), tile(1, 0, 1).data);
  assert.ok(sliced < bytes.length + 130, 'sliced ' + sliced);
  await assert.rejects(src.read(bytes.length - 2, 10), e => e.code === 'bad_range');
});

test('describe summarises an archive from its header and metadata alone, and strips markup from the attribution', async () => {
  const bytes = new Uint8Array(W.build([tile(2, 1, 1)], {bounds: [10, 20, 11, 21], metadata: {name: 'Test region', description: 'A test', attribution: '<a href="https://example.org">© Example</a> contributors', version: '3', vector_layers: [{id: 'roads'}, {id: 'buildings'}], meta_trace: {license: 'ODbL 1.0', synthetic: true}}}));
  const d = await P.describe(P.bytesSource(bytes));
  assert.deepEqual([d.name, d.description, d.attribution, d.licenseNote, d.synthetic], ['Test region', 'A test', '© Example contributors', 'ODbL 1.0', true]);
  assert.deepEqual(d.layers, ['roads', 'buildings']);
  assert.deepEqual(d.bounds, [10, 20, 11, 21]);
  assert.equal(d.bytes, bytes.length);
  assert.ok(d.bytesRead < 1000, 'describe read ' + d.bytesRead + ' bytes');
});

test('gunzip decodes what zlib wrote', async () => {
  const data = Buffer.from('hello '.repeat(500));
  assert.deepEqual(Buffer.from(await P.gunzip(new Uint8Array(zlib.gzipSync(data)))), data);
});

test('credits written as HTML become plain text: tags removed, entities decoded, unknown entities left alone', () => {
  assert.equal(P.plainText('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'), '© OpenStreetMap contributors');
  assert.equal(P.plainText('Tom &amp; Jerry &#169; &#x263A; &quot;maps&quot;   &nbsp;ok'), 'Tom & Jerry © ☺ "maps" ok');
  assert.equal(P.plainText('&bogus; &#xD800; &#0;'), '&bogus; &#xD800; &#0;', 'unknown names and invalid code points are not guessed at');
  assert.equal(P.plainText('&lt;b&gt;'), '<b>', 'decoded text is for textContent only: the app never writes credits as markup');
});
