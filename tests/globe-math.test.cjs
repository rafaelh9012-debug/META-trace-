// Pure-logic tests for the globe maths: geodesy, the five-mile frame, the camera and the unwrapped sequence plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../globe-math.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a + ' (tolerance ' + tol + ')');
const rel = (a, b, tol, msg) => near(a / b, 1, tol, msg);

/* ------------------------------------------------------------------ geodesy -- */

test('ellipsoid ground scale matches the published WGS84 values', () => {
  const eq = G.ellipsoidScale(0), pole = G.ellipsoidScale(90);
  near(eq.metersPerDegLat, 110574.275, 0.01, 'metres per degree of latitude at the equator');
  near(eq.metersPerDegLon, 111319.491, 0.01, 'metres per degree of longitude at the equator');
  near(pole.metersPerDegLat, 111693.98, 0.01, 'metres per degree of latitude at the pole');
  near(G.ellipsoidScale(60).metersPerDegLon, 55799.97, 0.5, 'longitude degree at 60 degrees');
});

test('Vincenty reproduces its classic test lines', () => {
  // Flinders Peak to Buninyong (Vincenty 1975): 54,972.271 m
  near(G.vincentyInverse(-37.95103341666667, 144.4248678888889, -37.65282113888889, 143.92649552777777), 54972.271, 0.001);
  near(G.vincentyInverse(0, 0, 0, 90), Math.PI / 2 * G.WGS84_A, 0.001, 'a quarter of the equator');
  near(G.vincentyInverse(0, 0, 90, 0), 10001965.729, 0.01, 'equator to pole');
  assert.equal(G.vincentyInverse(12, 34, 12, 34), 0);
});

test('the spherical and ellipsoidal models differ by under 0.7 % over five miles (so a haversine check is a fair independent bound)', () => {
  for (const [la, lo] of [[0, 0], [29.65, -82.34], [-33.87, 151.21], [69.65, 18.96], [-17.75, 179.9999]]) {
    const v = G.vincentyInverse(la, lo, la + .036, lo), h = G.haversine(la, lo, la + .036, lo);
    rel(h, v, .007, 'at ' + la);
  }
});

test('longitude helpers', () => {
  assert.equal(G.wrapLon(190), -170);
  assert.equal(G.wrapLon(-190), 170);
  assert.equal(G.wrapLon(180), -180);
  assert.equal(G.wrapLon(540.5), -179.5);
  assert.equal(G.unwrapNear(-179, 179), 181);
  assert.equal(G.unwrapNear(179, -179), -181);
  assert.equal(G.unwrapNear(10, 12), 10);
});

/* ------------------------------------------------------------------ the frame -- */

test('the frame is 2.5 miles from the point to each edge, measured with an independent method', () => {
  assert.equal(G.FRAME_METERS, 8046.72);
  for (const lat of [0, 0.5, -0.5, 10, -33.8688, 29.64885, 45, -45, 60, 69.6492, 75, -80, 84, -84]) {
    const b = G.frameBounds(lat, 20);
    for (const [name, a2, o2] of [['north', b.north, 20], ['south', b.south, 20], ['east', lat, b.east], ['west', lat, b.west]]) {
      const d = G.vincentyInverse(lat, 20, a2, o2);
      rel(d, 4023.36, 2e-4, name + ' edge at latitude ' + lat);
    }
  }
});

test('the frame crosses the antimeridian without breaking and without losing its size', () => {
  const east = G.frameBounds(-17.75, 179.9999), west = G.frameBounds(-17.75, -179.9999);
  assert.equal(east.crossesAntimeridian, true);
  assert.equal(west.crossesAntimeridian, true);
  assert.ok(east.east > 180 && east.west < 180);
  assert.ok(west.west < -180 && west.east > -180);
  // The wrapped edges are on the other side of the meridian and still 2.5 miles away.
  near(G.vincentyInverse(-17.75, 179.9999, -17.75, east.wrapped.east), 4023.36, 1);
  near(G.vincentyInverse(-17.75, -179.9999, -17.75, west.wrapped.west), 4023.36, 1);
  assert.equal(G.frameBounds(29.65, -82.34).crossesAntimeridian, false);
});

