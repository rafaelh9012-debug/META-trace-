// The custom base-map layer, checked against Leaflet itself in a real browser:
// projection parity (including world copies at the antimeridian), geometric alignment with Leaflet's own
// renderer at street zooms, label continuity across longitude wrapping, and draw cost.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const {ROOT, getBrowser, closeBrowser, reason} = require('./helpers/browser.cjs');

const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
let page;
async function ready(t) {
  const browser = await getBrowser();
  if (!browser) return t.skip(reason()) || false;
  if (page) return true;
  page = await (await browser.newContext({viewport: {width: 1000, height: 800}})).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.errors = errors;
  await page.goto('about:blank');
  await page.addStyleTag({content: read('vendor/leaflet.css')});
  await page.addScriptTag({content: read('vendor/leaflet.js')});
  await page.addScriptTag({content: read('map-utils.js')});
  await page.addScriptTag({content: read('trace-canvas-layer.js')});
  await page.addScriptTag({content: 'window.LOCAL=' + read('data/map-data.json') + ';window.WORLD=' + read('data/world-data.json') + ';window.META=' + read('data/map-meta.json') + ';window.LOCAL_LABELS=' + read('data/map-labels.json') + ';window.WORLD_LABELS=' + read('data/world-labels.json') + ';'});
  await page.setContent('<div id="a" style="width:800px;height:600px;position:absolute;left:0;top:0"></div><div id="b" style="width:800px;height:600px;position:absolute;left:0;top:0;visibility:hidden"></div>');
  await page.evaluate(() => {
    // Leaflet's canvas renderer draws on the next animation frame, so wait before reading it.
    window.frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Leaflet's canvas is larger than the map and offset from it. Re-express its pixels in container coordinates.
    window.leafletMask = (map, w, h, test) => {
      const c = map.getContainer().querySelector('canvas'), r = c.getBoundingClientRect(), rc = map.getContainer().getBoundingClientRect();
      const ox = Math.round(r.left - rc.left), oy = Math.round(r.top - rc.top), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, mask = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const px = x - ox, py = y - oy;
        if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
        const i = 4 * (py * c.width + px);
        mask[y * w + x] = test(data[i], data[i + 1], data[i + 2], data[i + 3]) ? 1 : 0;
      }
      return mask;
    };
    window.newMap = (id, opts = {}) => {
      const el = document.getElementById(id);
      if (el._leaflet_id) {el._leaflet_id = undefined; el.replaceChildren();}
      const map = L.map(el, {zoomControl: false, attributionControl: false, zoomSnap: .1, fadeAnimation: false, zoomAnimation: false, ...opts});
      map.createPane('traceBase').style.zIndex = 100;
      return map;
    };
  });
  return true;
}
test.after(async () => {await closeBrowser();});

test('projection matches Leaflet at every zoom, including wrapped copies near the antimeridian and the projection limit', async t => {
  if (!await ready(t)) return;
  const worst = await page.evaluate(() => {
    const map = newMap('a'), points = [[29.64885278, -82.33788889], [0, 0], [-17.75, 179.9999], [-17.75, -179.9999], [85, 10], [-85, -10], [34.204527, 89.283237], [48.8582, 2.2945]];
    let exact = 0, rounded = 0, n = 0;
    for (const z of [1, 2.2, 5, 10.5, 14, 18, 19, 20]) for (const [lat, lng] of points) for (const shift of [0, 360, -360]) {
      map.setView([lat, lng + shift], z, {animate: false});
      const min = map.getPixelBounds().min;
      for (const [plat, plng] of points) {
        for (const copy of [-360, 0, 360]) {
          const ours = TraceCanvasLayer.containerPoint(plat, plng + copy, z, min.x, min.y);
          const projected = map.project([plat, plng + copy], z), leafletRounded = map.latLngToContainerPoint([plat, plng + copy]);
          exact = Math.max(exact, Math.hypot(ours.x - (projected.x - min.x), ours.y - (projected.y - min.y)));
          rounded = Math.max(rounded, Math.hypot(ours.x - leafletRounded.x, ours.y - leafletRounded.y));
          n++;
        }
      }
    }
    return {exact, rounded, n};
  });
  assert.ok(worst.n > 1000);
  // Same projection, to floating point.
  assert.ok(worst.exact < 1e-6, 'unrounded projection differs by ' + worst.exact + ' px over ' + worst.n + ' points');
  // Leaflet rounds marker and layer positions to whole pixels, so a marker can sit up to half a pixel (0.71 diagonally) from the exact point.
  assert.ok(worst.rounded < 0.75, 'against Leaflet\'s rounded positions ' + worst.rounded + ' px');
  console.log('    exact agreement ' + worst.exact.toExponential(1) + ' px; against Leaflet\'s whole-pixel marker positions at most ' + worst.rounded.toFixed(2) + ' px');
});

