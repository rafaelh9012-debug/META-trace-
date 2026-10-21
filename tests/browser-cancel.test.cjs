// Cancellation and races, in a real browser: a new file, Clear, Skip and Replay at awkward moments, slow reads that
// finish after the person has moved on, and a rapid-fire stress run. The rule under test is the brief's: the outcome of
// the analysis and the way it is presented are separate, and stopping the presentation must be immediate and total.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./helpers/browser.cjs');

const isLocal = url => /^(file:|blob:|data:|about:)/.test(url);
test.after(async () => {await B.closeBrowser();});

function scenario(name, options, fn) {
  test(name, async t => {
    const browser = await B.getBrowser();
    if (!browser) return t.skip(B.reason());
    const app = await B.openApp(browser, options);
    try {
      await fn(app, t);
      assert.deepEqual(app.problems, [], 'console errors or warnings');
      assert.deepEqual(app.requests.filter(u => !isLocal(u)), [], 'requests outside the local file');
      assert.deepEqual(app.dialogs, [], 'unexpected dialogs');
    } finally {await app.close();}
  });
}

const LAT = 29 + 38 / 60 + 55.87 / 3600, LON = -(82 + 20 / 60 + 16.4 / 3600);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const title = page => B.text(page, 'statusTitle');
const states = async page => (await page.evaluate(() => window.__sequence.map(x => x.state))).filter(s => s !== 'idle');
const until = (page, predicate, timeout = 15000) => page.waitForFunction(predicate, null, {timeout});
/** Voices are faded out over about 40 ms and leave the registry when the fade ends: silent within 400 ms is "at once". */
const silent = (page, why) => page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 400}).catch(() => {throw new Error('audio still playing 400 ms after the cancel: ' + why);});
const markerCount = page => page.locator('#map .leaflet-marker-icon').count();

/** Reads of the image itself (not the 512-byte header sniff) take `window.__delay` ms: a slow disk or a big file. */
function slowReads() {
  window.__delay = 0;
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function () {
    const wait = this.size > 1000 ? window.__delay : 0;
    return wait ? new Promise(resolve => setTimeout(resolve, wait)).then(() => original.call(this)) : original.call(this);
  };
}

async function assertNothingOfThePreviousRun(page, {expectTitle, quietMs}) {
  await B.sleep(quietMs);
  const s = await B.snapshot(page);
  assert.equal(await title(page), expectTitle, 'the status did not change');
  assert.equal(s.pin, null, 'no pin appeared');
  assert.equal(s.accuracy, null, 'no accuracy circle appeared');
  assert.equal(s.location, null);
  assert.equal(s.flying, false);
  assert.equal(await page.locator('#coordinates').isHidden(), true, 'no coordinates appeared');
  assert.equal(await page.locator('#metadataBody tr').count(), 0, 'no tag table appeared');
  assert.deepEqual(await states(page), [], 'the presentation did not move on its own');
  assert.equal(await markerCount(page), 0);
}

scenario('a new file during the scan stops everything at once, and the old result never appears', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().presentation === 'scan');
  await page.evaluate(() => {window.__sequence = [];});
  const before = await B.snapshot(page);
  await B.choose(page, 'no-gps.jpg');
  const s = await B.snapshot(page);
  assert.ok(s.generation > before.generation, 'a new generation started');
  assert.equal(s.running, false);
  assert.ok(['idle', 'cancelled'].includes(s.presentation), 'presentation stopped (' + s.presentation + ')');
  assert.equal(s.stageActive, false);
  await silent(page, 'new file during the scan');
  assert.equal(s.file.name, 'no-gps.jpg');
  assert.equal(await B.text(page, 'fileName'), 'no-gps.jpg');
  assert.equal(await page.locator('#bay').getAttribute('data-phase'), 'ready', 'the stage shows the new file as ready');
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Image ready', quietMs: 4500});
  // The new file analyses normally afterwards.
  await page.click('#analyze'); await B.waitDone(page, 30000);
  assert.equal(await title(page), 'No location metadata found');
  assert.equal((await B.snapshot(page)).pin, null);
});

scenario('a new file during the flight freezes the camera in place and the old result never appears', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().flying, 20000);
  await B.sleep(500);
  const mid = await B.snapshot(page);
  assert.ok(mid.camera.zoom > 2.5 && mid.camera.zoom < 17.9, 'a flight genuinely in progress (zoom ' + mid.camera.zoom.toFixed(2) + ')');
  await page.evaluate(() => {window.__sequence = [];});
  await B.choose(page, 'no-gps.jpg');
  const a = await B.snapshot(page);
  assert.equal(a.flying, false, 'the flight was cancelled');
  await B.sleep(400);
  const b = await B.snapshot(page);
  assert.deepEqual(b.camera, a.camera, 'the camera stayed where it was stopped');
  assert.ok(Math.abs(a.camera.zoom - mid.camera.zoom) < 4, 'frozen near the stopping point');
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Image ready', quietMs: 3000});
  // And a complete good run afterwards leaves exactly one pin and ends at street scale.
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze'); await B.waitDone(page, 30000);
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON) && s.camera.zoom === 18);
  assert.equal(await markerCount(page), 1, 'exactly one pin on the map');
});