test('near a pole the frame is flagged polar instead of inventing a longitude span', () => {
  assert.equal(G.frameBounds(89.99, 45).polar, true);
  assert.equal(G.frameBounds(-90, 0).polar, true);
  assert.equal(G.frameBounds(89.5, 45).polar, false);
  near(G.frameBounds(89.5, 45).dLon, 4.1, 0.3);
});

test('the Web Mercator fit is computed from the latitude, never a fixed zoom', () => {
  const zooms = [];
  for (const lat of [0, 30, 45, 60, 75, 84]) {
    const fit = G.fitFrame(lat, 336);
    zooms.push(fit.zoom);
    // Mean ground extent is exactly 5 miles; the two axes differ by at most the ellipsoid's 0.67 %.
    near((fit.widthMeters + fit.heightMeters) / 2, 8046.72, 1e-6, 'mean extent at ' + lat);
    assert.ok(Math.abs(fit.widthMeters / fit.heightMeters - 1) < .0068, 'axes at ' + lat);
  }
  for (let i = 1; i < zooms.length; i++) assert.ok(zooms[i] < zooms[i - 1], 'higher latitude needs a smaller zoom');
  // A wider frame needs a larger zoom, by exactly one level per doubling.
  near(G.fitFrame(40, 400).zoom - G.fitFrame(40, 200).zoom, 1, 1e-9);
  // Round trip with the ground scale.
  const z = G.zoomForMetersPerPixel(51.5, 23.9);
  near(G.mercatorGroundScale(51.5, z).mean, 23.9, 1e-9);
});

test('frame side tracks the pane and is never larger than it', () => {
  assert.equal(G.frameSide(1000, 900), 640);
  assert.equal(G.frameSide(560, 480), 336);
  assert.equal(G.frameSide(390, 480), 246);
  assert.ok(G.frameSide(150, 150) <= 126);
  for (const [w, h] of [[300, 300], [390, 380], [800, 600], [1440, 900]]) assert.ok(G.frameSide(w, h) <= Math.min(w, h));
  // Reserved bands: the frame is centred, so it can be no larger than twice the room left above or below the centre.
  assert.equal(G.frameSide(590, 844, {top: 112, bottom: 144}), 446, 'a tall pane has room: the reserve changes nothing');
  assert.equal(G.frameSide(1024, 476, {top: 108, bottom: 112}), 252, 'a wide, short pane: twice the room above the centre (238 - 112 = 126)');
  assert.equal(G.frameSide(390, 480, {top: 72, bottom: 150}), 180, 'the note takes most of the lower half: twice (240 - 150)');
  assert.equal(G.frameSide(390, 400, {top: 72, bottom: 190}), G.FRAME_FLOOR, 'never below the floor');
  assert.equal(G.frameSide(590, 844, {}), G.frameSide(590, 844), 'an empty reserve is no reserve');
  assert.equal(G.frameSide(590, 844, {top: NaN}), G.frameSide(590, 844), 'nonsense is ignored');
});

test('Web Mercator is only used when it can draw the whole viewport', () => {
  assert.equal(G.mercatorCanShow(29.6, 24, 600, 480), true);
  assert.equal(G.mercatorCanShow(84, 24, 600, 480), true);
  assert.equal(G.mercatorCanShow(85.04, 24, 600, 480), false);
  assert.equal(G.mercatorCanShow(89.5, 24, 600, 480), false);
  assert.equal(G.mercatorCanShow(-89.5, 24, 600, 480), false);
});

/* ------------------------------------------------------------------ camera -- */

function cam(lon, lat, alt, w = 600, h = 480) {return G.createCamera(w, h).set(lon, lat, alt);}

test('the point under the camera projects to the centre, and unprojecting the centre returns it', () => {
  for (const [lat, lon] of [[0, 0], [29.65, -82.34], [-33.87, 151.21], [89.5, 45], [-90, 0], [0, 180], [17, -179.99]]) {
    const c = cam(lon, lat, 1e6), out = [0, 0, 0], ok = c.projectLatLon(lat, lon, out);
    assert.ok(ok);
    near(out[0], 300, 1e-6); near(out[1], 240, 1e-6);
    const back = c.unproject(300, 240);
    near(back.lat, lat, 1e-7);
    near(G.wrapLon(back.lon - lon), 0, 1e-7);
  }
});

