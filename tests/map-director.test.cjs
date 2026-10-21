// Map director: camera decisions and completion handling, against a fake map whose flights finish only when told.
const test = require('node:test'), assert = require('node:assert/strict');
const Director = require('../map-director.js');

const BOUNDS = [-82.351, 29.638, -82.324, 29.659];
const L = {latLng: (lat, lng) => ({lat, lng})};

function fakeMap(start = {lat: 20, lng: 0, zoom: 2.2}) {
  const listeners = {moveend: new Set()}, container = new EventTarget();
  const map = {
    center: {lat: start.lat, lng: start.lng}, zoom: start.zoom, calls: [], pending: null,
    getContainer: () => container,
    getCenter() {return {lat: this.center.lat, lng: this.center.lng};},
    getZoom() {return this.zoom;},
    on(type, fn) {listeners[type].add(fn);}, off(type, fn) {listeners[type].delete(fn);},
    listenerCount: () => listeners.moveend.size,
    setView(c, z, o) {
      const lat = Array.isArray(c) ? c[0] : c.lat, lng = Array.isArray(c) ? c[1] : c.lng;
      this.calls.push({type: 'setView', lat, lng, zoom: z, options: o});
      this.center = {lat, lng}; this.zoom = z; this.fire();
      return this;
    },
    flyTo(c, z, o) {this.calls.push({type: 'flyTo', lat: c.lat, lng: c.lng, zoom: z, options: o}); this.pending = {lat: c.lat, lng: c.lng, zoom: z}; return this;},
    /** Completes the flight in progress, as Leaflet does when the animation ends. */
    finish() {const p = this.pending; this.pending = null; this.center = {lat: p.lat, lng: p.lng}; this.zoom = p.zoom; this.fire();},
    fire() {for (const fn of [...listeners.moveend]) fn();},
    input(type, extra = {}) {container.dispatchEvent(Object.assign(new Event(type), extra));}
  };
  return map;
}
const make = (map, extra = {}) => Director.create({L, map, bounds: BOUNDS, ...extra});
const pending = async promise => {const raced = await Promise.race([promise, new Promise(r => setTimeout(() => r('pending'), 15))]); return raced === 'pending';};

test('classify: regional, overview, polar and unusable coordinates', () => {
  const c = (latitude, longitude, bounds = BOUNDS) => Director.classify({latitude, longitude}, bounds);
  assert.deepEqual(c(29.64885278, -82.33788889), {kind: 'regional', zoom: 18});
  assert.equal(c(29.638, -82.351).kind, 'regional', 'bounds are inclusive at the south-west corner');
  assert.equal(c(29.659, -82.324).kind, 'regional', 'bounds are inclusive at the north-east corner');
  assert.equal(c(29.6379, -82.337).kind, 'overview');
  assert.equal(c(29.65, -82.3239).kind, 'overview');
  assert.deepEqual(c(34.204527, 89.283237), {kind: 'overview', zoom: 5});
  assert.deepEqual(c(0, 0), {kind: 'overview', zoom: 5});
  assert.equal(c(85.0, 10).kind, 'overview', '85.0 degrees is inside the projection');
  assert.equal(c(Director.MAX_MERCATOR_LAT, 10).kind, 'overview', 'the limit itself is still drawable');
  assert.equal(c(85.0512, 10).kind, 'polar');
  assert.equal(c(-85.06, 10).kind, 'polar');
  assert.equal(c(89.5, 45).kind, 'polar');
  assert.equal(c(-90, 0).kind, 'polar');
  assert.equal(c(NaN, 1).kind, 'none');
  assert.equal(Director.classify(null, BOUNDS).kind, 'none');
  assert.equal(Director.classify({latitude: 1}, BOUNDS).kind, 'none');
  assert.equal(c(29.64885278, -82.33788889, null).kind, 'overview', 'with no bundled street data nothing is regional');
});

test('a flight that ends a fraction of a pixel off (Leaflet quantises the centre after a manual pan) still arrives, exactly', async () => {
  const map = fakeMap({lat: 29.6484, lng: -82.3391, zoom: 18}), d = make(map);
  const loc = {latitude: 29.64885278, longitude: -82.33788889};
  const done = d.recenter(loc, {animate: true});
  assert.equal(d.flying, true);
  map.pending = null; map.center = {lat: loc.latitude - 4.3e-7, lng: loc.longitude + 1.1e-6}; map.zoom = 18; map.fire();
  assert.equal(await done, 'arrived');
  assert.equal(d.flying, false, 'the flight is not left hanging');
  assert.deepEqual([map.center.lat, map.center.lng, map.zoom], [loc.latitude, loc.longitude, 18], 'the last sub-pixel gap is closed');
  assert.deepEqual(map.calls.at(-1).options, {animate: false, reset: true}, 'an exact reset, not a whole-pixel pan');
  assert.equal(map.listenerCount(), 0);
});