scenario('Clear during the flight stops it, resets the map, and the old result never appears', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().flying, 20000);
  assert.ok((await B.snapshot(page)).audio.voices > 0, 'the descent sound is playing');
  await page.evaluate(() => {window.__sequence = [];});
  await page.click('#clear');
  const s = await B.snapshot(page);
  assert.equal(s.flying, false);
  assert.deepEqual([s.camera.lat, s.camera.lng, s.camera.zoom], [20, 0, 2.2], 'back on the world view');
  assert.equal(s.file, null);
  await silent(page, 'Clear during the flight');
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Waiting for an image', quietMs: 3500});
  assert.deepEqual((await B.snapshot(page)).camera, {lat: 20, lng: 0, zoom: 2.2}, 'no late camera move');
});

scenario('Clear and a new file while sound is playing silence the real audio graph immediately', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  assert.equal((await B.snapshot(page)).audio.state === 'none' || (await B.snapshot(page)).audio.supported, true);
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().audio.voices > 0, 8000);
  const playing = (await B.snapshot(page)).audio;
  assert.equal(playing.supported, true);
  assert.equal(playing.state, 'running', 'the AudioContext is running (headless, autoplay allowed)');
  assert.ok(playing.voices > 0);
  await page.click('#clear');
  await silent(page, 'Clear');

  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().audio.voices > 0, 8000);
  await B.choose(page, 'no-gps.jpg');
  await silent(page, 'new file');
  assert.equal((await B.snapshot(page)).audio.state, 'running', 'the context stays available for the next run');
});

scenario('a read that finishes after a new file was chosen is discarded', {motion: 'fast', init: [slowReads]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {window.__delay = 900;});
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().analysis === 'reading');
  await page.evaluate(() => {window.__sequence = [];});
  await B.choose(page, 'no-gps.jpg');
  await page.evaluate(() => {window.__delay = 0;});
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Image ready', quietMs: 2200});
  assert.equal((await B.snapshot(page)).status, null, 'no report from the abandoned read');
  assert.equal(await page.locator('#analysisLog').innerText().then(t => /GPS coordinates found|Latitude/i.test(t)), false, 'the log does not mention the old file\'s result');
  await page.click('#analyze'); await B.waitDone(page);
  assert.equal(await title(page), 'No location metadata found');
});

scenario('a read that finishes after Clear is discarded', {motion: 'fast', init: [slowReads]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {window.__delay = 700;});
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().analysis === 'reading');
  await page.evaluate(() => {window.__sequence = [];});
  await page.click('#clear');
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Waiting for an image', quietMs: 1800});
  assert.equal(await page.locator('#analysisLog .log-line').count(), 1, 'only the reset line is in the log');
  assert.equal(await page.locator('#fileCard').isHidden(), true);
  assert.equal((await B.snapshot(page)).analysis, 'idle');
});

scenario('typing in the tag filter before the reveal does not show the table early', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().presentation === 'scan');
  await page.fill('#tagSearch', 'GPS');
  assert.equal(await page.locator('#metadataBody tr').count(), 0, 'no rows during the scan');
  await B.waitDone(page, 30000);
  assert.ok(await page.locator('#metadataBody tr').count() > 0, 'rows after the reveal');
  assert.ok((await B.text(page, 'metadataBody')).includes('GPS'));
  assert.equal(await B.content(page, 'tagSearch'), '', 'textContent of an input is empty');
  assert.equal(await page.inputValue('#tagSearch'), 'GPS', 'the typed filter was kept and applied');
});

scenario('Skip during the scan lands on the same final state as a complete run', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().presentation === 'scan');
  const t0 = Date.now();
  await page.click('#skip');
  await B.waitDone(page, 5000);
  assert.ok(Date.now() - t0 < 1500, 'skipped in ' + (Date.now() - t0) + ' ms');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'exact pin');
  assert.ok(near(s.camera.lat, LAT) && near(s.camera.lng, LON) && s.camera.zoom === 18, 'exact street-scale camera');
  assert.equal(s.pin.popupOpen, true);
  assert.equal(s.flying, false);
  assert.equal(s.stagePhase, 'settled');
  assert.equal(await title(page), 'GPS coordinates found');
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
  assert.equal(await B.content(page, 'fileHash'), B.sha256('sample-street.jpg'));
  assert.ok(await page.locator('#metadataBody tr').count() > 0);
  assert.equal(await markerCount(page) >= 1, true);
});