test('north is up and east is to the right at every latitude, including the poles', () => {
  for (const lat of [0, 45, -60, 89.9, 90, -90]) {
    const c = cam(20, lat, 2e5), out = [0, 0, 0], v = G.toVec(lat, 20), n = G.northVec(lat, 20);
    const tiny = 1e-4, nx = v[0] + n[0] * tiny, ny = v[1] + n[1] * tiny, nz = v[2] + n[2] * tiny;
    assert.ok(c.project(nx, ny, nz, out));
    assert.ok(out[1] < 240 - 1 && Math.abs(out[0] - 300) < 1e-6, 'north point is above centre at ' + lat + ': ' + out);
    const e = c.e, ex = v[0] + e[0] * tiny, ey = v[1] + e[1] * tiny, ez = v[2] + e[2] * tiny;
    assert.ok(c.project(ex, ey, ez, out));
    assert.ok(out[0] > 301 && Math.abs(out[1] - 240) < 1e-6, 'east point is right of centre at ' + lat);
  }
});

test('the basis is continuous through the pole (no orientation flip)', () => {
  const a = cam(30, 89.9999, 5e5), b = cam(30, 90, 5e5);
  for (let i = 0; i < 3; i++) {near(a.n[i], b.n[i], 1e-3); near(a.e[i], b.e[i], 1e-9);}
});

test('ground scale at the centre is altitude divided by focal length', () => {
  for (const [lat, alt] of [[0, 2e4], [60, 2e4], [-45, 1e6], [89, 3e4]]) {
    const c = cam(7, lat, alt), mpp = c.metersPerPixel();
    const theta = 1000 / G.R_MEAN, v = G.toVec(lat, 7), out = [0, 0, 0];
    const x = v[0] * Math.cos(theta) + c.e[0] * Math.sin(theta), y = v[1] * Math.cos(theta) + c.e[1] * Math.sin(theta), z = v[2] * Math.cos(theta) + c.e[2] * Math.sin(theta);
    assert.ok(c.project(x, y, z, out));
    rel((out[0] - c.cx) * mpp, 1000, 2e-4, 'one kilometre east at ' + lat + ', ' + alt + ' m');
  }
});

test('the horizon is where the maths says, and the limb radius matches a projected limb point', () => {
  const c = cam(0, 0, G.IDLE_ALT), D = c.D;
  const th = Math.acos(1 / D), out = [0, 0, 0];
  const v = G.toVec(0, 0), e = c.e;
  assert.ok(c.project(v[0] * Math.cos(th - 1e-9) + e[0] * Math.sin(th - 1e-9), v[1] * Math.cos(th - 1e-9) + e[1] * Math.sin(th - 1e-9), v[2] * Math.cos(th - 1e-9) + e[2] * Math.sin(th - 1e-9), out));
  near(out[0] - c.cx, c.limb, 1e-3);
  assert.equal(c.project(-1, 0, 0, out), false, 'the far side is not projected');
  assert.equal(c.unproject(0, 0), null, 'a corner pixel misses the globe at this altitude');
});

test('at orbit the globe fills a sensible share of the window', () => {
  for (const [w, h] of [[600, 480], [390, 480], [1200, 700]]) {
    const c = G.createCamera(w, h).set(0, 0, G.IDLE_ALT), share = c.limb / (Math.min(w, h) / 2);
    assert.ok(share > .7 && share < .9, 'share ' + share);
  }
});

/* --------------------------------------------------------------- the sequence -- */

const START = {lon: 12.3, lat: 20, alt: G.IDLE_ALT};
const plan = (over = {}) => G.planSequence({start: START, target: {lat: 29.65, lon: -82.34}, finalAlt: 2.6e4, duration: 8, revolutions: 1, ...over});

test('the cinematic plan always turns at least a full revolution and ends on the target meridian', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 300; i++) {
    const start = {lon: (rnd() - .5) * 20000, lat: (rnd() - .5) * 170, alt: G.IDLE_ALT};   // an unwrapped angle, as after hours of idle rotation
    const target = {lat: (rnd() - .5) * 178, lon: (rnd() - .5) * 360};
    const p = G.planSequence({start, target, finalAlt: 2e4, duration: 8, revolutions: 1});
    assert.ok(p.sweep >= 360 - 1e-9, 'sweep ' + p.sweep);
    assert.ok(p.sweep < 720 + 1e-9);
    near(G.mod(p.lonEnd - target.lon + 180, 360) - 180, 0, 1e-7, 'ends on the target meridian');
    near(G.cameraAt(p, 8).lon, p.lonEnd, 1e-9);
    near(G.cameraAt(p, 0).lon, start.lon, 1e-9);
  }
});

