/*
 * META trace: application shell.
 *
 * Two kinds of state are kept apart on purpose.
 *
 *   Analysis state    What the file actually contains. It is produced by the real
 *                     parser (metadata-core.js and metadata-parser.js) and never
 *                     depends on animation, sound or the map.
 *   Presentation      How and when that result is shown. It is run by
 *                     presentation-controller.js, which is told the facts through
 *                     session.signal and decides only the timing.
 *
 * Every asynchronous task carries a generation number. Choosing another file,
 * Clear and starting another analysis all bump it, which makes every pending
 * parse, timer, sound, scramble and map flight from an older generation stale.
 * Stale work either stops (where it can) or is ignored (where it cannot).
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const Core = MetadataCore;
  const Stage = ScanStage;
  const mapData = window.TRACE_MAP_DATA || null;
  const mapMeta = window.TRACE_MAP_META || null;
  // Street detail is only promised when the bundled geometry is really present.
  const hasLocalData = !!(mapData && Array.isArray(mapData.features) && mapData.features.length && mapMeta && Array.isArray(mapMeta.bounds));

  const FILE_HEAD_BYTES = 512;
  const PARSE_TIMEOUT_MS = 12000;
  const SETTINGS_KEY = 'metatrace.settings.v1';
  const SAFE_MIME = {jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif'};

  /* ------------------------------------------------------------------ messages -- */

  const OUTCOMES = {
    located: {kind: 'success', title: 'GPS coordinates found', message: 'A valid coordinate pair was read from the image’s embedded metadata.'},
    no_location: {kind: 'neutral', icon: 'i-info', title: 'No location metadata found', message: 'This image has no embedded GPS coordinate pair. A location cannot be determined from its metadata.', rail: 'This file records no GPS position.'},
    incomplete_location: {kind: 'warning', icon: 'i-warn', title: 'Location metadata is incomplete', message: 'Some GPS tags are present, but the coordinate pair or hemisphere references are incomplete. No marker has been placed.', rail: 'The file records only part of a GPS position.'},
    invalid_location: {kind: 'warning', icon: 'i-warn', title: 'Location metadata is invalid', message: 'GPS tags were found, but their numbers, ranges, or references are invalid. No marker has been placed.', rail: 'The recorded GPS values are not valid coordinates.'},
    conflicting_location: {kind: 'warning', icon: 'i-warn', title: 'Location metadata conflicts', message: 'The embedded metadata contains different GPS coordinate pairs. No coordinate pair has been selected.', rail: 'The file records more than one GPS position.'}
  };
  const FAILURES = {
    unsupported_format: 'Unsupported image format',
    file_too_large: 'Image is too large',
    invalid_file: 'Empty image file'
  };
  const STATUS_ICON = {neutral: 'i-info', busy: 'i-busy', success: 'i-ok', warning: 'i-warn', error: 'i-error'};
  const GROUP_LABELS = {gps: 'GPS', ifd0: 'Camera and image', exif: 'Exposure', ifd1: 'Thumbnail', interop: 'Interoperability', xmp: 'XMP', iptc: 'IPTC', jfif: 'JFIF', ihdr: 'Image header', other: 'Other'};
  const GROUP_ORDER = {gps: 0, ifd0: 1, exif: 2};

  /* --------------------------------------------------------------------- state -- */

  let generation = 0;
  const state = {
    file: null,
    canAnalyze: false,
    previewURL: null,
    analysis: 'idle',        // idle | selected | reading | complete | failed
    report: null,
    error: null,
    startedAt: 0,
    job: null,               // the parser worker job of the current generation
    waiting: false,          // scan beat is over but the report is not ready yet
    heldLog: null,           // result lines of the log, kept back until the reveal (null = not holding)
    heldElapsed: null,
    clean: false
  };
  const settings = {sound: true, volume: 70, motion: null};   // motion null = follow the system preference
  let pres = newPresentation(0, false);

  function newPresentation(gen, replay) {
    return {gen, replay, scan: null, descend: null, scramblers: [], pin: null, accuracy: null, shown: {outcome: false, details: false, coords: false, mapCoverage: false}};
  }

  /* ----------------------------------------------------------------- utilities -- */

  const stale = gen => gen !== generation;
  function setText(id, text) {$(id).textContent = text;}
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function useIcon(id, symbol) {$(id).setAttribute('href', '#' + symbol);}
  function format(n, digits = 8) {return n.toFixed(digits);}
  function pair(p) {return format(p.latitude) + ', ' + format(p.longitude);}
  function plural(n, word) {return n + ' ' + word + (n === 1 ? '' : 's');}

  let toastTimer = 0;
  function toast(text) {
    setText('toast', text);
    $('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4200);
  }
  function announce(text, urgent = false) {
    const target = $(urgent ? 'announceAlert' : 'announce');
    target.textContent = '';
    setTimeout(() => {target.textContent = text;}, 30);
  }

  // Log offsets are real processing time since the analysis was started.
  function offsetLabel() {
    if (!state.startedAt) return 'ready';
    const ms = Math.max(0, Math.round(performance.now() - state.startedAt));
    return '+' + (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s');
  }
  function appendLogLine(time, text, kind) {
    const line = node('div', 'log-line log-' + kind);
    line.append(node('span', 'log-time num', time), node('span', '', text));
    const box = $('analysisLog');
    box.append(line);
    box.scrollTop = box.scrollHeight;
  }
  /**
   * `hold` keeps a line out of sight until the presentation reaches the reveal, so the log does not announce the
   * result before the screen does. The line keeps the time it really happened; only its appearance is deferred.
   */
  function log(text, kind = 'info', {hold = false} = {}) {
    const time = offsetLabel();
    if (hold && state.heldLog) {state.heldLog.push({time, text, kind}); return;}
    appendLogLine(time, text, kind);
  }
  function releaseLog() {
    const held = state.heldLog;
    state.heldLog = null;
    if (held) for (const line of held) appendLogLine(line.time, line.text, line.kind);
    if (state.heldElapsed) {setText('elapsed', state.heldElapsed); state.heldElapsed = null;}
  }
  function setElapsed(ms) {
    const label = ms + ' ms';
    if (state.heldLog) state.heldElapsed = label; else setText('elapsed', label);
  }
  function resetLog(first) {
    $('analysisLog').replaceChildren();
    if (first) log(first);
  }

  function setStatus(title, message, kind = 'neutral') {
    $('status').dataset.kind = kind;
    useIcon('statusIcon', STATUS_ICON[kind] || STATUS_ICON.neutral);
    setText('statusTitle', title);
    setText('statusMessage', message);
  }
  function showNotice(title, message, icon = 'i-info') {
    setText('mapNoticeTitle', title);
    setText('mapNoticeText', message);
    useIcon('mapNoticeIcon', icon);
    $('mapNotice').hidden = false;
  }
  function hideNotice() {$('mapNotice').hidden = true;}

  /* ------------------------------------------------------------------ settings -- */

  const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  function effectiveMotion() {return settings.motion || (reducedQuery && reducedQuery.matches ? 'reduced' : 'full');}
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!saved) return;
      if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
      if (Number.isFinite(saved.volume)) settings.volume = Math.min(100, Math.max(0, Math.round(saved.volume)));
      if (['full', 'fast', 'reduced'].includes(saved.motion)) settings.motion = saved.motion;
    } catch {/* storage unavailable or corrupt: defaults apply */}
  }
  function saveSettings() {
    try {localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));} catch {/* not persisted */}
  }
  function applyMotion() {
    document.documentElement.dataset.motion = effectiveMotion();
    $('motion').value = effectiveMotion();
  }

  /* --------------------------------------------------------------------- audio -- */

  const audio = AudioEngine.create({enabled: true, volume: 0.7});
  let unlocking = Promise.resolve('idle');

  /** Must be called synchronously from a user gesture. The analysis never waits for it. */
  function unlockAudio() {
    if (!settings.sound) return unlocking;
    unlocking = audio.unlock().then(status => {syncSoundChip(); return status;});
    return unlocking;
  }
  /**
   * Plays a cue for the given generation. If the audio context is still resuming
   * the cue starts as soon as it is ready, unless the generation went stale first.
   * Returns a handle whose stop() works in both cases.
   */
  function play(name, params = {}) {
    const gen = params.gen === undefined ? generation : params.gen;
    const handle = {voice: null, cancelled: false, stop(fade) {this.cancelled = true; if (this.voice) this.voice.stop(fade);}};
    if (!settings.sound) return handle;
    const start = () => {if (!handle.cancelled && !stale(gen)) handle.voice = audio.cue(name, {...params, gen});};
    if (audio.state === 'running' || !audio.supported) start(); else unlocking.then(start);
    return handle;
  }
  function syncSoundChip() {
    const supported = audio.supported;
    const mode = !supported ? 'unsupported' : !settings.sound ? 'off' : audio.blocked ? 'blocked' : 'on';
    const chip = $('soundToggle');
    chip.dataset.state = mode;
    chip.setAttribute('aria-pressed', String(mode === 'on' || mode === 'blocked'));
    setText('soundLabel', {on: 'Sound on', off: 'Sound off', blocked: 'Sound blocked', unsupported: 'Sound unavailable'}[mode]);
    useIcon('soundIcon', mode === 'on' ? 'i-sound-on' : 'i-sound-off');
    chip.title = mode === 'blocked' ? 'The browser has not allowed audio yet. Select to try again.' : mode === 'unsupported' ? 'This browser cannot play the interface sounds.' : '';
  }
  async function onSoundToggle() {
    if (settings.sound && audio.blocked) {
      // Second chance: retry the unlock from this gesture. If it still fails, turn sound off.
      const result = await unlockAudio();
      if (result !== 'running') {
        settings.sound = false; audio.setEnabled(false); saveSettings(); syncSoundChip();
        toast('The browser is blocking audio for this page, so sound has been turned off.');
      }
      return;
    }
    settings.sound = !settings.sound;
    audio.setEnabled(settings.sound);
    saveSettings();
    if (settings.sound) {
      const result = await unlockAudio();
      if (result === 'running') play('confirm');
      else if (result === 'blocked') toast('The browser has not allowed audio yet. Select Sound again after interacting with the page.');
    }
    syncSoundChip();
  }

  /* ---------------------------------------------------------------------- map -- */

  const map = L.map('map', {zoomControl: false, minZoom: 1, maxZoom: 20, zoomSnap: .1, zoomDelta: .5, worldCopyJump: true, fadeAnimation: false}).setView([20, 0], 2.2);
  map.createPane('traceBase').style.zIndex = 100;
  const baseLayer = TraceCanvasLayer.create(L, {
    world: window.TRACE_WORLD_DATA, local: hasLocalData ? mapData : null, bounds: hasLocalData ? mapMeta.bounds : null,
    localLabels: window.TRACE_MAP_LABELS, worldLabels: window.TRACE_WORLD_LABELS,
    selectLabels: MapUtils.selectLabels, pane: 'traceBase'
  }).addTo(map);
  map.attributionControl.addAttribution('World: Natural Earth · Streets: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
  L.control.scale({imperial: false, position: 'bottomright', maxWidth: 90}).addTo(map);
  new ResizeObserver(() => {map.invalidateSize({pan: false}); stage.resize();}).observe($('map'));

  const director = MapDirector.create({L, map, bounds: hasLocalData ? mapMeta.bounds : null, onInterrupt() {
    if (pres.descend) pres.descend.stop(0.2);
    toast('The map is yours now. Use Recenter to return to the GPS position.');
  }});
  // Build the street geometry once, during idle time, so the descent never stalls to build it.
  (window.requestIdleCallback || (cb => setTimeout(cb, 300)))(() => {try {baseLayer.prepare();} catch (error) {console.error(error);}});

  /* ---------------------------------------------------------------- scan stage -- */

  const stage = Stage.create({
    bay: $('bay'), frame: $('frame'), canvas: $('scanCanvas'), ticker: $('ticker'),
    onTick: index => play('tick', {index})
  });

  /* --------------------------------------------------------- presentation hooks -- */

  const kindOf = report => report.status === 'located' ? 'located' : report.status === 'no_location' ? 'neutral' : 'warning';
  const isMappable = plan => plan.kind === 'regional' || plan.kind === 'overview';

  const hooks = {
    enter(name, ctx) {
      if (stale(ctx.gen)) return;
      switch (name) {
        case 'acquire': beginPresentation(ctx); break;
        case 'scan': {
          stage.scan(ctx.profile);
          pres.scan = play('scan', {gen: ctx.gen, maxSeconds: 12});
          const wantsFlight = !ctx.replay || (state.report && state.report.status === 'located');
          if (ctx.profile.animateCamera && wantsFlight) director.widen({animate: true, duration: Math.min(1.1, 0.9 * (ctx.profile.scan + ctx.profile.reveal) / 1000)});   // done before the readout appears
          break;
        }
        case 'reveal':
          if (pres.scan) pres.scan.stop(0.12);
          stage.reveal(ctx.profile, ctx.report.metadata);
          presentOutcome(ctx.report, ctx);
          presentDetails(ctx.report, {animate: ctx.profile.theatrics});
          break;
        case 'resolve':
          stage.resolve(ctx.profile);
          setText('mapSubtitle', 'Locating the embedded GPS position.');
          presentCoordinates(ctx.report, {animate: ctx.profile.theatrics, duration: Math.max(220, ctx.profile.resolve - 40)});
          play('resolve', {gen: ctx.gen});
          break;
        case 'fly':
          stage.fly();
          hideNotice();
          if (ctx.profile.animateCamera) pres.descend = play('descend', {gen: ctx.gen, duration: ctx.profile.fly / 1000});
          break;
        case 'lock': {
          stage.lock(ctx.profile);
          if (pres.descend) pres.descend.stop(0.15);
          const plan = director.classify(ctx.report.location);
          if (isMappable(plan)) {
            placePin(ctx.report, {animate: ctx.profile.theatrics});
            presentMapCoverage(ctx.report, plan, ctx);
            play('lock', {gen: ctx.gen});
          }
          break;
        }
        case 'settled': presentFinal(ctx.report, {instant: false, ctx}); break;
        case 'error': presentFailure(ctx.error, ctx); break;
        default: break;
      }
    },
    plan(ctx) {
      const plan = director.classify(ctx.report.location);
      if (plan.kind === 'regional') try {baseLayer.prepare();} catch (error) {console.error(error);}
      return {fly: isMappable(plan)};
    },
    fly(ctx) {
      return director.fly(ctx.report.location, {animate: ctx.profile.animateCamera, duration: ctx.profile.fly / 1000});
    },
    finish(ctx) {presentFinal(ctx.report, {instant: true, ctx});},
    recover(ctx) {
      director.cancel('cancelled');
      director.jump(ctx.report.location);
      log('The camera move did not finish, so the final view was applied directly.', 'warning');
    },
    dispose(ctx, reason) {
      stage.stop();
      cancelScramblers();
      // A normal finish leaves the closing cue to ring out. Everything else stops sound and camera now.
      if (reason !== 'settled') {
        audio.stopAll(0.06);
        director.cancel(reason === 'skip' ? 'skipped' : 'cancelled');
      }
    }
  };

  const controller = PresentationController.create({
    hooks,
    intensity: effectiveMotion,
    onError: error => console.error(error)
  });
  controller.on(event => {
    if (event.type === 'state') {
      document.body.dataset.presentation = event.state;
      if (event.state === 'settled' || event.state === 'error') state.waiting = false;
      syncControls();
    } else if (event.type === 'waiting') {
      state.waiting = event.value;
      if (event.value) setStatus('Reading image', 'Still reading the file. The result appears as soon as it is ready.', 'busy');
      syncControls();
    } else if (event.type === 'warning') {
      log('The camera move took longer than expected.', 'warning');
    }
  });

  function beginPresentation(ctx) {
    pres = newPresentation(ctx.gen, ctx.replay);
    stage.acquire(ctx.profile);
    if (!ctx.replay) {
      setStatus('Reading image', 'Checking the file signature and embedded metadata.', 'busy');
      showNotice('Reading image metadata', 'Inspecting the selected file.');
      setText('mapSubtitle', 'Reading the selected image.');
    } else {
      hideNotice();
      setText('mapSubtitle', 'Showing the saved result again.');
    }
    play('intake', {gen: ctx.gen});
  }

  function cancelScramblers() {
    for (const s of pres.scramblers) s.cancel();
    pres.scramblers = [];
  }

  /* -------------------------------------------------- staged result rendering -- */
  // Each present* function is idempotent so Skip can safely run all of them at once.

  function presentOutcome(report, ctx) {
    if (pres.shown.outcome) return;
    pres.shown.outcome = true;
    const outcome = OUTCOMES[report.status] || OUTCOMES.no_location;
    setStatus(outcome.title, outcome.message, outcome.kind);
    const quiet = ctx && ctx.replay;
    if (report.status === 'located') {
      showNotice('Position found', 'Moving the map to the embedded GPS position.', 'i-locate');
    } else {
      showNotice(outcome.title, outcome.message, outcome.icon);
      setText('mapSubtitle', 'No validated coordinate pair to plot.');
      setText('resultEmpty', outcome.rail);
      $('resultEmpty').hidden = false;
      if (!quiet) {
        log(outcome.title + '.', 'warning');
        for (const issue of report.issues || []) log(issue.error, 'warning');
      }
      if (report.status === 'conflicting_location') showCandidates(report);
    }
  }

  function showCandidates(report) {
    const list = $('candidateList');
    list.replaceChildren();
    for (const c of report.candidates || []) {
      const item = node('li', 'num', pair(c));
      item.append(node('span', '', 'Source: ' + c.source));
      list.append(item);
    }
    $('candidates').hidden = !list.children.length;
  }

  function presentDetails(report, {animate}) {
    if (pres.shown.details) return;
    pres.shown.details = true;
    releaseLog();
    renderTags({animate});
    renderSummary(report);
    $('exportReport').disabled = false;
    if (report.file.sha256) {
      setText('fileHash', report.file.sha256);
      $('hashPanel').hidden = false;
    }
  }

  function presentCoordinates(report, {animate, duration}) {
    if (pres.shown.coords || !report.location) return;
    pres.shown.coords = true;
    const p = report.location, lat = format(p.latitude), lon = format(p.longitude);
    setText('latitude', lat);
    setText('longitude', lon);
    setText('latitudeDMS', Core.toDMS(p.latitude, 'lat'));
    setText('longitudeDMS', Core.toDMS(p.longitude, 'lon'));
    setText('altitude', p.altitude === null ? 'Not recorded' : p.altitude.toFixed(2) + ' m');
    setText('accuracy', p.accuracyMeters === null ? 'Not recorded' : p.accuracyMeters.toFixed(1) + ' m');
    $('resultEmpty').hidden = true;
    $('coordinates').hidden = false;
    $('copyCoordinates').disabled = false;
    if (animate) {
      // The real elements already hold the exact text. The overlays are decoration only.
      pres.scramblers.push(Stage.scramble($('latitude'), $('latitudeFx'), lat, {duration}));
      pres.scramblers.push(Stage.scramble($('longitude'), $('longitudeFx'), lon, {duration}));
    }
  }

  function presentMapCoverage(report, plan, ctx) {
    if (pres.shown.mapCoverage) return;
    pres.shown.mapCoverage = true;
    const p = report.location, regional = plan.kind === 'regional';
    hideNotice();
    setText('mapCoordinate', pair(p));
    $('mapCoordinate').hidden = false;
    setText('mapTitle', 'Embedded GPS');
    setText('mapSubtitle', regional ? 'Detailed offline street geometry for Gainesville and the University of Florida.' : 'Exact GPS point on an offline world overview.');
    setText('coverageBadge', regional ? 'OFFLINE / STREETS' : 'OFFLINE / OVERVIEW');
    setText('coverageNote', regional
      ? (mapMeta.features || 0).toLocaleString() + ' local map features. Coordinates come from the image.'
      : 'Detailed offline streets are not bundled for this location, so the exact point stays on the world overview. Street detail is included for Gainesville and the University of Florida.');
    if (!(ctx && ctx.replay)) log(regional ? 'GPS marker placed on the local street map.' : 'GPS marker placed on the offline world overview.', 'ok');
  }

  function presentPolar(report, ctx) {
    if (pres.shown.mapCoverage) return;
    pres.shown.mapCoverage = true;
    showNotice('GPS found near a pole', 'The coordinates are valid, but this map projection cannot accurately display latitudes above 85.051°. The exact coordinates remain available in the results.', 'i-locate');
    setText('mapSubtitle', 'Coordinate lies outside the map projection range.');
    setText('coverageBadge', 'GPS / POLAR');
    $('mapCoordinate').hidden = true;
    if (!(ctx && ctx.replay)) log('Coordinates are outside the Web Mercator display range.', 'warning');
  }

  function presentFinal(report, {instant, ctx}) {
    presentOutcome(report, ctx);
    presentDetails(report, {animate: false});
    let mapped = false;
    if (report.status === 'located') {
      presentCoordinates(report, {animate: false});
      const plan = director.classify(report.location);
      if (isMappable(plan)) {
        mapped = true;
        if (instant) {
          if (plan.kind === 'regional') try {baseLayer.prepare();} catch (error) {console.error(error);}
          director.jump(report.location);
        }
        if (!pres.pin) placePin(report, {animate: false});
        presentMapCoverage(report, plan, ctx);
        if (pres.pin) pres.pin.openPopup();
      } else {
        presentPolar(report, ctx);
      }
    }
    if (!mapped) director.rest();      // nothing to plot: the camera comes to rest on the wide view, never mid-zoom
    stage.settle(kindOf(report));
    // The lock cue already played on the normal path. After Skip, or when nothing was mapped, play the closing cue.
    if (!document.hidden) {
      if (mapped && instant) play('lock', {gen: pres.gen});
      else if (!mapped) play('neutral', {gen: pres.gen});
    }
    const outcome = OUTCOMES[report.status];
    announce(report.status === 'located'
      ? outcome.title + '. Latitude ' + format(report.location.latitude) + ', longitude ' + format(report.location.longitude) + '.'
      : outcome.title + '. ' + outcome.message);
    syncControls();
  }

  function presentFailure(error, ctx) {
    releaseLog();
    const title = FAILURES[error.code] || 'Could not read image metadata';
    state.error = error;
    state.analysis = 'failed';
    stage.fail();
    setStatus(title, error.message, 'error');
    showNotice(title, 'No location has been assumed. ' + error.message, 'i-error');
    setText('mapSubtitle', 'No validated coordinate pair to plot.');
    director.rest();
    setText('resultEmpty', 'Nothing could be read from this file.');
    $('resultEmpty').hidden = false;
    setText('metadataEmpty', 'No metadata could be read from this file.');
    log(error.message, 'error');
    if (state.startedAt) setText('elapsed', Math.round(performance.now() - state.startedAt) + ' ms');
    announce(title + '. ' + error.message, true);
    play('error', {gen: ctx ? ctx.gen : generation});
    syncControls();
  }

  /* ---------------------------------------------------------- tables and summary -- */

  function groupTags(fields) {
    const groups = new Map();
    for (const f of fields) {
      const dot = f.tag.indexOf('.');
      const key = dot > 0 ? f.tag.slice(0, dot) : 'other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({field: f, leaf: dot > 0 ? f.tag.slice(dot + 1) : f.tag});
    }
    const rank = key => key in GROUP_ORDER ? GROUP_ORDER[key] : 3;
    return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  function renderTags({animate = false} = {}) {
    // The tag table belongs to the reveal: typing in the filter while the scan is still running must not show it early.
    if (state.report && !pres.shown.details) return;
    const fields = state.report ? state.report.metadata : [];
    const query = $('tagSearch').value.trim().toLowerCase();
    const visible = fields.filter(f => !query || f.tag.toLowerCase().includes(query) || f.value.toLowerCase().includes(query));
    const body = $('metadataBody');
    body.replaceChildren();
    body.classList.toggle('revealing', animate);
    let index = 0;
    for (const [group, rows] of groupTags(visible)) {
      const header = node('tr', 'group' + (group === 'gps' ? ' is-gps' : '') + (animate ? ' row-in' : ''));
      header.style.setProperty('--i', Math.min(index++, 28));
      const title = node('td', '', GROUP_LABELS[group] || group);
      title.colSpan = 2;
      header.append(title);
      body.append(header);
      for (const {field, leaf} of rows) {
        const tr = node('tr', (group === 'gps' ? 'is-gps' : '') + (animate ? ' row-in' : ''));
        tr.style.setProperty('--i', Math.min(index++, 28));
        const key = node('td', '', leaf);
        key.title = field.tag;
        tr.append(key, node('td', '', field.value));
        body.append(tr);
      }
    }
    setText('tagCount', (query ? visible.length + ' / ' : '') + plural(fields.length, 'tag'));
    $('metadataTable').hidden = visible.length === 0;
    $('metadataEmpty').hidden = visible.length !== 0;
    setText('metadataEmpty', !state.report ? 'Image metadata will appear here.' : fields.length ? 'No tags match your filter.' : 'No readable metadata tags were found.');
  }

  function renderSummary(report) {
    const s = report.summary;
    const entries = [
      ['Camera', [s.make, s.model].filter(Boolean).join(' ')],
      ['Recorded time', s.recordedTime],
      ['Time offset', s.timeOffset],
      ['Dimensions', s.width && s.height ? s.width + ' × ' + s.height : null],
      ['GPS source', report.location && report.location.source]
    ];
    const box = $('captureSummary');
    box.replaceChildren();
    for (const [name, value] of entries) {
      if (!value) continue;
      const row = node('div');
      row.append(node('dt', '', name), node('dd', '', String(value)));
      box.append(row);
    }
    box.hidden = !box.children.length;
  }

  /* ------------------------------------------------------------------ pin etc. -- */

  const RETICLE = '<svg class="reticle" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" stroke-width="2"/><path d="M32 4v15M32 45v15M4 32h15M45 32h15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="32" r="3.2" fill="currentColor"/></svg><i class="ring r1"></i><i class="ring r2"></i>';

  function removePin() {
    if (pres.pin) {pres.pin.remove(); pres.pin = null;}
    if (pres.accuracy) {pres.accuracy.remove(); pres.accuracy = null;}
    $('mapCoordinate').hidden = true;
  }

  function popupContent(report) {
    const p = report.location;
    const box = node('div', 'pin-card');
    box.append(node('div', 'pin-pair num', pair(p)));
    const list = node('dl');
    const add = (name, value) => {list.append(node('dt', '', name), node('dd', 'num', value));};
    add('Elevation', p.altitude === null ? 'Not recorded' : p.altitude.toFixed(2) + ' m');
    add('Position error', p.accuracyMeters === null ? 'Not recorded' : p.accuracyMeters.toFixed(1) + ' m');
    add('Read from', p.source);
    box.append(list, node('p', '', 'Recorded in the image’s GPS tags.'));
    return box;
  }

  function placePin(report, {animate}) {
    removePin();
    const p = report.location;
    // The pin and the accuracy circle sit exactly on the recorded coordinate. They are never snapped to a road.
    const icon = L.divIcon({className: 'trace-pin-icon', iconSize: [64, 64], iconAnchor: [32, 32], html: '<div class="trace-pin" data-lock="' + (animate ? 'true' : 'done') + '">' + RETICLE + '</div>'});
    const marker = L.marker([p.latitude, p.longitude], {title: 'Embedded image GPS', zIndexOffset: 700, icon}).addTo(map);
    marker.bindPopup(popupContent(report), {autoPan: false, offset: [0, -26], maxWidth: 300});
    pres.pin = marker;
    if (p.accuracyMeters !== null) {
      pres.accuracy = L.circle([p.latitude, p.longitude], {radius: p.accuracyMeters, color: '#ec77a1', weight: 1, fillColor: '#c64d7e', fillOpacity: .07, interactive: false}).addTo(map);
    }
    syncControls();
  }

  /* ------------------------------------------------------------- file and parse -- */

  async function sha256(bytes) {
    if (!globalThis.crypto || !crypto.subtle) return null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    } catch {return null;}
  }

  async function parseFile(file, buffer, gen) {
    if (typeof Worker !== 'function') return MetadataParser.parse(buffer);
    let worker, url;
    try {
      url = URL.createObjectURL(new Blob([window.METADATA_WORKER_SOURCE], {type: 'text/javascript'}));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch {
      if (url) URL.revokeObjectURL(url);
      log('Worker unavailable; using the local parser.', 'warning');
      return MetadataParser.parse(buffer);
    }
    return new Promise((resolve, reject) => {
      let done = false, timer = 0;
      const finish = (settle, value) => {
        if (done) return;
        done = true; clearTimeout(timer); worker.terminate();
        if (state.job === job) state.job = null;
        settle(value);
      };
      const job = {cancel() {const e = new Error('Analysis cancelled.'); e.name = 'AbortError'; finish(reject, e);}};
      timer = setTimeout(() => {const e = new Error('Metadata parsing exceeded the 12-second limit.'); e.code = 'parse_error'; finish(reject, e);}, PARSE_TIMEOUT_MS);
      state.job = job;
      worker.onmessage = e => {
        if (e.data && e.data.ok) return finish(resolve, e.data.result);
        const error = new Error((e.data && e.data.message) || 'Metadata could not be read.');
        error.code = (e.data && e.data.code) || 'parse_error';
        finish(reject, error);
      };
      worker.onerror = async e => {
        if (e.preventDefault) e.preventDefault();
        if (done) return;
        done = true; clearTimeout(timer); worker.terminate();
        if (state.job === job) state.job = null;
        try {
          if (stale(gen)) throw Object.assign(new Error('Cancelled'), {name: 'AbortError'});
          log('Worker startup failed; using the local parser.', 'warning');
          const fresh = buffer.byteLength ? buffer : await file.arrayBuffer();
          resolve(await MetadataParser.parse(fresh));
        } catch (error) {reject(error);}
      };
      try {worker.postMessage({buffer}, [buffer]);} catch (error) {finish(reject, error);}
    });
  }

  /** The real analysis. It reports facts to the presentation and nothing else. */
  async function runAnalysis(gen, session) {
    const file = state.file;
    try {
      log('Reading ' + file.name + ' (' + file.size.toLocaleString() + ' bytes).');
      const buffer = await file.arrayBuffer();
      if (stale(gen)) return;
      session.signal.acquired({bytes: buffer.byteLength});
      const detected = Core.detectFormat(new Uint8Array(buffer));
      if (!detected) throw Object.assign(new Error('Unsupported file format. Use JPEG, PNG, TIFF, WebP, HEIC, or AVIF.'), {code: 'unsupported_format'});
      stage.setSample(Stage.sampleBytes(buffer, 40));   // real bytes, taken before the buffer moves to the worker
      log('Detected format: ' + detected.toUpperCase() + '.');
      const checksum = await sha256(buffer);
      if (stale(gen)) return;
      if (checksum) log('SHA-256 calculated from the selected file.', 'ok');
      log('Parsing EXIF, GPS, XMP, and IPTC blocks.');
      const parsed = await parseFile(file, buffer, gen);
      if (stale(gen)) return;
      const report = Core.describe(parsed.raw, file, parsed.format, checksum);
      log(plural(report.metadata.length, 'metadata tag') + ' read.', 'ok', {hold: true});
      if (report.status === 'located') {
        log('GPSLatitude: ' + format(report.location.latitude), 'ok', {hold: true});
        log('GPSLongitude: ' + format(report.location.longitude), 'ok', {hold: true});
        if (report.location.altitude !== null) log('GPSAltitude: ' + report.location.altitude.toFixed(2) + ' m', 'ok', {hold: true});
      }
      state.report = report;
      state.analysis = 'complete';
      setElapsed(Math.round(performance.now() - state.startedAt));
      log('Analysis complete.', 'ok', {hold: true});
      session.signal.report(report);
    } catch (error) {
      if (stale(gen) || error.name === 'AbortError') return;
      state.analysis = 'failed';
      session.signal.fail(error);
    }
  }

  /* ---------------------------------------------------------------- user actions -- */

  /** Stops every pending parse, timer, sound, scramble and camera move. Safe at any time. */
  function cancelAll(reason) {
    generation++;
    controller.cancel(reason);
    if (state.job) state.job.cancel();
    audio.stopAll(0.04);
    director.cancel('cancelled');
    stage.stop();
    cancelScramblers();
    state.waiting = false;
    state.heldLog = null;
    state.heldElapsed = null;
  }

  /** Empties every panel that shows results. The file, its preview and the report object stay. */
  function resetResultPanels() {
    removePin();
    hideNotice();
    $('coordinates').hidden = true;
    $('candidates').hidden = true;
    $('candidateList').replaceChildren();
    $('captureSummary').hidden = true;
    $('captureSummary').replaceChildren();
    $('metadataBody').replaceChildren();
    $('metadataTable').hidden = true;
    $('metadataEmpty').hidden = false;
    setText('metadataEmpty', 'Image metadata will appear here.');
    setText('tagCount', '0 tags');
    $('hashPanel').hidden = true;
    setText('fileHash', '');
    $('copyCoordinates').disabled = true;
    $('exportReport').disabled = true;
    setText('resultEmpty', 'Coordinates appear here when the file records a valid GPS position.');
    $('resultEmpty').hidden = false;
    setText('mapTitle', 'Embedded GPS');
    setText('mapSubtitle', 'Select an image to locate its GPS tags.');
    setText('coverageBadge', 'OFFLINE MAP');
    setText('coverageNote', 'World outlines are included. Street detail is bundled for the Gainesville and University of Florida area.');
    for (const id of ['latitude', 'longitude', 'latitudeFx', 'longitudeFx']) setText(id, '');
  }

  function revokePreview() {
    if (state.previewURL) {URL.revokeObjectURL(state.previewURL); state.previewURL = null;}
    $('preview').removeAttribute('src');
    $('preview').hidden = true;
    $('previewFallback').hidden = true;
    $('bay').style.removeProperty('--ar');
  }

  function showPreview(file, formatName) {
    revokePreview();
    $('previewFallback').hidden = false;
    state.previewURL = URL.createObjectURL(new Blob([file], {type: SAFE_MIME[formatName]}));
    $('preview').onload = () => {
      const img = $('preview');
      if (img.naturalWidth && img.naturalHeight) $('bay').style.setProperty('--ar', Math.min(3.5, Math.max(.4, img.naturalWidth / img.naturalHeight)).toFixed(4));
      img.hidden = false;
      $('previewFallback').hidden = true;
      stage.resize();
    };
    $('preview').onerror = () => {$('preview').hidden = true; $('previewFallback').hidden = false;};
    $('preview').src = state.previewURL;
  }

  /** A file was chosen: seat it and run the cheap checks. The metadata is read only when Analyze is pressed. */
  async function selectFile(file) {
    if (!file) return;
    cancelAll('select');
    const gen = generation;
    state.file = file;
    state.canAnalyze = false;
    state.report = null;
    state.error = null;
    state.startedAt = 0;
    state.analysis = 'selected';
    resetResultPanels();
    resetLog();
    setText('elapsed', '—');
    revokePreview();
    $('fileCard').hidden = false;
    setText('fileName', file.name);
    setText('fileDetails', (file.size / 1024 / 1024).toFixed(2) + ' MiB');
    document.body.dataset.presentation = 'idle';
    setStatus('Checking image', 'Looking at the file signature.', 'neutral');
    log('Selected ' + file.name + '.');

    const reject = (code, message) => {
      const error = Object.assign(new Error(message), {code});
      stage.fail();
      $('previewFallback').hidden = false;
      presentFailure(error, {gen});
    };
    if (!file.size) return reject('invalid_file', 'The selected file is empty.');
    if (file.size > Core.MAX_FILE_BYTES) return reject('file_too_large', 'The image exceeds the 64 MiB limit. Choose a smaller original file.');
    let head;
    try {head = new Uint8Array(await file.slice(0, FILE_HEAD_BYTES).arrayBuffer());}
    catch {if (!stale(gen)) reject('read_error', 'The file could not be opened.'); return;}
    if (stale(gen)) return;
    const detected = Core.detectFormat(head);
    if (!detected) return reject('unsupported_format', 'Unsupported file format. Use JPEG, PNG, TIFF, WebP, HEIC, or AVIF.');

    state.canAnalyze = true;
    setText('fileDetails', detected.toUpperCase() + ' · ' + (file.size / 1024 / 1024).toFixed(2) + ' MiB');
    showPreview(file, detected);
    stage.ready();
    setText('mapSubtitle', 'Select Analyze to read this image.');
    setStatus('Image ready', 'Select Analyze to read its embedded metadata. Nothing leaves this device.', 'neutral');
    announce('Selected ' + file.name + '. Select Analyze to read its metadata.');
    syncControls();
    $('analyze').focus({preventScroll: true});
  }

  function startAnalysis() {
    if (!state.file || !state.canAnalyze || isBusy()) return;
    unlockAudio();                                   // from this gesture, never awaited
    cancelAll('analyze');
    resetResultPanels();
    resetLog();
    const gen = generation;
    state.report = null;
    state.error = null;
    state.analysis = 'reading';
    state.startedAt = performance.now();
    state.heldLog = [];
    state.heldElapsed = null;
    setText('elapsed', '…');
    document.body.dataset.presentation = 'idle';
    const session = controller.start({gen});
    syncControls();
    $('skip').focus({preventScroll: true});
    announce('Reading image.');
    runAnalysis(gen, session);
  }

  /** Shows the existing result again. The file is not read or parsed a second time. */
  function replay() {
    if (!state.report || isBusy()) return;
    unlockAudio();
    cancelAll('replay');
    resetResultPanels();
    const gen = generation;
    $('exportReport').disabled = true;
    controller.replay({gen, report: state.report});
    syncControls();
    $('skip').focus({preventScroll: true});
  }

  function skip() {
    if (controller.skip()) syncControls();
  }

  function clearAll() {
    cancelAll('clear');
    state.file = null;
    state.canAnalyze = false;
    state.report = null;
    state.error = null;
    state.startedAt = 0;
    state.analysis = 'idle';
    state.clean = false;
    resetResultPanels();
    revokePreview();
    $('fileInput').value = '';
    $('fileCard').hidden = true;
    resetLog('Ready to read a local image.');
    setText('elapsed', '—');
    stage.reset();
    $('bay').dataset.clean = 'false';
    $('cleanView').setAttribute('aria-pressed', 'false');
    setStatus('Waiting for an image', 'Your file stays on this device.', 'neutral');
    map.closePopup();
    map.setView([20, 0], 2.2, {animate: false});
    document.body.dataset.presentation = 'idle';
    syncControls();
    announce('Cleared. Waiting for an image.');
  }

  function chooseImage() {
    $('fileInput').value = '';       // so choosing the same file again still fires a change event
    $('fileInput').click();
  }

  function recenter() {
    const report = state.report;
    if (!report || !report.location || controller.running) return;
    director.recenter(report.location, {animate: effectiveMotion() !== 'reduced'});
  }

  async function copyCoordinates() {
    const report = state.report;
    if (!report || !report.location) return;
    const text = pair(report.location);
    try {await navigator.clipboard.writeText(text); toast('Coordinates copied.');}
    catch {toast('Copy the coordinates from the results: ' + text);}
  }

  function exportReport() {
    const report = state.report;
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = report.file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) + '.metadata.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toggleClean() {
    state.clean = !state.clean;
    $('bay').dataset.clean = String(state.clean);
    $('cleanView').setAttribute('aria-pressed', String(state.clean));
  }

  /* ------------------------------------------------------------- control state -- */

  function isBusy() {return state.analysis === 'reading' || controller.running;}

  function syncControls() {
    const hasFile = !!state.file, busy = isBusy(), located = !!(state.report && state.report.location);
    const before = document.activeElement;
    $('analyze').disabled = !(hasFile && state.canAnalyze) || busy;
    $('skip').disabled = !controller.running;
    setText('skipLabel', state.waiting || !state.report && state.analysis === 'reading' ? 'Show result' : 'Skip animation');
    $('changeImage').disabled = !hasFile;
    $('replay').disabled = !(state.report && !busy);
    $('cleanView').disabled = !hasFile;
    $('clear').disabled = !hasFile;
    $('recenter').disabled = !(located && pres.pin) || controller.running;
    document.body.setAttribute('aria-busy', String(busy));
    document.body.dataset.analysis = state.analysis;
    // A focused control that has just been disabled would strand keyboard users: move focus on.
    if (before && before.disabled) {
      const next = ['replay', 'analyze', 'changeImage'].map($).find(b => !b.disabled);
      if (next) next.focus({preventScroll: true});
    }
  }

  /* -------------------------------------------------------------------- events -- */

  $('fileInput').addEventListener('change', () => selectFile($('fileInput').files[0]));
  $('chooseButton').addEventListener('click', e => {e.stopPropagation(); chooseImage();});
  $('bay').addEventListener('click', () => {if (!state.file) chooseImage();});
  for (const type of ['dragenter', 'dragover']) $('bay').addEventListener(type, e => {e.preventDefault(); $('bay').classList.add('dragging');});
  for (const type of ['dragleave', 'drop']) $('bay').addEventListener(type, e => {e.preventDefault(); $('bay').classList.remove('dragging');});
  $('bay').addEventListener('drop', e => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (files.length > 1) toast('Analyzing the first image. Select images one at a time.');
    selectFile(files[0]);
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  $('analyze').addEventListener('click', startAnalysis);
  $('skip').addEventListener('click', skip);
  $('changeImage').addEventListener('click', chooseImage);
  $('replay').addEventListener('click', replay);
  $('cleanView').addEventListener('click', toggleClean);
  $('clear').addEventListener('click', clearAll);
  $('tagSearch').addEventListener('input', () => renderTags({animate: false}));
  $('zoomIn').addEventListener('click', () => {director.cancel('interrupted'); map.zoomIn();});
  $('zoomOut').addEventListener('click', () => {director.cancel('interrupted'); map.zoomOut();});
  $('recenter').addEventListener('click', recenter);
  $('copyCoordinates').addEventListener('click', copyCoordinates);
  $('exportReport').addEventListener('click', exportReport);
  $('fullscreen').addEventListener('click', async () => {
    try {if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();}
    catch {toast('Use your browser’s fullscreen control.');}
  });

  $('soundToggle').addEventListener('click', onSoundToggle);
  $('volume').addEventListener('input', () => {
    settings.volume = Number($('volume').value);
    audio.setVolume(settings.volume / 100);
  });
  $('volume').addEventListener('change', () => {
    saveSettings();
    if (settings.sound) unlockAudio().then(status => {if (status === 'running') play('tick', {index: 2});});
  });
  $('motion').addEventListener('change', () => {
    settings.motion = $('motion').value;
    saveSettings();
    applyMotion();
  });
  if (reducedQuery) {
    const onChange = () => {if (!settings.motion) applyMotion();};
    if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', onChange);
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && controller.running) {e.preventDefault(); skip();}
  });
  // A hidden tab cannot show the animation, so finish it and quieten the sound.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    audio.stopAll(0.1);
    if (controller.running) controller.skip();
  });
  window.addEventListener('resize', () => stage.resize());

  /* ---------------------------------------------------------- read-only diagnostics -- */

  Object.defineProperty(window, 'MetaTrace', {
    value: Object.freeze({
      /** A plain-data snapshot for tests and support. It cannot change anything. */
      snapshot() {
        const c = map.getCenter();
        return {
          generation,
          analysis: state.analysis,
          presentation: controller.state,
          running: controller.running,
          waiting: state.waiting,
          motion: effectiveMotion(),
          clean: state.clean,
          file: state.file ? {name: state.file.name, size: state.file.size} : null,
          status: state.report ? state.report.status : null,
          location: state.report && state.report.location ? {latitude: state.report.location.latitude, longitude: state.report.location.longitude} : null,
          camera: {lat: c.lat, lng: c.lng, zoom: map.getZoom()},
          flying: director.flying,
          flightId: director.flightId,
          pin: pres.pin ? {lat: pres.pin.getLatLng().lat, lng: pres.pin.getLatLng().lng, popupOpen: pres.pin.isPopupOpen()} : null,
          accuracy: pres.accuracy ? {lat: pres.accuracy.getLatLng().lat, lng: pres.accuracy.getLatLng().lng, radius: pres.accuracy.getRadius()} : null,
          mapNotice: $('mapNotice').hidden ? null : $('mapNoticeTitle').textContent,
          coverage: $('coverageBadge').textContent,
          stagePhase: stage.phase,
          stageActive: stage.active,
          audio: audio.snapshot(),
          layer: {...baseLayer.stats}
        };
      }
    })
  });

  /* ---------------------------------------------------------------------- start -- */

  loadSettings();
  audio.setEnabled(settings.sound);
  audio.setVolume(settings.volume / 100);
  $('volume').value = String(settings.volume);
  applyMotion();
  syncSoundChip();
  syncControls();
  document.body.dataset.presentation = 'idle';
})();
