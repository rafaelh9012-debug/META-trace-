// The vector-tile decoder. Two independent kinds of evidence: bytes and geometry written out by hand from the Mapbox Vector
// Tile specification (so the decoder is not only checked against an encoder written by the same hand), and an encoder in
// tests/helpers for everything that needs many shapes: number types, buffers, truncation and corruption.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../mvt-decoder.js');
const W = require('./helpers/mvt-writer.cjs');

const arr = x => Array.from(x);
const lines = g => g.map(arr);

test('a tile written out byte by byte decodes: one layer, one point, one tag', () => {
  // Tile { layers(3): Layer { name(1)="poi", features(2): Feature { id(1)=1, tags(2)=[0,0], type(3)=POINT, geometry(4)=[9,50,34] },
  //        keys(3)="hello", values(4)=Value{string_value(1)="world"}, extent(5)=4096, version(15)=2 } }
  const feature = [0x08, 0x01, 0x12, 0x02, 0x00, 0x00, 0x18, 0x01, 0x22, 0x03, 0x09, 0x32, 0x22];
  const layer = [0x0a, 0x03, 0x70, 0x6f, 0x69, 0x12, feature.length, ...feature, 0x1a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
    0x22, 0x07, 0x0a, 0x05, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x28, 0x80, 0x20, 0x78, 0x02];
  const tile = Uint8Array.from([0x1a, layer.length, ...layer]);
  assert.equal(layer.length, 0x29);
  const t = D.decodeTile(tile);
  assert.equal(t.layers.length, 1);
  const l = t.layers[0];
  assert.deepEqual([l.name, l.version, l.extent, l.features.length], ['poi', 2, 4096, 1]);
  const f = l.features[0];
  assert.deepEqual([f.id, f.type, f.typeName, f.props], [1, D.GEOM.POINT, 'point', {hello: 'world'}]);
  assert.deepEqual(arr(f.geometry), [25, 17], 'MoveTo(25,17), the specification\'s point example');
});

test('the specification\'s geometry examples decode to the coordinates it gives', () => {
  assert.deepEqual(arr(D.decodeGeometry(D.GEOM.POINT, [9, 50, 34])), [25, 17], 'a point');
  assert.deepEqual(arr(D.decodeGeometry(D.GEOM.POINT, [17, 10, 14, 3, 9])), [5, 7, 3, 2], 'a multipoint');
  assert.deepEqual(lines(D.decodeGeometry(D.GEOM.LINESTRING, [9, 4, 4, 18, 0, 16, 16, 0])), [[2, 2, 2, 10, 10, 10]], 'a line');
  assert.deepEqual(lines(D.decodeGeometry(D.GEOM.LINESTRING, [9, 4, 4, 18, 0, 16, 16, 0, 9, 17, 17, 10, 4, 8])), [[2, 2, 2, 10, 10, 10], [1, 1, 3, 5]], 'two lines: the second starts relative to where the first ended');
  assert.deepEqual(lines(D.decodeGeometry(D.GEOM.POLYGON, [9, 6, 12, 18, 10, 12, 24, 44, 15])), [[3, 6, 8, 12, 20, 34]], 'a polygon ring, closed implicitly');
});

test('polygons with holes: exterior rings have positive area, interior rings negative, and rings group under their exterior', () => {
  const exterior = [9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15];                                        // (0,0) (10,0) (10,10) (0,10)
  // Every MoveTo is relative to the cursor, which stays where the last ring left it: (0,10) after the exterior ring.
  const hole = [9, 4, 15, 26, 0, 12, 12, 0, 0, 11, 15];                                           // (2,2) (2,8) (8,8) (8,2): the other way round
  const second = [9, 24, 3, 26, 20, 0, 0, 20, 19, 0, 15];                                         // another exterior, from the cursor (8,2) to (20,0)
  const rings = D.decodeGeometry(D.GEOM.POLYGON, [...exterior, ...hole, ...second]);
  assert.equal(rings.length, 3);
  assert.deepEqual(arr(rings[1]), [2, 2, 2, 8, 8, 8, 8, 2]);
  assert.ok(D.ringArea(rings[0]) > 0 && D.ringArea(rings[1]) < 0 && D.ringArea(rings[2]) > 0);
  assert.equal(D.ringArea(rings[0]), 100);
  assert.equal(D.ringArea(rings[1]), -36);
  const polygons = D.groupPolygons(rings);
  assert.deepEqual(polygons.map(p => p.length), [2, 1], 'two polygons, the first with a hole');
});

