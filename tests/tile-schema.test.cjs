// The schema adapter: decoded vector-tile layers to the canvas layer's vocabulary. The tiles here are built to the public
// descriptions of the Protomaps and OpenMapTiles schemas (see the header of tile-schema.js: real extracts have not been used).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../mvt-decoder.js');
const S = require('../tile-schema.js');
const L = require('../trace-canvas-layer.js');
const W = require('./helpers/mvt-writer.cjs');

const decode = layers => D.decodeTile(new Uint8Array(W.encodeTile(layers)));
const adapt = (layers, z = 15, x = 8, y = 12, options) => S.adaptTile(decode(layers), {z, x, y}, options);
const find = (m, kind, highway = '') => m.groups.find(g => g.kind === kind && g.highway === highway);
const sq = (x0, y0, s) => [x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s];

test('Protomaps roads: kind and kind_detail become OpenStreetMap highway classes, and named roads get a label along the road', () => {
  const m = adapt([{name: 'roads', features: [
    {type: 2, geometry: [[100, 100, 900, 120]], props: {kind: 'highway', kind_detail: 'motorway', name: 'Interstate 75'}},
    {type: 2, geometry: [[100, 300, 900, 300]], props: {kind: 'major_road', kind_detail: 'primary', name: 'Archer Road'}},
    {type: 2, geometry: [[100, 500, 900, 500]], props: {kind: 'minor_road', kind_detail: 'residential', name: 'Diamond Road'}},
    {type: 2, geometry: [[100, 700, 900, 700]], props: {kind: 'minor_road'}},
    {type: 2, geometry: [[100, 900, 900, 900]], props: {kind: 'path', kind_detail: 'footway'}},
    {type: 2, geometry: [[100, 1100, 900, 1100]], props: {kind: 'other', kind_detail: 'service', name: 'Alley'}},
    {type: 2, geometry: [[100, 1300, 900, 1300]], props: {kind: 'rail', kind_detail: 'rail'}},
    {type: 2, geometry: [[100, 1500, 900, 1500]], props: {kind: 'ferry'}},
    {type: 2, geometry: [[100, 1700, 900, 1700]], props: {kind: 'major_road', kind_detail: 'trunk_link'}}
  ]}]);
  const highways = m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort();
  assert.deepEqual(highways, ['footway', 'motorway', 'primary', 'residential', 'service', 'trunk_link'].sort());
  assert.ok(find(m, 'rail'), 'rails are kept as their own kind');
  assert.equal(m.stats.dropped, 1, 'the ferry has no drawing rule and is counted as dropped');
  assert.deepEqual(m.labels.map(l => l.text).sort(), ['Alley', 'Archer Road', 'Diamond Road', 'Interstate 75']);
  const major = m.labels.find(l => l.text === 'Archer Road'), minor = m.labels.find(l => l.text === 'Diamond Road');
  assert.ok(major.priority < minor.priority && major.minZoom < minor.minZoom, 'major roads are named earlier and win collisions');
  assert.ok(Math.abs(major.angle) < 1e-9 && major.kind === 'road');
});

test('OpenMapTiles transportation classes map to the same vocabulary', () => {
  const m = adapt([{name: 'transportation', features: [
    {type: 2, geometry: [[0, 10, 500, 10]], props: {class: 'motorway'}},
    {type: 2, geometry: [[0, 110, 500, 110]], props: {class: 'primary', subclass: 'primary_link'}},
    {type: 2, geometry: [[0, 210, 500, 210]], props: {class: 'minor'}},
    {type: 2, geometry: [[0, 310, 500, 310]], props: {class: 'minor', subclass: 'pedestrian'}},
    {type: 2, geometry: [[0, 410, 500, 410]], props: {class: 'service'}},
    {type: 2, geometry: [[0, 510, 500, 510]], props: {class: 'path', subclass: 'cycleway'}},
    {type: 2, geometry: [[0, 610, 500, 610]], props: {class: 'path', subclass: 'unheard_of'}},
    {type: 2, geometry: [[0, 710, 500, 710]], props: {class: 'rail', subclass: 'rail'}},
    {type: 2, geometry: [[0, 810, 500, 810]], props: {class: 'ferry'}},
    {type: 2, geometry: [[0, 910, 500, 910]], props: {class: 'primary_construction'}}
  ]}]);
  assert.deepEqual(m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort(), ['construction', 'cycleway', 'motorway', 'path', 'pedestrian', 'primary_link', 'residential', 'service'].sort());
  assert.ok(find(m, 'rail'));
  assert.equal(m.stats.dropped, 1);
});