test('the swept angle only ever grows, in small steps, so nothing can reduce it to the short way round', () => {
  for (const delta of [0, 1e-6, 90, 179.9, 180, 270, 359.9]) {
    const p = plan({start: {lon: -90 + delta + 1e6, lat: 0, alt: G.IDLE_ALT}, target: {lat: 10, lon: -90}});
    let last = 0, maxStep = 0, total = 0;
    for (let t = 0; t <= 8 + 1e-9; t += 1 / 60) {
      const c = G.cameraAt(p, t), step = c.swept - last;
      assert.ok(step >= -1e-9, 'never reverses (t=' + t + ')');
      maxStep = Math.max(maxStep, step); total = c.swept; last = c.swept;
    }
    assert.ok(total >= 360 - 1e-9, 'total ' + total);
    assert.ok(maxStep < 25, 'largest step per frame ' + maxStep + ' degrees');
    assert.ok(maxStep < 90, 'comfortably below the 180 degrees at which a tween takes the other way');
  }
});

test('the turn accelerates from the idle rate, peaks, and comes to rest', () => {
  const p = plan();
  near(G.spinRateAt(p, 0), 4, 1e-6, 'continues from the idle speed');
  near(G.spinRateAt(p, p.spinT), 0, 1e-6, 'at rest on the target meridian');
  let peak = 0, peakAt = 0, prev = G.spinRateAt(p, 0), rising = true, turns = 0;
  for (let t = 0; t <= p.spinT; t += .01) {
    const r = G.spinRateAt(p, t);
    assert.ok(r >= -1e-9);
    if (r > peak) {peak = r; peakAt = t;}
    if (rising && r < prev - 1e-9) {rising = false; turns++;}
    if (!rising && r > prev + 1e-9) turns += 10;       // would mean a second hump
    prev = r;
  }
  assert.equal(turns, 1, 'one hump: accelerate, then decelerate');
  const mean = p.sweep / p.spinT;
  assert.ok(peak > 1.5 * mean && peak < 2.1 * mean, 'peak ' + peak + ' vs mean ' + mean);
  assert.ok(peakAt > .3 * p.spinT && peakAt < .7 * p.spinT);
  // The rate is the derivative of the swept angle.
  for (const t of [.5, 1.7, 3.1, 4.4]) {
    const h = 1e-5, d = (G.cameraAt(p, t + h).swept - G.cameraAt(p, t - h).swept) / (2 * h);
    near(G.spinRateAt(p, t), d, 1e-3);
  }
});

test('altitude falls continuously and latitude orients without overshoot', () => {
  const p = plan();
  let prevAlt = Infinity, prevLat = p.latStart;
  for (let t = 0; t <= 8; t += .01) {
    const c = G.cameraAt(p, t);
    assert.ok(c.alt <= prevAlt + 1e-6, 'altitude never rises');
    assert.ok(c.lat >= prevLat - 1e-9 && c.lat <= p.latEnd + 1e-9, 'latitude moves straight to the target');
    prevAlt = c.alt; prevLat = c.lat;
  }
  near(G.cameraAt(p, 8).alt, 2.6e4, 1e-6);
  near(G.cameraAt(p, 8).lat, 29.65, 1e-9);
  near(G.cameraAt(p, 0).alt, G.IDLE_ALT, 1e-6);
  // Descent is smooth: no step in log altitude larger than a few percent per frame at 60 fps.
  let prev = Math.log(G.cameraAt(p, 0).alt), maxStep = 0;
  for (let t = 1 / 60; t <= 8; t += 1 / 60) {const l = Math.log(G.cameraAt(p, t).alt); maxStep = Math.max(maxStep, Math.abs(l - prev)); prev = l;}
  assert.ok(maxStep < .12, 'largest log-altitude step ' + maxStep);
});