test('geometry commands that cannot be decoded are named', () => {
  assert.throws(() => D.decodeGeometry(D.GEOM.LINESTRING, [18, 0, 16, 16, 0]), e => e.code === 'bad_geometry' && /before it has started/.test(e.message));
  assert.throws(() => D.decodeGeometry(D.GEOM.POLYGON, [15]), e => e.code === 'bad_geometry');
  assert.throws(() => D.decodeGeometry(D.GEOM.POLYGON, [9, 0, 0, 10, 2, 2, 23]), e => e.code === 'bad_geometry' && /ClosePath/.test(e.message));
  assert.throws(() => D.decodeGeometry(D.GEOM.LINESTRING, [9, 4, 4, 26, 0, 16]), e => e.code === 'bad_geometry' && /more coordinates/.test(e.message));
  assert.throws(() => D.decodeGeometry(D.GEOM.LINESTRING, [9, 4, 4, 20, 0, 16]), e => e.code === 'bad_geometry' && /Unknown geometry command/.test(e.message));
});

test('every number type, ids beyond 32 bits and negative coordinates survive an encode and a decode', () => {
  const props = {s: 'text ünï', i: 5, n: -7, u: {uint64: 2 ** 40 + 5}, d: 1.5, f: {float: 0.25}, b: true, f2: false, big: {int64: -(2 ** 40) - 3}, sneg: {sint64: -(2 ** 41) - 1}, int64: {int64: 2 ** 45 + 9}};
  const tile = W.encodeTile([{name: 'x', features: [{id: 2 ** 40 + 1, type: 1, props, geometry: [-100, -200, 4095, 4096, 70000, -70000]}]}]);
  const f = D.decodeTile(new Uint8Array(tile)).layers[0].features[0];
  assert.equal(f.id, 2 ** 40 + 1);
  assert.deepEqual(f.props, {s: 'text ünï', i: 5, n: -7, u: 2 ** 40 + 5, d: 1.5, f: 0.25, b: true, f2: false, big: -(2 ** 40) - 3, sneg: -(2 ** 41) - 1, int64: 2 ** 45 + 9});
  assert.deepEqual(arr(f.geometry), [-100, -200, 4095, 4096, 70000, -70000]);
});

test('a line with many vertices, a polygon with a hole and a multipoint keep their shapes', () => {
  const line = []; for (let i = 0; i < 500; i++) line.push(i * 8 - 100, Math.round(2000 + 1500 * Math.sin(i / 20)));
  const tile = W.encodeTile([{name: 'roads', features: [
    {type: 2, geometry: [line, [0, 0, 10, 10]], props: {kind: 'minor_road'}},
    {type: 3, geometry: [[0, 0, 100, 0, 100, 100, 0, 100], [20, 20, 20, 80, 80, 80, 80, 20]], props: {kind: 'building'}},
    {type: 1, geometry: [1, 2, 3, 4, 5, 6], props: {kind: 'pois'}}
  ]}]);
  const [roads, building, pois] = D.decodeTile(new Uint8Array(tile)).layers[0].features;
  assert.deepEqual(arr(roads.geometry[0]), line);
  assert.deepEqual(arr(roads.geometry[1]), [0, 0, 10, 10]);
  assert.equal(building.geometry.length, 2);
  assert.ok(D.ringArea(building.geometry[0]) > 0 && D.ringArea(building.geometry[1]) < 0, 'the encoder\'s hole winds the other way and the decoder sees it');
  assert.deepEqual(arr(pois.geometry), [1, 2, 3, 4, 5, 6]);
});

test('layers can be selected, and the others are skipped without being parsed', () => {
  const tile = new Uint8Array(W.encodeTile([
    {name: 'roads', features: [{type: 2, geometry: [[0, 0, 5, 5]], props: {a: 1}}]},
    {name: 'pois', features: [{type: 1, geometry: [1, 1]}]},
    {name: 'buildings', extent: 8192, features: [{type: 3, geometry: [[0, 0, 4, 0, 4, 4]]}]}
  ]));
  assert.deepEqual(D.decodeTile(tile).layers.map(l => l.name), ['roads', 'pois', 'buildings']);
  assert.deepEqual(D.decodeTile(tile, {layers: ['buildings', 'roads']}).layers.map(l => l.name), ['roads', 'buildings']);
  assert.equal(D.decodeTile(tile, {layers: ['buildings']}).layers[0].extent, 8192);
  assert.deepEqual(D.decodeTile(tile, {layers: []}).layers, []);
});

test('fields nobody defines are skipped, and a layer name that comes after its features is accepted', () => {
  const layers = [{name: 'late', features: [{id: 4, type: 1, props: {k: 'v'}, geometry: [3, 4]}]}];
  for (const options of [{unknownFields: true}, {nameLast: true}, {unknownFields: true, nameLast: true}]) {
    const t = D.decodeTile(new Uint8Array(W.encodeTile(layers, options)));
    assert.equal(t.layers[0].name, 'late');
    assert.deepEqual([t.layers[0].features[0].id, t.layers[0].features[0].props, arr(t.layers[0].features[0].geometry)], [4, {k: 'v'}, [3, 4]], JSON.stringify(options));
  }
});