test('buildings are filled and outlined; building parts are not, unless asked for; a named building is labelled at its middle', () => {
  const layers = [{name: 'buildings', features: [
    {type: 3, geometry: [sq(1000, 1000, 400)], props: {kind: 'building', height: 12, name: 'Antevy Hall'}},
    {type: 3, geometry: [sq(2000, 2000, 400)], props: {kind: 'building_part'}},
    {type: 3, geometry: [sq(3000, 1000, 300)], props: {kind: 'building'}}
  ]}];
  const m = adapt(layers), b = find(m, 'building');
  assert.equal(b.fill.length, 2);
  assert.equal(b.stroke.length, 2);
  assert.ok(b.stroke.every(s => s.closed), 'a ring that was not cut stays closed');
  assert.equal(m.labels.length, 1);
  assert.deepEqual([m.labels[0].text, m.labels[0].kind], ['Antevy Hall', 'building']);
  assert.equal(adapt(layers, 15, 8, 12, {buildingParts: true}).groups.find(g => g.kind === 'building').fill.length, 3);
  // the label sits at the middle of the building (1200, 1200 in tile units)
  const lon = (8 + 1200 / 4096) / 2 ** 15 * 360 - 180;
  assert.ok(Math.abs(m.labels[0].lon - lon) < 1e-9);
});

test('water polygons and waterway lines, land use and natural cover: only what the styles know is kept', () => {
  const m = adapt([
    {name: 'water', features: [
      {type: 3, geometry: [sq(100, 100, 800)], props: {kind: 'lake', name: 'Liberty Pond'}},
      {type: 2, geometry: [[0, 3000, 4000, 3100]], props: {kind: 'river'}}]},
    {name: 'landuse', features: [
      {type: 3, geometry: [sq(0, 0, 500)], props: {kind: 'park'}},
      {type: 3, geometry: [sq(600, 0, 500)], props: {kind: 'cemetery'}},
      {type: 3, geometry: [sq(1200, 0, 500)], props: {kind: 'parking'}},
      {type: 3, geometry: [sq(1800, 0, 500)], props: {kind: 'pedestrian'}},
      {type: 3, geometry: [sq(2400, 0, 500)], props: {kind: 'industrial'}},
      {type: 3, geometry: [sq(3000, 0, 500)], props: {kind: 'residential'}}]},
    {name: 'natural', features: [{type: 3, geometry: [sq(0, 600, 500)], props: {kind: 'wood'}}, {type: 3, geometry: [sq(600, 600, 500)], props: {kind: 'glacier'}}]},
    {name: 'earth', features: [{type: 3, geometry: [sq(0, 0, 4096)], props: {kind: 'earth'}}]},
    {name: 'boundaries', features: [{type: 2, geometry: [[0, 0, 4000, 4000]], props: {kind: 'region'}}]}
  ]);
  assert.equal(find(m, 'water').fill.length, 1);
  assert.equal(find(m, 'waterway').stroke.length, 1);
  assert.equal(find(m, 'green').fill.length, 3, 'park, cemetery, wood');
  assert.equal(find(m, 'parking').fill.length, 1);
  assert.equal(find(m, 'paved').fill.length, 1);
  assert.equal(m.stats.dropped, 5, 'industrial, residential, glacier, the earth polygon and the boundary line have no drawing rule');
  assert.equal(m.stats.byKind.green, 3);
  assert.ok(!m.groups.some(g => g.kind === 'earth' || g.kind === 'boundary'));
});