scenario('Skip during the flight completes the move at once, exactly', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().flying, 20000);
  await B.sleep(300);
  await page.click('#skip');
  await B.waitDone(page, 3000);
  const s = await B.snapshot(page);
  assert.equal(s.flying, false);
  assert.ok(near(s.camera.lat, LAT) && near(s.camera.lng, LON) && s.camera.zoom === 18);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON));
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
});

scenario('Skip before the file has even been read waits for the report, then shows the result without the show', {motion: 'full', init: [slowReads]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {window.__delay = 1200;});
  const t0 = Date.now();
  await page.click('#analyze');
  await until(page, () => window.MetaTrace.snapshot().analysis === 'reading');
  assert.equal(await page.locator('#skip').isDisabled(), false, 'Skip is available while the file is still being read');
  assert.equal(await B.text(page, 'skipLabel'), 'Show result');
  await page.click('#skip');
  await B.waitDone(page, 8000);
  const total = Date.now() - t0;
  assert.ok(total >= 1100, 'the result cannot appear before the file was read (' + total + ' ms)');
  assert.ok(total < 3500, 'and then it appears at once, not after the 6 s sequence (' + total + ' ms)');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && s.camera.zoom === 18);
  assert.equal(await title(page), 'GPS coordinates found');
});

scenario('Replay during its own run cannot be started twice, and Clear during a replay leaves nothing behind', {motion: 'full'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg', {wait: false});
  await B.waitDone(page, 30000);
  await page.click('#replay');
  await until(page, () => window.MetaTrace.snapshot().presentation === 'scan');
  assert.equal(await page.locator('#replay').isDisabled(), true);
  const gen = (await B.snapshot(page)).generation;
  await page.evaluate(() => {window.__sequence = [];});
  await page.click('#clear');
  const s = await B.snapshot(page);
  assert.ok(s.generation > gen);
  assert.equal(s.pin, null);
  await silent(page, 'Clear during a replay');
  await assertNothingOfThePreviousRun(page, {expectTitle: 'Waiting for an image', quietMs: 3000});
});

scenario('Analyze pressed twice quickly runs one analysis', {motion: 'fast', init: [() => {
  window.__workers = 0; const W = window.Worker; window.Worker = function (...a) {window.__workers++; return new W(...a);};
}]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {document.getElementById('analyze').click(); document.getElementById('analyze').click(); document.getElementById('analyze').click();});
  await B.waitDone(page);
  await B.sleep(300);
  assert.equal(await page.evaluate(() => window.__workers), 1, 'one parse');
  assert.equal(await markerCount(page), 1);
  assert.equal(await page.locator('#analysisLog .log-line').filter({hasText: /Reading/}).count() <= 1, true);
});

scenario('rapid-fire: many files, Analyze, Clear and Skip in quick succession leave one clean, correct final state', {motion: 'fast'}, async ({page}) => {
  const files = ['sample-street.jpg', 'no-gps.jpg', 'gps-outside-region.jpg', 'conflicting-gps.jpg', 'gps-north-west.jpg', 'gps-antimeridian-east.jpg'];
  for (let i = 0; i < 18; i++) {
    const name = files[i % files.length];
    await page.setInputFiles('#fileInput', B.fixture(name));
    await B.sleep(30 + (i * 37) % 120);
    if (await page.locator('#analyze').isEnabled()) await page.click('#analyze');
    await B.sleep(40 + (i * 53) % 400);
    const action = i % 3;
    if (action === 0 && await page.locator('#clear').isEnabled()) await page.click('#clear');
    else if (action === 1 && await page.locator('#skip').isEnabled()) await page.click('#skip');
    // action 2: simply choose the next file over the top
  }
  await page.setInputFiles('#fileInput', B.fixture('sample-street.jpg'));
  await until(page, () => document.getElementById('statusTitle').textContent === 'Image ready');
  await page.click('#analyze');
  await B.waitDone(page);
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON) && s.camera.zoom === 18, 'the last file is shown exactly');
  assert.equal(await markerCount(page), 1, 'one pin only: nothing left from the earlier runs');
  assert.equal(await page.locator('#map .leaflet-interactive').count() >= 1, true);
  assert.equal(s.audio.voices === 0 || s.audio.voices <= 3, true, 'at most the closing cue is still ringing');
  assert.equal(await title(page), 'GPS coordinates found');
  assert.equal(await B.content(page, 'fileHash'), B.sha256('sample-street.jpg'));
  await B.sleep(1500);
  assert.equal((await B.snapshot(page)).audio.voices, 0, 'the audio graph drains');
});