test('a feature with an unreadable geometry is dropped and counted; its neighbours survive', () => {
  const tile = new Uint8Array(W.encodeTile([{name: 'roads', features: [
    {type: 2, geometry: [[0, 0, 9, 9]]},
    {type: 2, rawGeometry: [18, 0, 16, 16, 0]},                  // LineTo before MoveTo
    {type: 2, rawGeometry: [9, 4, 4, 26, 0, 16]},                // asks for coordinates it does not have
    {type: 2, geometry: [[1, 1, 2, 2]]}
  ]}]));
  const t = D.decodeTile(tile);
  assert.equal(t.layers[0].features.length, 2);
  assert.equal(t.skipped, 2);
  assert.equal(t.layers[0].skipped, 2);
});

test('versions other than 1 and 2, nonsense extents and non-tiles are refused with a reason', () => {
  assert.throws(() => D.decodeTile(new Uint8Array(W.encodeTile([{name: 'x', version: 3, features: []}]))), e => e.code === 'unsupported_version' && /version 3/.test(e.message));
  assert.throws(() => D.decodeTile(new Uint8Array(W.encodeTile([{name: 'x', extent: 0, features: []}]))), e => e.code === 'bad_extent');
  assert.throws(() => D.decodeTile('not bytes'), e => e.code === 'bad_input');
  assert.deepEqual(D.decodeTile(new Uint8Array(0)).layers, [], 'an empty tile is an empty map');
});

test('a tile cut off anywhere, or with any byte changed, never throws anything but a named decoding error', () => {
  const tile = new Uint8Array(W.encodeTile([
    {name: 'roads', features: [{id: 9, type: 2, geometry: [[0, 0, 100, 100, 200, 50]], props: {kind: 'major_road', name: 'Main Street', rank: 3}}]},
    {name: 'buildings', features: [{type: 3, geometry: [[0, 0, 50, 0, 50, 50, 0, 50]], props: {height: 12.5}}]}
  ]));
  const check = bytes => {
    try {D.decodeTile(bytes);} catch (error) {assert.ok(error instanceof D.MVTError, 'only MVTError: ' + (error && error.stack));}
  };
  for (let n = 0; n < tile.length; n++) check(tile.slice(0, n));
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 4000; round++) {
    const mutated = tile.slice();
    for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
    check(mutated);
  }
});

test('eleven-byte numbers and impossible lengths are refused, not followed', () => {
  assert.throws(() => D.decodeTile(Uint8Array.from([0x1a, 0xff, 0xff, 0xff, 0xff, 0x0f])), e => e.code === 'truncated');                      // a 4 GiB layer in a 6-byte tile
  assert.throws(() => D.decodeTile(Uint8Array.from([0x08, ...new Array(11).fill(0x80), 0x01])), e => e.code === 'bad_varint');
  assert.throws(() => D.decodeTile(Uint8Array.from([0x0f])), e => e.code === 'bad_wire_type');                                                  // field 1, wire type 7
});

test('a dense tile decodes quickly and without keeping a small array per vertex', () => {
  const features = [];
  for (let i = 0; i < 6000; i++) {
    const ring = []; const x = (i % 80) * 50, y = Math.floor(i / 80) * 50;
    ring.push(x, y, x + 40, y, x + 40, y + 30, x + 5, y + 36);
    features.push({type: 3, geometry: [ring], props: {kind: 'building', height: 6 + (i % 9), name: i % 7 === 0 ? 'Building ' + i : undefined}});
  }
  for (let i = 0; i < 3000; i++) {const l = []; for (let k = 0; k < 12; k++) l.push(k * 300 + (i % 50), 100 + i % 3800 + k * 3); features.push({type: 2, geometry: [l], props: {kind: 'minor_road', name: 'Street ' + (i % 400)}});}
  const bytes = new Uint8Array(W.encodeTile([{name: 'dense', features}]));
  const t0 = process.hrtime.bigint(), t = D.decodeTile(bytes), ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(t.layers[0].features.length, 9000);
  assert.ok(t.layers[0].features[0].geometry[0] instanceof Int32Array, 'geometry is held in typed arrays');
  console.log('    decoded a ' + (bytes.length / 1024).toFixed(0) + ' KiB tile with 9000 features in ' + ms.toFixed(1) + ' ms (node, not a browser)');
  assert.ok(ms < 1500);
});