test('street geometry lands where Leaflet draws the same road, at zoom 17 to 20 far from the layer origin', async t => {
  if (!await ready(t)) return;
  const result = await page.evaluate(async () => {
    // The longest ordinary road in the bundled data.
    let best = null;
    for (const f of LOCAL.features) {
      const p = f.properties;
      if (p.kind !== 'road' || f.geometry.type !== 'LineString' || ['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'primary', 'secondary', 'tertiary', 'trunk', 'corridor', 'elevator', 'bus_stop'].includes(p.highway)) continue;
      if (!best || f.geometry.coordinates.length > best.geometry.coordinates.length) best = f;
    }
    const spec = TraceCanvasLayer.specFor('road', best.properties.highway, false);
    const hex = spec.stroke.slice(1).match(/../g).map(h => parseInt(h, 16));
    const out = {highway: best.properties.highway, vertices: best.geometry.coordinates.length, zooms: {}};
    const mid = best.geometry.coordinates[Math.floor(best.geometry.coordinates.length / 2)];
    for (const z of [17, 18, 19, 20]) {
      // Ours.
      const map = newMap('a');
      const layer = TraceCanvasLayer.create(L, {world: {features: []}, local: {features: [best]}, bounds: META.bounds, localLabels: [], worldLabels: [], selectLabels: () => [], pane: 'traceBase'}).addTo(map);
      layer.prepare();
      map.setView([mid[1], mid[0]], z, {animate: false});
      layer.redraw(true);
      const ours = layer._canvas, w = ours.width, h = ours.height;
      const dOurs = ours.getContext('2d').getImageData(0, 0, w, h).data;
      const isRoad = (r, g, b, a) => a > 200 && Math.abs(r - hex[0]) < 26 && Math.abs(g - hex[1]) < 26 && Math.abs(b - hex[2]) < 26;
      const maskOurs = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) maskOurs[i] = isRoad(dOurs[4 * i], dOurs[4 * i + 1], dOurs[4 * i + 2], dOurs[4 * i + 3]) ? 1 : 0;
      map.remove();
      // Leaflet's own renderer, same geometry, same width, a colour that cannot be confused.
      const m2 = newMap('b', {preferCanvas: true});
      const weight = TraceCanvasLayer.roadWeight(spec, z);
      L.geoJSON({type: 'FeatureCollection', features: [best]}, {style: {color: '#ff0000', weight, opacity: 1, lineCap: 'round', lineJoin: 'round'}, renderer: L.canvas()}).addTo(m2);
      m2.setView([mid[1], mid[0]], z, {animate: false});
      await frames();
      const maskLeaflet = leafletMask(m2, w, h, (r, g, b, a) => r > 200 && g < 60 && a > 200);
      let both = 0, onlyA = 0, onlyB = 0;
      for (let i = 0; i < w * h; i++) {const a = maskOurs[i], b = maskLeaflet[i]; if (a && b) both++; else if (a) onlyA++; else if (b) onlyB++;}
      // Thin anti-aliased strokes make exact overlap a harsh measure, so also ask how much of each rendering lies within 1 px of the other.
      const near = (mask, x, y) => {for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) return true;} return false;};
      let oursNear = 0, oursTotal = 0, leafletNear = 0, leafletTotal = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (maskOurs[i]) {oursTotal++; if (near(maskLeaflet, x, y)) oursNear++;}
        if (maskLeaflet[i]) {leafletTotal++; if (near(maskOurs, x, y)) leafletNear++;}
      }
      m2.remove();
      out.zooms[z] = {weight, both, onlyA, onlyB, iou: both / Math.max(1, both + onlyA + onlyB), oursWithin1: oursNear / Math.max(1, oursTotal), leafletWithin1: leafletNear / Math.max(1, leafletTotal), size: [w, h]};
    }
    return out;
  });
  console.log('    longest road: ' + result.highway + ', ' + result.vertices + ' vertices');
  for (const [z, r] of Object.entries(result.zooms)) {
    console.log('    z' + z + ': stroke ' + r.weight.toFixed(1) + ' px; exact overlap ' + (r.iou * 100).toFixed(1) + '%; within 1 px of Leaflet: ' + (r.oursWithin1 * 100).toFixed(1) + '% of ours, ' + (r.leafletWithin1 * 100).toFixed(1) + '% of Leaflet\'s');
    assert.ok(r.both > 200, 'z' + z + ': the road must be on screen in both renderings');
    assert.ok(r.oursWithin1 > 0.97 && r.leafletWithin1 > 0.97, 'z' + z + ': geometry disagrees with Leaflet by more than a pixel');
    assert.ok(r.iou > 0.7, 'z' + z + ': exact overlap ' + (r.iou * 100).toFixed(1) + '%');
  }
});