test('places become labels with a priority and the zoom they appear at; unnamed or unknown places are dropped', () => {
  const m = adapt([{name: 'places', features: [
    {type: 1, geometry: [2048, 2048], props: {kind: 'locality', kind_detail: 'city', name: 'Gainesville'}},
    {type: 1, geometry: [500, 600], props: {kind: 'neighbourhood', name: 'Duckpond'}},
    {type: 1, geometry: [500, 700], props: {kind: 'locality', kind_detail: 'village', name: 'Micanopy'}},
    {type: 1, geometry: [500, 800], props: {kind: 'locality', kind_detail: 'city'}},
    {type: 1, geometry: [500, 900], props: {kind: 'oddity', name: 'Nowhere'}},
    {type: 1, geometry: [3000, 100], props: {class: 'suburb', name: 'Hawthorne Heights'}}
  ]}]);
  assert.deepEqual(m.labels.map(l => l.text).sort(), ['Duckpond', 'Gainesville', 'Hawthorne Heights', 'Micanopy']);
  const city = m.labels.find(l => l.text === 'Gainesville'), hood = m.labels.find(l => l.text === 'Duckpond');
  assert.ok(city.priority < hood.priority && city.minZoom < hood.minZoom && city.kind === 'place');
  assert.equal(m.stats.dropped, 2);
});

test('points of interest: trees, street furniture and bus stops are drawn as points; named places are labelled; the rest is dropped', () => {
  const m = adapt([{name: 'pois', features: [
    {type: 1, geometry: [100, 100, 200, 200], props: {kind: 'tree'}},
    {type: 1, geometry: [300, 300], props: {kind: 'crossing'}},
    {type: 1, geometry: [400, 400], props: {kind: 'bus_stop', name: 'Bus stop A'}},
    {type: 1, geometry: [500, 500], props: {kind: 'cafe', name: 'Dunn Brothers', min_zoom: 17.5}},
    {type: 1, geometry: [600, 600], props: {kind: 'cafe'}},
    {type: 1, geometry: [700, 700], props: {kind: 'parking'}}
  ]}]);
  assert.deepEqual(m.points.map(p => p.kind).sort(), ['bus', 'furniture', 'poi', 'poi', 'tree', 'tree']);
  const cafe = m.labels.find(l => l.text === 'Dunn Brothers');
  assert.equal(cafe.minZoom, 17.5);
  assert.equal(m.labels.find(l => l.text === 'Bus stop A').kind, 'bus');
  assert.equal(m.stats.dropped, 1, 'the unnamed cafe');
});