test('the revolution finishes before the camera is close to the ground', () => {
  const p = plan(), end = G.cameraAt(p, p.spinT);
  assert.ok(end.alt > 3e6, 'still at orbit when the turn ends (altitude ' + end.alt + ')');
  assert.ok(G.cameraAt(p, p.descT0).spin >= .75, 'descent begins while the turn is decelerating');
});

test('Fast takes the short way round and never a full revolution', () => {
  for (const lonDelta of [-170, -10, 5, 90, 179, 181, 250, 350]) {
    const p = G.planSequence({start: {lon: 50 + 360 * 17, lat: 0, alt: G.IDLE_ALT}, target: {lat: 5, lon: 50 - lonDelta}, finalAlt: 2e4, duration: 3.4, revolutions: 0});
    assert.ok(Math.abs(p.sweep) <= 180 + 1e-9, 'sweep ' + p.sweep);
    near(G.mod(p.lonEnd - (50 - lonDelta) + 180, 360) - 180, 0, 1e-7);
    assert.equal(p.revolutions, 0);
  }
});

test('hand-off scale is about a kilometre per pixel and finer near the poles', () => {
  const fin = 23.9;
  near(G.handoffMetersPerPixel(0, 480, fin), 1000, 1e-9);
  near(G.handoffMetersPerPixel(30, 480, fin), 1000, 1e-9);
  assert.ok(G.handoffMetersPerPixel(70, 480, fin) < 400);
  assert.ok(G.handoffMetersPerPixel(80, 480, fin) < G.handoffMetersPerPixel(70, 480, fin));
  assert.ok(G.handoffMetersPerPixel(84.9, 480, fin) >= fin * 1.35, 'never finer than the end of the descent');
});

test('Hermite easing has the end conditions it claims', () => {
  near(G.hermite5(0, 3, 9, 2, 0), 3, 1e-12); near(G.hermite5(1, 3, 9, 2, 0), 9, 1e-12);
  near(G.hermite5Slope(0, 3, 9, 2, 0), 2, 1e-12); near(G.hermite5Slope(1, 3, 9, 2, 0), 0, 1e-12);
  assert.equal(G.smootherstep(-1), 0); assert.equal(G.smootherstep(2), 1); near(G.smootherstep(.5), .5, 1e-12);
});

/* ------------------------------------------------- altitude and real ground scale -- */

test('altitude and real ground scale convert both ways and agree with the ellipsoid', () => {
  const focal = 954;
  for (const lat of [-85, -60, -30, 0, 29.65, 51.5, 69.65, 89.9]) {
    for (const mpp of [3, 16.76, 1000, 25000]) {
      near(G.groundScaleForAlt(focal, lat, G.altForGroundScale(focal, lat, mpp)) / mpp, 1, 1e-12, 'round trip at ' + lat);
    }
  }
  // At the equator one sphere metre is 0.56 % less than a real metre of north-south ground; at the pole it is 0.45 % more.
  near(G.altForGroundScale(1, 0, 1), G.R_MEAN / G.ellipsoidScale(0).gaussianRadius, 1e-12);
  assert.ok(G.altForGroundScale(1, 90, 1) < 1 && G.altForGroundScale(1, 0, 1) > 0.99);
});

test('a camera placed with altForGroundScale sees the real five-mile frame at the pixel size the frame needs', () => {
  const cam = G.createCamera(590, 844);
  const side = G.frameSide(590, 844);
  for (const lat of [0, 29.65, 69.65, 89.5]) {
    const mpp = G.FRAME_METERS / side;
    cam.set(10, lat, G.altForGroundScale(cam.focal, lat, mpp));
    const a = cam.unproject(295 - side / 2, 422), b = cam.unproject(295 + side / 2, 422);
    const c = cam.unproject(295, 422 - side / 2), d = cam.unproject(295, 422 + side / 2);
    // Independent check on the ellipsoid: the two edge midpoints of the frame are five miles apart (within 0.6 %).
    near(G.vincentyInverse(a.lat, a.lon, b.lat, b.lon) / G.FRAME_METERS, 1, .006, 'width at ' + lat);
    near(G.vincentyInverse(c.lat, c.lon, d.lat, d.lon) / G.FRAME_METERS, 1, .006, 'height at ' + lat);
  }
});