test('the world outline lands where Leaflet draws the same polygons', async t => {
  if (!await ready(t)) return;
  const result = await page.evaluate(async () => {
    const out = {};
    for (const [lat, lng, z] of [[45, 10, 3], [20, 0, 2.2], [29.6, -82.3, 5], [34.2, 89.3, 5]]) {
      const map = newMap('a');
      const layer = TraceCanvasLayer.create(L, {world: WORLD, local: null, bounds: null, localLabels: [], worldLabels: [], selectLabels: () => [], pane: 'traceBase'}).addTo(map);
      map.setView([lat, lng], z, {animate: false}); layer.redraw(true);
      const c = layer._canvas, w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
      const ours = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) ours[i] = d[4 * i + 3] > 128 ? 1 : 0;   // fill alpha is .95, stroke fully opaque; empty sea stays transparent
      map.remove();
      const m2 = newMap('b', {preferCanvas: true});
      L.geoJSON(WORLD, {style: {color: '#f00', weight: .7, fillColor: '#f00', fillOpacity: 1}, renderer: L.canvas()}).addTo(m2);
      m2.setView([lat, lng], z, {animate: false});
      await frames();
      const maskLeaflet = leafletMask(m2, w, h, (r, g, b, a) => a > 128);
      let both = 0, onlyA = 0, onlyB = 0;
      for (let i = 0; i < w * h; i++) {const b = maskLeaflet[i], a = ours[i]; if (a && b) both++; else if (a) onlyA++; else if (b) onlyB++;}
      m2.remove();
      out[lat + ',' + lng + ' z' + z] = {both, iou: both / Math.max(1, both + onlyA + onlyB)};
    }
    return out;
  });
  for (const [view, r] of Object.entries(result)) {
    console.log('    ' + view + ': land overlap ' + (r.iou * 100).toFixed(2) + '%');
    assert.ok(r.both > 1000, view + ' shows land');
    assert.ok(r.iou > 0.97, view + ': world outline disagrees with Leaflet, overlap ' + (r.iou * 100).toFixed(2) + '%');
  }
});