test('coordinates agree with the canvas layer\'s own Web Mercator, to a hundredth of a metre, at several zooms and places', () => {
  const places = [[29.6488, -82.3379], [-33.857, 151.215], [0.001, -0.001], [64.14, -21.94], [-0.5, 179.9]];
  for (const z of [6, 11, 15]) for (const [lat, lon] of places) {
    const n = 2 ** z, tx = Math.floor((lon + 180) / 360 * n), s = Math.sin(lat * Math.PI / 180), ty = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    const extent = 4096, fx = ((lon + 180) / 360 * n - tx) * extent, fy = ((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - ty) * extent;
    const px = Math.round(fx), py = Math.round(fy);
    const m = adapt([{name: 'pois', features: [{type: 1, geometry: [px, py], props: {kind: 'tree'}}]}], z, tx, ty);
    const p = m.points[0], wx = p.x + m.ox, wy = p.y + m.oy;
    const lon2 = (tx + px / extent) / n * 360 - 180, lat2 = (() => {const nn = Math.PI - 2 * Math.PI * (ty + py / extent) / n; return 180 / Math.PI * Math.atan(.5 * (Math.exp(nn) - Math.exp(-nn)));})();
    assert.ok(Math.abs(wx - L.mercX(lon2)) < 1e-9 && Math.abs(wy - L.mercY(lat2)) < 1e-9, 'z' + z + ' ' + lat + ',' + lon + ': ' + (wx - L.mercX(lon2)) + ', ' + (wy - L.mercY(lat2)));
    // And the tile centre is where it should be: the origin is the middle of the tile.
    assert.ok(Math.abs(m.ox - (tx + .5) / n * 256) < 1e-12 && Math.abs(m.oy - (ty + .5) / n * 256) < 1e-12);
    assert.ok(Math.abs(p.x) <= 128 / n + 1e-9 && Math.abs(p.y) <= 128 / n + 1e-9, 'a point inside the tile is within half a tile of its centre');
  }
});

test('segments that lie wholly in the tile\'s buffer are not stroked (the neighbour draws them), but the fill keeps the whole polygon', () => {
  // A square from -64 to 4160: its four sides are the clip lines of a 64-unit buffer. Corner-to-corner it crosses the tile.
  const buffered = [-64, -64, 4160, -64, 4160, 4160, -64, 4160];
  const m = adapt([{name: 'landuse', features: [{type: 3, geometry: [buffered], props: {kind: 'park'}}]}]);
  const g = find(m, 'green');
  assert.equal(g.fill.length, 1);
  assert.equal(g.fill[0].length, 8, 'all four corners are filled');
  assert.equal(g.stroke.length, 0, 'every side of that square lies outside the tile, so nothing is stroked');
  // A polygon cut by the buffer on one side only: three sides stroked as one run.
  const cut = [100, 100, 3000, 100, 3000, 3000, 100, 3000];
  const half = [-64, 500, 2000, 500, 2000, 1500, -64, 1500];                                       // its left side is on the clip line
  const m2 = adapt([{name: 'buildings', features: [{type: 3, geometry: [cut, half], props: {kind: 'building'}}]}]);
  const b = find(m2, 'building');
  assert.equal(b.fill.length, 2);
  const open = b.stroke.filter(s => !s.closed);
  assert.equal(open.length, 1, 'one run for the ring that was cut');
  assert.equal(open[0].pts.length, 8, 'four vertices: three sides of the rectangle, the fourth (on the clip line) left out');
  assert.equal(b.stroke.filter(s => s.closed).length, 1, 'the ring that was not cut stays closed');
});

test('a road label sits on the longest stretch inside the tile, upright, and short stubs are not named', () => {
  const m = adapt([{name: 'roads', features: [
    {type: 2, geometry: [[500, 500, 600, 520, 3000, 1400]], props: {kind: 'minor_road', kind_detail: 'residential', name: 'Long Street'}},
    {type: 2, geometry: [[4000, 4000, 4010, 4010]], props: {kind: 'minor_road', kind_detail: 'residential', name: 'Stub'}},
    {type: 2, geometry: [[3000, 500, 1000, 400]], props: {kind: 'major_road', kind_detail: 'secondary', name: 'Westbound'}}
  ]}]);
  assert.deepEqual(m.labels.map(l => l.text).sort(), ['Long Street', 'Westbound']);
  const lng = m.labels.find(l => l.text === 'Long Street'), west = m.labels.find(l => l.text === 'Westbound');
  assert.ok(Math.abs(lng.angle - Math.atan2(880, 2400) * 180 / Math.PI) < 1e-9);
  assert.ok(west.angle > -90 && west.angle < 90, 'text is never upside down (' + west.angle.toFixed(2) + ')');
  assert.ok(Math.abs(west.angle - Math.atan2(100, 2000) * 180 / Math.PI) < 1e-9);
});

test('an empty or unknown tile is an empty model, and the size estimate follows the geometry', () => {
  const empty = adapt([]);
  assert.deepEqual([empty.groups.length, empty.points.length, empty.labels.length, empty.bytes], [0, 0, 0, 0]);
  const unknown = adapt([{name: 'mystery', features: [{type: 2, geometry: [[0, 0, 5, 5]]}]}]);
  assert.equal(unknown.groups.length, 0);
  assert.equal(unknown.stats.dropped, 1);
  const line = []; for (let i = 0; i < 1000; i++) line.push(i * 4, 100 + (i % 7));
  const big = adapt([{name: 'roads', features: [{type: 2, geometry: [line], props: {kind: 'minor_road', kind_detail: 'residential'}}]}]);
  assert.ok(big.bytes >= 1000 * 2 * 4, 'float32 vertices: ' + big.bytes);
});

test('recognisesLayers: a package needs at least one layer the adapter reads', () => {
  assert.equal(S.recognisesLayers(['roads', 'water']), true);
  assert.equal(S.recognisesLayers(['transportation']), true);
  assert.equal(S.recognisesLayers(['contours', 'hillshade']), false);
  assert.equal(S.recognisesLayers([]), false);
  assert.equal(S.recognisesLayers(undefined), false);
});

test('mt_kind on a point says what the app draws it as, whatever the Protomaps kind is; elevators and bus-stop lines are known highways', () => {
  const m = adapt([
    {name: 'pois', features: [
      {type: 1, geometry: [500, 500], props: {kind: 'cafe', mt_kind: 'poi'}},                          // unnamed, but the source drew it
      {type: 1, geometry: [600, 600], props: {kind: 'bicycle_parking', mt_kind: 'furniture'}},
      {type: 1, geometry: [700, 700], props: {kind: 'bus_stop', mt_kind: 'bus'}},
      {type: 1, geometry: [800, 800], props: {kind: 'tree', mt_kind: 'tree'}},
      {type: 1, geometry: [900, 900], props: {kind: 'cafe'}},                                          // a plain unnamed cafe stays dropped
      {type: 1, geometry: [950, 950], props: {kind: 'cafe', mt_kind: 'sculpture'}}                     // an unknown mt_kind is ignored
    ]},
    {name: 'roads', features: [
      {type: 2, geometry: [[100, 100, 900, 100]], props: {kind: 'other', kind_detail: 'elevator'}},
      {type: 2, geometry: [[100, 200, 900, 200]], props: {kind: 'other', kind_detail: 'bus_stop'}}
    ]}
  ]);
  assert.deepEqual(m.points.map(p => p.kind).sort(), ['bus', 'furniture', 'poi', 'tree']);
  assert.deepEqual(m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort(), ['bus_stop', 'elevator']);
});

/* ---- Protomaps basemap 3.x, as found in a real archive (data/samples): properties carry a "pmap:" prefix ------------------ */

const pm = (kind, detail, extra = {}) => ({'pmap:kind': kind, ...(detail ? {'pmap:kind_detail': detail} : {}), ...extra});

test('Protomaps 3.x ("pmap:" properties): roads reach the same classes; sidewalks, crossings and platforms are not drawn; names follow the producer\'s min_zoom', () => {
  const m = adapt([{name: 'roads', features: [
    {type: 2, geometry: [[100, 100, 900, 120]], props: pm('highway', 'motorway', {name: 'A1', 'pmap:min_zoom': 4})},
    {type: 2, geometry: [[100, 300, 900, 300]], props: pm('major_road', 'primary', {name: 'Via Bolognese', 'pmap:min_zoom': 8})},
    {type: 2, geometry: [[100, 500, 900, 500]], props: pm('medium_road', 'tertiary', {name: 'Via Aretina', 'pmap:min_zoom': 10})},
    {type: 2, geometry: [[100, 700, 900, 700]], props: pm('minor_road', 'residential', {name: 'Via dell\'Oriuolo', 'pmap:min_zoom': 13})},
    {type: 2, geometry: [[100, 900, 900, 900]], props: pm('minor_road', 'unclassified')},
    {type: 2, geometry: [[100, 1100, 900, 1100]], props: pm('path', 'pedestrian', {name: 'Via dei Calzaiuoli'})},
    {type: 2, geometry: [[100, 1300, 900, 1300]], props: pm('path', 'sidewalk')},
    {type: 2, geometry: [[100, 1500, 900, 1500]], props: pm('path', 'crossing')},
    {type: 2, geometry: [[100, 1700, 900, 1700]], props: pm('other', 'platform')},
    {type: 2, geometry: [[100, 1900, 900, 1900]], props: pm('other', 'living_street', {name: 'Via Piccola'})},
    {type: 2, geometry: [[100, 2100, 900, 2100]], props: pm('minor_road', 'service')}
  ]}], 15);
  assert.deepEqual(m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort(),
    ['living_street', 'motorway', 'pedestrian', 'primary', 'residential', 'service', 'tertiary', 'unclassified'].sort());
  assert.equal(m.stats.dropped, 3, 'the sidewalk, the crossing and the platform are counted as dropped');
  const named = Object.fromEntries(m.labels.map(l => [l.text, l]));
  assert.equal(named['Via dell\'Oriuolo'].minZoom, 15, 'a plain street\'s name waits for zoom 15 although the producer would show the street itself from 13');
  assert.equal(named['Via Aretina'].minZoom, 13, 'a main road\'s name from 13');
  assert.equal(named['A1'].minZoom, 13);
  assert.ok(named['Via dell\'Oriuolo'].rank === 13 && named['A1'].rank === 4, 'the producer\'s min_zoom is kept as a rank');
});

test('Protomaps 3.x: rivers, streams and canals are drawn and named; drains and ditches are not; named lakes get a name; rail and trams are drawn, disused track is not', () => {
  const m = adapt([
    {name: 'physical_line', features: [
      {type: 2, geometry: [[0, 1000, 3000, 1100]], props: pm('river', null, {name: 'Fiume Arno', 'pmap:min_zoom': 10})},
      {type: 2, geometry: [[0, 2000, 3000, 2000]], props: pm('canal', null, {name: 'Canale Macinante', 'pmap:min_zoom': 13})},
      {type: 2, geometry: [[0, 2500, 3000, 2500]], props: pm('stream', null, {'pmap:min_zoom': 13})},
      {type: 2, geometry: [[0, 3000, 3000, 3000]], props: pm('drain', null, {name: 'Fosso', 'pmap:min_zoom': 13})},
      {type: 2, geometry: [[0, 3500, 3000, 3500]], props: pm('ditch', null)},
      {type: 2, geometry: [[0, 3800, 3000, 3800]], props: pm('cliff', null)}
    ]},
    {name: 'physical_point', features: [
      {type: 1, geometry: [1000, 1000], props: pm('water', null, {name: 'Laghetto', 'pmap:min_zoom': 15})},
      {type: 1, geometry: [2000, 1000], props: pm('swimming_pool', null, {name: 'Piscina'})}
    ]},
    {name: 'transit', features: [
      {type: 2, geometry: [[0, 100, 4000, 100]], props: pm('rail', 'rail')},
      {type: 2, geometry: [[0, 200, 4000, 200]], props: pm('rail', 'tram', {name: 'Linea T1'})},
      {type: 2, geometry: [[0, 300, 4000, 300]], props: pm('rail', 'disused')},
      {type: 2, geometry: [[0, 400, 4000, 400]], props: pm('rail', 'turntable')}
    ]}
  ], 14);
  assert.equal(m.groups.find(g => g.kind === 'waterway').stroke.length, 3, 'river, canal and stream; the drain, the ditch and the cliff are left out');
  assert.equal(m.groups.find(g => g.kind === 'rail').stroke.length, 2, 'rail and tram; disused track and a turntable are left out');
  const labels = Object.fromEntries(m.labels.map(l => [l.text, l]));
  assert.deepEqual(Object.keys(labels).sort(), ['Canale Macinante', 'Fiume Arno', 'Laghetto'], 'water names only: no drain, no pool, no tram line');
  assert.equal(labels['Fiume Arno'].kind, 'waterway');
  assert.equal(labels['Fiume Arno'].minZoom, 12, 'a river name from zoom 12, or later if the producer says so');
  assert.equal(labels['Canale Macinante'].minZoom, 15);
  assert.equal(labels['Laghetto'].minZoom, 15);
  assert.equal(m.stats.byKind.waterlabel, 1);
});

test('Protomaps 3.x places: the producer\'s min_zoom decides when a name appears; a plain "locality" is a small place, not a city', () => {
  const m = adapt([{name: 'places', features: [
    {type: 1, geometry: [500, 500], props: pm('locality', 'city', {name: 'Firenze', 'pmap:min_zoom': 5.6})},
    {type: 1, geometry: [900, 900], props: pm('neighbourhood', 'neighbourhood', {name: 'Santa Croce', 'pmap:min_zoom': 13})},
    {type: 1, geometry: [1300, 1300], props: pm('locality', 'locality', {name: 'Case Nuove', 'pmap:min_zoom': 13})},
    {type: 1, geometry: [1700, 1700], props: pm('locality', 'hamlet', {name: 'Il Poggio', 'pmap:min_zoom': 12})},
    {type: 1, geometry: [2100, 2100], props: pm('locality', 'village', {'pmap:min_zoom': 11})}
  ]}], 12);
  const by = Object.fromEntries(m.labels.map(l => [l.text, l]));
  assert.deepEqual(Object.keys(by).sort(), ['Case Nuove', 'Firenze', 'Il Poggio', 'Santa Croce'], 'the unnamed village is dropped');
  assert.deepEqual([by['Firenze'].priority, by['Firenze'].minZoom], [2, 5.6]);
  assert.deepEqual([by['Case Nuove'].priority, by['Case Nuove'].minZoom], [6, 13], 'a generic locality ranks with hamlets');
  assert.equal(by['Il Poggio'].minZoom, 12);
  assert.equal(by['Santa Croce'].minZoom, 13);
});

test('a tile with more names than it may carry keeps the most important ones: roads before points of interest, lower min_zoom first', () => {
  const pois = Array.from({length: 700}, (_, i) => ({type: 1, geometry: [(i % 50) * 80 + 40, Math.floor(i / 50) * 280 + 40], props: pm('cafe', null, {name: 'Caffe ' + i, 'pmap:min_zoom': i < 20 ? 14 : 16})}));
  const roads = Array.from({length: 40}, (_, i) => ({type: 2, geometry: [[200, 100 + i * 100, 3800, 100 + i * 100]], props: pm('minor_road', 'residential', {name: 'Via ' + i, 'pmap:min_zoom': 13})}));
  const m = adapt([{name: 'pois', features: pois}, {name: 'roads', features: roads}], 15);
  assert.equal(m.labels.length, S.MAX_LABELS_PER_TILE);
  assert.equal(m.labels.filter(l => l.kind === 'road').length, 40, 'every street name survives even though the points of interest came first in the tile');
  assert.equal(m.labels.filter(l => l.kind === 'poi' && l.rank === 14).length, 20, 'and so do the points of interest the producer ranks highest');
  assert.equal(m.stats.byKind.poi, 700, 'all 700 points are still drawn; only the names are limited');
});

test('property names without the prefix still work next to prefixed ones, and the prefixed value wins when both exist', () => {
  const m = adapt([{name: 'roads', features: [
    {type: 2, geometry: [[100, 100, 900, 100]], props: {kind: 'minor_road', kind_detail: 'residential', 'pmap:kind': 'major_road', 'pmap:kind_detail': 'primary'}},
    {type: 2, geometry: [[100, 300, 900, 300]], props: {kind: 'major_road', kind_detail: 'secondary'}}
  ]}]);
  assert.deepEqual(m.groups.filter(g => g.kind === 'road').map(g => g.highway).sort(), ['primary', 'secondary']);
});

test('a long name keeps its whole width when names are checked for overlap (it is drawn in full, so a neighbour 150 px away must not be placed under it)', () => {
  const U = require('../map-utils.js');
  const size = {x: 900, y: 600};
  const name = {text: 'Biblioteca dell\'Opera di Santa Maria del Fiore di Firenze', kind: 'poi', priority: 12, minZoom: 16, rank: 0, id: 'long'};
  const near = {text: 'Cafe', kind: 'poi', priority: 12, minZoom: 16, rank: 1, id: 'near'};
  const far = {text: 'Cafe', kind: 'poi', priority: 12, minZoom: 16, rank: 2, id: 'far'};
  const project = l => ({x: {long: 400, near: 550, far: 800}[l.id], y: 300});
  const placed = U.selectLabels([name, near, far], 17, project, size);
  assert.deepEqual(placed.map(l => l.id), ['long', 'far'], 'the neighbour at 150 px is under the long name; the one at 400 px is clear of it');
  assert.ok(placed[0].width > 300 && placed[0].width <= 360, 'width ' + placed[0].width);
  const huge = U.selectLabels([{...name, text: 'x'.repeat(200)}], 17, () => ({x: 450, y: 300}), size);
  assert.equal(huge[0].width, 360, 'the width estimate still has an upper limit');
});

test('when two names of the same priority collide, the one the producer ranks higher (lower min_zoom) is the one placed', () => {
  const U = require('../map-utils.js');
  const at = (text, rank) => ({text, kind: 'poi', priority: 12, minZoom: 16, rank, lat: 0, lon: 0});
  const size = {x: 800, y: 600}, project = () => ({x: 400, y: 300});
  const placed = U.selectLabels([at('Minor kiosk', 16), at('Cathedral', 13), at('Cafe', 16)], 17, project, size);
  assert.deepEqual(placed.map(l => l.text), ['Cathedral'], 'the three names overlap, the highest ranked wins');
  const none = U.selectLabels([at('First', 0), at('Second', 0)], 17, project, size);
  assert.deepEqual(none.map(l => l.text), ['First'], 'equal ranks keep the order of the data');
});