test('several pixels short of the target is not arrival', async () => {
  const map = fakeMap({lat: 29.6484, lng: -82.3391, zoom: 18}), d = make(map);
  const loc = {latitude: 29.64885278, longitude: -82.33788889};
  const done = d.recenter(loc, {animate: true});
  map.pending = null; map.center = {lat: loc.latitude, lng: loc.longitude + 5 * 360 / (256 * 2 ** 18)}; map.zoom = 18; map.fire();   // five pixels east
  assert.equal(await pending(done), true);
  assert.equal(d.flying, true);
  d.cancel();
  assert.equal(await done, 'cancelled');
});

test('unwrapLongitude picks the world copy nearest the camera', () => {
  assert.equal(Director.unwrapLongitude(-179.9999, 179.9), 180.0001);
  assert.equal(Director.unwrapLongitude(179.9999, -179.9), -180.0001);
  assert.equal(Director.unwrapLongitude(10, 0), 10);
  assert.equal(Director.unwrapLongitude(10, 720), 730);
  assert.equal(Director.unwrapLongitude(179.9, 0), 179.9);
  assert.equal(Director.unwrapLongitude(-82.33788889, -82.3), -82.33788889);
});

test('a flight resolves "arrived" only when the camera is where the move was going', async () => {
  const map = fakeMap(), d = make(map);
  const done = d.fly({latitude: 29.64885278, longitude: -82.33788889}, {animate: true, duration: 2.9});
  assert.equal(d.flying, true);
  assert.deepEqual(map.calls.at(-1).options, {animate: true, duration: 2.9});
  assert.equal(map.calls.at(-1).zoom, 18);
  assert.equal(await pending(done), true);
  map.fire();                                   // an unrelated moveend (resize, layer change): camera has not arrived
  assert.equal(await pending(done), true);
  map.center = {lat: 29.64885278, lng: -82.33788889}; // right place, wrong zoom
  map.zoom = 12; map.fire();
  assert.equal(await pending(done), true);
  map.zoom = 2.2; map.finish();
  assert.equal(await done, 'arrived');
  assert.equal(d.flying, false);
  assert.equal(map.listenerCount(), 0, 'no moveend listener is left behind');
});

test('a replaced flight is told so, and its stale completion cannot finish the new one', async () => {
  const map = fakeMap(), d = make(map);
  const a = d.fly({latitude: 29.64885278, longitude: -82.33788889});
  const idA = d.flightId;
  const b = d.fly({latitude: 48.8582, longitude: 2.2945});
  assert.equal(await a, 'replaced');
  assert.notEqual(d.flightId, idA);
  map.center = {lat: 29.64885278, lng: -82.33788889}; map.zoom = 18; map.fire();   // A's destination reached late
  assert.equal(await pending(b), true, "B must not be completed by A's destination");
  map.finish();
  assert.equal(await b, 'arrived');
  assert.equal(map.listenerCount(), 0);
});

test('cancel freezes the camera in place and resolves "cancelled"; a later finish changes nothing', async () => {
  const map = fakeMap(), d = make(map);
  const done = d.fly({latitude: 29.64885278, longitude: -82.33788889});
  map.center = {lat: 25, lng: -40}; map.zoom = 6.5;       // mid-flight
  assert.equal(d.cancel('cancelled'), true);
  assert.equal(await done, 'cancelled');
  const freeze = map.calls.at(-1);
  assert.deepEqual([freeze.type, freeze.lat, freeze.lng, freeze.zoom, freeze.options], ['setView', 25, -40, 6.5, {animate: false}]);
  assert.equal(d.flying, false);
  assert.equal(d.cancel(), false, 'nothing left to cancel');
  assert.equal(map.listenerCount(), 0);
});

test('manual map input hands control back exactly once, and only during a move', async () => {
  for (const [type, extra] of [['pointerdown'], ['wheel'], ['touchstart'], ['dblclick'], ['keydown', {key: 'ArrowUp'}], ['keydown', {key: '+'}], ['keydown', {key: 'PageDown'}]]) {
    const map = fakeMap();let interrupted = 0;const d = make(map, {onInterrupt: () => interrupted++});
    const done = d.fly({latitude: 29.64885278, longitude: -82.33788889});
    map.input(type, extra);map.input(type, extra);
    assert.equal(await done, 'interrupted', type);
    assert.equal(interrupted, 1, type + ' reports once');
  }
  const map = fakeMap();let interrupted = 0;const d = make(map, {onInterrupt: () => interrupted++});
  map.input('pointerdown');assert.equal(interrupted, 0, 'no move in progress: nothing to interrupt');
  const done = d.fly({latitude: 29.64885278, longitude: -82.33788889});
  map.input('keydown', {key: 'a'});assert.equal(await pending(done), true, 'ordinary typing is not map input');
  d.cancel();
});

