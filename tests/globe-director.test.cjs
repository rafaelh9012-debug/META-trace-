// The globe director, against fake renderers and a manual clock: the camera path, the hand-off, cancellation and the final frame.
const test = require('node:test');
const assert = require('node:assert/strict');
const GM = require('../globe-math.js');
const GD = require('../globe-director.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a + ' (tolerance ' + tol + ')');

/** A world with a manual clock. step(ms) advances time and runs the queued animation frame once. */
function world({w = 590, h = 844, fadeMs = 450, lon = -30, lat = 20} = {}) {
  let t = 1000, queue = null, timerQueue = [];
  const clock = {now: () => t, raf: fn => {queue = fn; return 1;}, caf: () => {queue = null;}};
  const timers = {setTimeout: (fn, ms) => {timerQueue.push({fn, at: t + ms}); return timerQueue.length;}, clearTimeout: id => {if (timerQueue[id - 1]) timerQueue[id - 1].dead = true;}};
  const step = ms => {t += ms; for (const q of timerQueue) if (!q.dead && !q.fired && q.at <= t) {q.fired = true; q.fn();} const f = queue; queue = null; if (f) f(t);};
  const camera = GM.createCamera(w, h).set(lon, lat, GM.IDLE_ALT);
  const globe = {
    camera, renders: 0, driven: false, active: true, markers: [], userMin: GM.MIN_ALT, turningFlag: true,
    setCamera(c) {camera.set(c.lon !== undefined ? c.lon : camera.lon, c.lat !== undefined ? c.lat : camera.lat, c.alt !== undefined ? c.alt : camera.alt);},
    getCamera: () => ({lon: camera.lon, lat: camera.lat, alt: camera.alt}),
    render() {this.renders++;}, setDriven(v) {this.driven = v;}, start() {this.active = true;}, stop() {this.active = false;},
    setMarker(m) {this.markers.push(m);}, setMarkerLock() {}, setUserMinAlt(a) {this.userMin = a;}, markUserActive() {},
    get turning() {return this.turningFlag;}, unproject: (x, y) => camera.unproject(x, y), tweenTo: async () => true
  };
  const mapState = {center: {lat: 20, lng: 0}, zoom: 2.2, moves: [], setViews: [], starts: 0, ends: 0};
  const listeners = {};
  const container = new EventTarget();
  const map = {
    getSize: () => ({x: w, y: h}), getCenter: () => ({...mapState.center}), getZoom: () => mapState.zoom, getMinZoom: () => 1, getMaxZoom: () => 20,
    _move(c, z) {mapState.center = {lat: c.lat, lng: c.lng}; mapState.zoom = z; mapState.moves.push({lat: c.lat, lng: c.lng, zoom: z, t});},
    _moveStart() {mapState.starts++;}, _moveEnd() {mapState.ends++;},
    setView(c, z, o) {const lat = Array.isArray(c) ? c[0] : c.lat, lng = Array.isArray(c) ? c[1] : c.lng; mapState.center = {lat, lng}; mapState.zoom = z; mapState.setViews.push({lat, lng, zoom: z, options: o});},
    containerPointToLatLng([x, y]) {
      const S = 256 * Math.pow(2, mapState.zoom), cx = (mapState.center.lng + 180) / 360 * S;
      const my = Math.log(Math.tan(Math.PI / 4 + mapState.center.lat * Math.PI / 360)), cy = (0.5 - my / (2 * Math.PI)) * S;
      const px = cx + (x - w / 2), py = cy + (y - h / 2);
      const lng = px / S * 360 - 180, lat = (2 * Math.atan(Math.exp((0.5 - py / S) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
      return {lat, lng};
    },
    getContainer: () => container, on(type, fn) {for (const k of type.split(' ')) (listeners[k] = listeners[k] || []).push(fn);}
  };
  const L = {latLng: (lat, lng) => ({lat, lng})};
  const panel = {dataset: {view: 'globe'}, style: {props: {}, setProperty(k, v) {this.props[k] = v;}}};
  const frame = {style: {}, hidden: true, dataset: {}};
  const phases = [], details = [], interrupts = [];
  const director = GD.create({
    L, map, globe, panel, frame, now: clock.now, raf: clock.raf, caf: clock.caf, timers, fadeMs, trace: true,
    hooks: {onPhase: (n, i) => phases.push({name: n, t: i.t}), onDetail: l => details.push(l), onInterrupt: () => interrupts.push(1)}
  });
  /** Runs frames at ~60 fps until the promise settles or the guard is spent. */
  async function play(promise, {maxMs = 20000, perFrame} = {}) {
    let result = null, done = false;
    promise.then(r => {result = r; done = true;});
    for (let spent = 0; !done && spent < maxMs; spent += 16.7) {step(16.7); await Promise.resolve(); if (perFrame) perFrame(); }
    await Promise.resolve();
    return result;
  }
  /** Runs frames synchronously for `ms` of manual time (promises settle later, in the test's own await). */
  function advance(ms) {for (let spent = 0; spent < ms; spent += 16.7) step(16.7);}
  return {director, globe, map, mapState, panel, frame, phases, details, interrupts, container, step, play, advance, camera, clock};
}

const loc = (latitude, longitude) => ({latitude, longitude});

test('the cinematic flight sweeps at least one full turn, in small steps, in one direction, then arrives on the frame', async () => {
  const W = world();
  const p = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  assert.equal(await W.play(p), 'arrived');
  const trace = W.director.trace;
  assert.ok(trace.length > 300, 'frames ' + trace.length);
  let total = 0, maxStep = 0;
  for (let i = 1; i < trace.length; i++) {
    const d = trace[i - 1].lon - trace[i].lon;           // camera moves west: longitude falls
    assert.ok(d >= -1e-9, 'never turns back (' + d + ')');
    total += d; maxStep = Math.max(maxStep, Math.abs(d));
  }
  assert.ok(total >= 360, 'swept ' + total + ' degrees');
  assert.ok(maxStep < 6, 'largest step per frame ' + maxStep + ' degrees');
  assert.equal(W.director.plan.revolutions, 1);
  assert.ok(W.director.plan.sweep >= 360);
  // The last unwrapped longitude is the target meridian plus whole turns.
  const lastLon = trace[trace.length - 1].lon;
  near(((lastLon + 82.3248) % 360 + 360) % 360 < 1e-6 ? 0 : Math.min(((lastLon + 82.3248) % 360 + 360) % 360, 360 - ((lastLon + 82.3248) % 360 + 360) % 360), 0, 1e-6, 'ends on the target meridian');
  assert.equal(W.panel.dataset.view, 'map');
  assert.equal(W.director.stage, 'map');
  assert.equal(W.globe.active, false, 'the hidden globe stops drawing');
});

test('the path is the plan: latitude turns monotonically, altitude only falls, and nothing teleports', async () => {
  const W = world({lat: -10});
  const p = W.director.fly(loc(52.2, 0.12), {duration: 8});
  await W.play(p);
  const tr = W.director.trace;
  for (let i = 1; i < tr.length; i++) {
    assert.ok(tr[i].alt <= tr[i - 1].alt + 1e-6, 'altitude never rises');
    assert.ok(Math.abs(tr[i].lat - tr[i - 1].lat) < 2, 'latitude step');
    assert.ok(tr[i].t >= tr[i - 1].t);
  }
  assert.ok(tr[0].lat < 0 && tr[tr.length - 1].lat > 50);
});

test('the hand-off puts Leaflet on the same centre at the same ground scale as the globe, and both draw during the cross-fade', async () => {
  const W = world();
  const f = W.director.finalFor(loc(29.6516, -82.3248));
  const p = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  let seen = null, rendersAtFirstMove = 0;
  await W.play(p, {perFrame: () => {if (!seen && W.mapState.moves.length) {seen = {...W.mapState.moves[0], cam: W.globe.getCamera()}; rendersAtFirstMove = W.globe.renders;}}});
  assert.ok(seen, 'Leaflet was driven');
  assert.equal(W.phases.filter(x => x.name === 'handoff').length, 1);
  // Same ground scale: the zoom Leaflet received is the zoom for the globe's real ground scale at that moment.
  const mpp = GM.groundScaleForAlt(W.camera.focal, seen.lat, seen.cam.alt);
  near(GM.mercatorGroundScale(seen.lat, seen.zoom).mean / mpp, 1, 0.01, 'ground scale at the hand-off');
  near(seen.lat, seen.cam.lat, 1e-9);
  assert.ok(Math.abs(GM.wrapLon(seen.lng - seen.cam.lon)) < 1e-6, 'same longitude');
  // The hand-off happens at about the planned scale (1 km per pixel or finer), never before.
  assert.ok(mpp <= f.handoffMpp * 1.05, 'hand-off scale ' + mpp + ' vs ' + f.handoffMpp);
  assert.ok(W.globe.renders > rendersAtFirstMove, 'the globe still drew during the fade');
});

test('phases arrive in order and detail levels are announced once each, finest last', async () => {
  const W = world();
  await W.play(W.director.fly(loc(29.6516, -82.3248), {duration: 8}));
  assert.deepEqual(W.phases.map(p => p.name), ['start', 'spin', 'orient', 'descend', 'handoff', 'final']);
  assert.deepEqual(W.details, [1, 2, 3, 4, 5]);
  const times = W.phases.filter(p => p.t !== undefined).map(p => p.t);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
});

test('the final view is exact: centre, zoom from the viewport, and a frame five miles wide and high', async () => {
  for (const [lat, lon] of [[29.6516, -82.3248], [-33.8688, 151.2093], [0.0005, 36.82], [64.1466, -21.9426], [69.6492, 18.9553], [-54.8019, -68.303]]) {
    const W = world();
    assert.equal(await W.play(W.director.fly(loc(lat, lon), {duration: 8})), 'arrived', lat + ',' + lon);
    const last = W.mapState.setViews[W.mapState.setViews.length - 1];
    assert.equal(last.lat, lat);assert.equal(last.lng, lon);
    near(last.zoom, GM.fitFrame(lat, GM.frameSide(590, 844)).zoom, 1e-9, 'zoom');
    assert.equal(last.options.reset, true);
    const m = W.director.measureFrame();
    near(m.widthM / GM.FRAME_METERS, 1, .006, 'width ' + lat);
    near(m.heightM / GM.FRAME_METERS, 1, .006, 'height ' + lat);
    near(m.offsetFromTargetM, 0, .5, 'centre offset in metres');
    near(m.halfWestM / (GM.FRAME_METERS / 2), 1, .006); near(m.halfNorthM / (GM.FRAME_METERS / 2), 1, .006);
    assert.equal(W.frame.hidden, false);
    assert.equal(W.frame.style.width, GM.frameSide(590, 844) + 'px');
  }
});

test('the five-mile frame holds across the antimeridian', async () => {
  for (const lon of [179.9999, -179.9999, 180, -180, 179.95]) {
    const W = world({lon: 170});
    assert.equal(await W.play(W.director.fly(loc(-17.75, lon), {duration: 6})), 'arrived');
    const m = W.director.measureFrame();
    near(m.widthM / GM.FRAME_METERS, 1, .006, 'width at ' + lon);
    near(m.offsetFromTargetM, 0, .5, 'offset at ' + lon);
    const last = W.mapState.setViews[W.mapState.setViews.length - 1];
    assert.equal(last.lng, lon, 'true longitude kept');
    // The path ends on the target meridian whichever way the longitude is written.
    const lastLon = W.director.trace[W.director.trace.length - 1].lon;
    near(Math.abs(GM.wrapLon(lastLon - lon)), 0, 1e-6, 'trace ends on the meridian');
  }
});

test('near a pole the globe stays the final renderer and still shows a five-mile frame', async () => {
  for (const lat of [86, 89.9, -89.9, -87.3]) {
    const W = world({lat: 40});
    assert.equal(await W.play(W.director.fly(loc(lat, 33), {duration: 7})), 'arrived');
    assert.equal(W.mapState.moves.length, 0, 'Leaflet was never driven');
    assert.equal(W.panel.dataset.view, 'globe');
    assert.equal(W.director.final.renderer, 'globe');
    const m = W.director.measureFrame();
    assert.equal(m.renderer, 'globe');
    near(m.widthM / GM.FRAME_METERS, 1, .006, 'width at ' + lat);
    near(m.heightM / GM.FRAME_METERS, 1, .006, 'height at ' + lat);
    near(m.offsetFromTargetM, 0, 1, 'offset at ' + lat);
  }
});

test('a target the flat map can show at 80 degrees still uses the map, with the frame exact', async () => {
  const W = world();
  assert.equal(await W.play(W.director.fly(loc(78.2232, 15.6267), {duration: 8})), 'arrived');
  assert.equal(W.director.final.renderer, 'map');
  const m = W.director.measureFrame();
  near(m.widthM / GM.FRAME_METERS, 1, .006);near(m.heightM / GM.FRAME_METERS, 1, .006);
  // Web Mercator stretches east-west with latitude, so the top and bottom edges differ slightly; the centre line is exact.
  near(m.topM / m.bottomM, 1, .01, 'top and bottom edges within 1 %');
});

test('cancel during the spin stops the path, hands the globe back and resolves "cancelled"', async () => {
  const W = world();
  const p = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  W.advance(1500);
  assert.equal(W.director.running, true);
  assert.equal(W.director.cancel('cancelled'), true);
  assert.equal(await p, 'cancelled');
  assert.equal(W.director.running, false);
  assert.equal(W.globe.driven, false);
  assert.equal(W.panel.dataset.view, 'globe');
  const before = W.globe.renders;
  W.step(100);W.step(100);
  assert.equal(W.globe.renders, before, 'no more frames after cancel');
  assert.equal(W.frame.hidden, true);
});

test('manual input after the hand-off ends the sequence once, leaves the map where it is and tells the app', async () => {
  const W = world();
  const p = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  W.advance(7200);
  assert.equal(W.director.stage, 'map');
  const at = {...W.mapState.center, zoom: W.mapState.zoom};
  W.container.dispatchEvent(new Event('pointerdown'));
  W.container.dispatchEvent(new Event('wheel'));
  assert.equal(await p, 'interrupted');
  assert.equal(W.interrupts.length, 1);
  assert.equal(W.director.running, false);
  assert.equal(W.frame.hidden, true);
  const last = W.mapState.setViews[W.mapState.setViews.length - 1];
  near(last.lat, at.lat, 1e-9);near(last.zoom, at.zoom, 1e-9);
});

test('a second flight replaces the first, which is told so', async () => {
  const W = world();
  const first = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  W.advance(1000);
  const second = W.director.fly(loc(-33.8688, 151.2093), {duration: 8});
  assert.equal(await first, 'replaced');
  assert.equal(await W.play(second), 'arrived');
  assert.equal(W.director.final.lat, -33.8688);
});

test('jump applies the exact final view at once and ends a flight in progress', async () => {
  const W = world();
  const p = W.director.fly(loc(29.6516, -82.3248), {duration: 8});
  W.advance(800);
  const f = W.director.jump(loc(29.6516, -82.3248));
  assert.equal(await p, 'replaced');
  assert.equal(W.panel.dataset.view, 'map');
  assert.equal(W.panel.style.props['--view-fade'], '0ms');
  const m = W.director.measureFrame();
  near(m.widthM / GM.FRAME_METERS, 1, .006);
  assert.equal(f.renderer, 'map');
  assert.equal(W.frame.hidden, false);
});

test('reduced motion fades over a short time instead of travelling', () => {
  const W = world();
  W.director.jump(loc(29.6516, -82.3248), {fadeMs: 200});
  assert.equal(W.panel.style.props['--view-fade'], '200ms');
  assert.equal(W.mapState.moves.length, 0, 'no camera travel');
  assert.equal(W.globe.driven, false);
});

test('rise brings the globe back up from the street map without a jump', async () => {
  const W = world();
  await W.play(W.director.fly(loc(29.6516, -82.3248), {duration: 6}));
  assert.equal(W.director.view, 'map');
  const startMoves = W.mapState.moves.length;
  const r = await W.play(W.director.rise({duration: 1.6}));
  assert.equal(r, 'arrived');
  assert.equal(W.director.view, 'globe');
  assert.equal(W.panel.dataset.view, 'globe');
  assert.equal(W.globe.driven, false);
  near(W.camera.alt / GM.IDLE_ALT, 1, 1e-6);
  assert.ok(W.mapState.moves.length > startMoves, 'the map rose first');
  assert.equal(W.frame.hidden, true);
});

test('a flight that starts while the street map is showing begins from the globe at the same place', async () => {
  const W = world();
  await W.play(W.director.fly(loc(29.6516, -82.3248), {duration: 6}));
  const p = W.director.fly(loc(-33.8688, 151.2093), {duration: 8});
  const first = W.globe.getCamera();
  assert.equal(W.director.view, 'globe');
  near(first.lat, 29.6516, 0.05, 'starts above the previous place');
  assert.equal(await W.play(p), 'arrived');
  assert.equal(W.director.final.lat, -33.8688);
});

test('a viewport resize refits the frame so it keeps meaning five miles', async () => {
  const W = world();
  await W.play(W.director.fly(loc(29.6516, -82.3248), {duration: 6}));
  const before = W.director.final.side;
  // Shrink the viewport the fake map reports.
  W.map.getSize = () => ({x: 420, y: 520}); W.camera.resize(420, 520);
  assert.equal(W.director.refit(), true);
  assert.ok(W.director.final.side < before);
  near(W.director.measureFrame().widthM / GM.FRAME_METERS, 1, .006);
  assert.equal(W.director.refit(), false, 'nothing more to do');
});

test('the Fast path keeps the full turn and only shortens it', async () => {
  const W = world();
  assert.equal(await W.play(W.director.fly(loc(48.8566, 2.3522), {duration: 3.4})), 'arrived');
  const tr = W.director.trace;
  assert.ok(tr[0].lon - tr[tr.length - 1].lon >= 360);
});

test('starting from a globe that is not turning still sweeps a full turn (from rest)', async () => {
  const W = world();
  W.globe.turningFlag = false;
  await W.play(W.director.fly(loc(35.68, 139.69), {duration: 8}));
  assert.ok(W.director.plan.sweep >= 360);
  assert.equal(W.director.plan.v0, 0);
});

test('a globe left near the surface needs a rise: it backs off to its resting height, keeping longitude and latitude', async () => {
  const W = world();
  assert.equal(W.director.needsRise, false, 'the resting globe needs nothing');
  W.globe.setCamera({lon: 40, lat: 10, alt: 2e6});
  assert.equal(W.director.needsRise, true, 'a cancelled descent, or a manual zoom, leaves the globe close');
  assert.equal(await W.play(W.director.rise({duration: 1})), 'arrived');
  const c = W.globe.getCamera();
  near(c.alt, GM.IDLE_ALT, 1, 'resting height');near(c.lon, 40, 1e-9, 'longitude kept');near(c.lat, 10, 1e-9, 'latitude kept');
  assert.equal(W.director.needsRise, false);
});

test('relax eases a close globe back, is instant when asked, and leaves a resting globe or the flat map alone', async () => {
  const W = world();
  assert.equal(await W.director.relax(900), false, 'already at rest');
  W.globe.setCamera({alt: 3e6});
  let call = null;
  W.globe.tweenTo = async (target, ms) => {call = {target, ms}; return true;};
  assert.equal(await W.director.relax(900), true);
  assert.deepEqual(call, {target: {alt: GM.IDLE_ALT}, ms: 900}, 'a tween of the height only');
  W.globe.setCamera({alt: 3e6});
  assert.equal(await W.director.relax(0), true);
  near(W.globe.getCamera().alt, GM.IDLE_ALT, 1, 'instant');
  W.director.showMap({fadeMs: 0});
  W.globe.setCamera({alt: 3e6});
  assert.equal(await W.director.relax(900), false, 'the flat map is showing: nothing to relax');
});