test('labels keep their screen position and identity when the camera crosses or is renormalised across the antimeridian', async t => {
  if (!await ready(t)) return;
  const result = await page.evaluate(() => {
    const labels = [
      {text: 'Alpha', lat: -17.4, lon: 179.5, kind: 'place', minZoom: 1, priority: 1},
      {text: 'Beta', lat: -17.9, lon: -179.5, kind: 'place', minZoom: 1, priority: 2},
      {text: 'Gamma', lat: -18.4, lon: 179.95, kind: 'place', minZoom: 1, priority: 3}
    ];
    const map = newMap('a');
    const layer = TraceCanvasLayer.create(L, {world: {features: []}, local: null, bounds: null, localLabels: [], worldLabels: labels, selectLabels: MapUtils.selectLabels, pane: 'traceBase'}).addTo(map);
    const keysAt = [], positions = [];
    const pinPoint = () => labels.map(l => {const c = map.getCenter(), lon = l.lon + 360 * Math.round((c.lng - l.lon) / 360), p = map.latLngToContainerPoint([l.lat, lon]); return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];});
    // Travel eastwards across the antimeridian in small steps, as a flight on the unwrapped longitude does.
    for (let lng = 179.2; lng <= 180.8; lng += 0.1) {
      map.setView([-17.9, lng], 7, {animate: false}); layer._selectLabels(true); layer.redraw(true);
      keysAt.push([...layer._labelState.keys()].sort().join('|'));
    }
    // Arrival: the same picture is re-expressed on the true longitude. Nothing may jump.
    map.setView([-17.9, 180.4], 7, {animate: false}); layer._selectLabels(true); layer.redraw(true);
    const before = pinPoint(), keysBefore = [...layer._labelState.keys()].sort().join('|');
    map.setView([-17.9, 180.4 - 360], 7, {animate: false}); layer._selectLabels(true); layer.redraw(true);
    const after = pinPoint(), keysAfter = [...layer._labelState.keys()].sort().join('|');
    const alphas = [...layer._labelState.values()].map(e => e.alpha);
    return {distinctKeySets: [...new Set(keysAt)].length, keysAt: keysAt.length, before, after, same: keysBefore === keysAfter, count: layer._labelState.size, alphas};
  });
  assert.equal(result.count, 3, 'all three labels are tracked on both sides');
  assert.equal(result.same, true, 'label identity does not change when the longitude is renormalised');
  for (let i = 0; i < result.before.length; i++) {
    assert.deepEqual(result.after[i], result.before[i], 'label ' + i + ' did not move on screen');
  }
  assert.ok(result.distinctKeySets <= 2, 'labels were not dropped and re-added while crossing (' + result.distinctKeySets + ' distinct sets)');
});

test('drawing cost at street zoom with the full bundled data stays small', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(() => {
    const map = newMap('a');
    const layer = TraceCanvasLayer.create(L, {world: WORLD, local: LOCAL, bounds: META.bounds, localLabels: LOCAL_LABELS, worldLabels: WORLD_LABELS, selectLabels: MapUtils.selectLabels, pane: 'traceBase'}).addTo(map);
    const build = layer.prepare();
    const out = {build: Math.round(build)};
    for (const z of [11, 14, 17, 18, 19]) {
      map.setView([29.64885278, -82.33788889], z, {animate: false});
      const times = [];
      for (let i = 0; i < 12; i++) {map.panBy([37, 11], {animate: false}); const t0 = performance.now(); layer.redraw(true); times.push(performance.now() - t0);}
      times.sort((a, b) => a - b);
      out['z' + z] = {median: +times[6].toFixed(1), worst: +times[11].toFixed(1)};
    }
    return out;
  });
  console.log('    one-time geometry build: ' + r.build + ' ms (software rendering, headless Chromium)');
  for (const z of ['z11', 'z14', 'z17', 'z18', 'z19']) {
    console.log('    ' + z + ': median ' + r[z].median + ' ms, worst ' + r[z].worst + ' ms per redraw');
    assert.ok(r[z].median < 40, z + ' median redraw ' + r[z].median + ' ms is too slow even for software rendering');
  }
  assert.ok(r.build < 1500);
});

test('the page raised no errors', async t => {
  if (!await ready(t)) return;
  assert.deepEqual(page.errors, []);
});