test('longitude is unwrapped for the path and normalised to the true value on arrival', async () => {
  const map = fakeMap({lat: 0, lng: 170, zoom: 3}), d = make(map);
  const done = d.fly({latitude: -17.75, longitude: -179.9999});
  assert.equal(map.calls.at(-1).type, 'flyTo');
  assert.ok(Math.abs(map.calls.at(-1).lng - 180.0001) < 1e-9, 'flies across the antimeridian by the short way');
  map.finish();
  assert.equal(await done, 'arrived');
  const last = map.calls.at(-1);
  assert.deepEqual([last.type, last.lat, last.lng, last.zoom, last.options], ['setView', -17.75, -179.9999, 5, {animate: false, reset: true}]);
  assert.equal(map.getCenter().lng, -179.9999, 'the camera ends on the true longitude');
  // And back the other way.
  const back = d.fly({latitude: -17.75, longitude: 179.9999});
  assert.ok(Math.abs(map.calls.at(-1).lng - (-180.0001)) < 1e-9);
  map.finish();assert.equal(await back, 'arrived');
  assert.equal(map.getCenter().lng, 179.9999);
});

test('the nearest world copy is not used when the point is on the near side', async () => {
  const map = fakeMap({lat: 0, lng: 0, zoom: 3}), d = make(map);
  const done = d.fly({latitude: 10, longitude: 179.9});
  assert.equal(map.calls.at(-1).lng, 179.9);
  map.finish();assert.equal(await done, 'arrived');
  assert.equal(map.calls.some(c => c.type === 'setView'), false, 'no normalising step needed');
});

test('polar and unusable coordinates are never flown to', async () => {
  const map = fakeMap(), d = make(map);
  assert.equal(await d.fly({latitude: 89.5, longitude: 45}), 'skipped');
  assert.equal(await d.fly({latitude: NaN, longitude: 45}), 'skipped');
  assert.equal(await d.recenter({latitude: -89.5, longitude: 45}), 'skipped');
  assert.equal(d.jump({latitude: 89.5, longitude: 45}).kind, 'polar');
  assert.equal(map.calls.length, 0, 'the camera was not touched');
});

test('jump places the final view immediately and ends any flight in progress', async () => {
  const map = fakeMap(), d = make(map);
  const done = d.fly({latitude: 48.8582, longitude: 2.2945});
  const plan = d.jump({latitude: 29.64885278, longitude: -82.33788889});
  assert.deepEqual(plan, {kind: 'regional', zoom: 18});
  assert.equal(await done, 'replaced');
  const last = map.calls.at(-1);
  assert.deepEqual([last.type, last.lat, last.lng, last.zoom, last.options], ['setView', 29.64885278, -82.33788889, 18, {animate: false, reset: true}]);
  assert.equal(d.flying, false);
});

test('an unanimated flight (reduced motion) completes without a flyTo call', async () => {
  const map = fakeMap(), d = make(map);
  assert.equal(await d.fly({latitude: 34.204527, longitude: 89.283237}, {animate: false, duration: 0}), 'arrived');
  assert.equal(map.calls.some(c => c.type === 'flyTo'), false);
  assert.deepEqual([map.getCenter().lat, map.getCenter().lng, map.getZoom()], [34.204527, 89.283237, 5]);
});

test('widen pulls back only when the camera is close, and recenter takes the short route', async () => {
  const map = fakeMap({lat: 29.6, lng: -82.3, zoom: 18}), d = make(map);
  const w = d.widen();
  assert.deepEqual([map.calls.at(-1).type, map.calls.at(-1).zoom, map.calls.at(-1).options.duration], ['flyTo', 3, 1.1]);
  map.finish();assert.equal(await w, 'arrived');
  const before = map.calls.length;
  assert.equal(await d.widen(), 'arrived');
  assert.equal(map.calls.length, before, 'already wide: nothing to do');
  const r = d.recenter({latitude: 29.64885278, longitude: -82.33788889});
  assert.equal(map.calls.at(-1).options.duration, 0.9);
  map.finish();assert.equal(await r, 'arrived');
});

test('rest ends a move in progress and leaves a close camera on the wide view; a wide camera is left alone', async () => {
  const map = fakeMap({lat: 29.6488, lng: -82.3378, zoom: 18}), d = make(map);
  const widening = d.widen({animate: true, duration: 1.1});
  map.zoom = 15.9;                                   // part-way through the zoom-out
  d.rest();
  assert.equal(await widening, 'replaced');
  assert.equal(d.flying, false);
  assert.deepEqual([map.center.lat, map.center.lng, map.zoom], [29.6488, -82.3378, 3]);
  assert.deepEqual(map.calls.at(-1).options, {animate: false, reset: true});
  const before = map.calls.length;
  d.rest();                                          // already wide: nothing to do
  assert.equal(map.calls.length, before);
  const wide = fakeMap({lat: 20, lng: 0, zoom: 2.2}), w = make(wide);
  w.rest();
  assert.deepEqual([wide.zoom, wide.calls.length], [2.2, 0], 'the initial world view is not touched');
});

test('dispose cancels the flight in progress', async () => {
  const map = fakeMap(), d = make(map);
  const done = d.fly({latitude: 29.64885278, longitude: -82.33788889});
  d.dispose();
  assert.equal(await done, 'cancelled');
});
