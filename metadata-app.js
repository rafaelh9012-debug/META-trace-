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
    return {gen, replay, scan: null, descend: null, spin: null, interrupted: false, scramblers: [], pin: null, accuracy: null, shown: {outcome: false, details: false, coords: false, mapCoverage: false}};
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
    // Reduced motion: the globe holds still. It still answers dragging and zooming.
    if (typeof globe !== 'undefined') {
      globe.setMotionReduced(effectiveMotion() === 'reduced');
      globe.setIdleRate(effectiveMotion() === 'reduced' ? 0 : GLOBE_IDLE_RATE);
    }
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

  // zoomSnap 0: the five-mile frame needs the exact fitted zoom, not the nearest tenth.
  const map = L.map('map', {zoomControl: false, minZoom: 1, maxZoom: 20, zoomSnap: 0, zoomDelta: .5, worldCopyJump: true, fadeAnimation: false}).setView([20, 0], 2.2);
  map.createPane('traceBase').style.zIndex = 100;
  const baseLayer = TraceCanvasLayer.create(L, {
    world: window.TRACE_WORLD_DATA, local: hasLocalData ? mapData : null, bounds: hasLocalData ? mapMeta.bounds : null,
    localLabels: window.TRACE_MAP_LABELS, worldLabels: window.TRACE_WORLD_LABELS,
    selectLabels: MapUtils.selectLabels, pane: 'traceBase'
  }).addTo(map);
  map.attributionControl.addAttribution('World: Natural Earth · Reference cities: IANA time zones · Streets: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
  L.control.scale({imperial: true, metric: true, position: 'bottomright', maxWidth: 110}).addTo(map);

  /* ------------------------------------------------------------ regional map packages -- */

  // Optional map packages the person adds from a file (see "Map data"). The bundled streets work without any of this.
  // Packages are read by byte range from the file, a few tiles at a time; nothing is loaded whole and nothing is fetched.
  const regionManager = RegionManager.create({
    decode: MVTDecoder.decodeTile, adapt: TileSchema.adaptTile,
    onChange: () => baseLayer.regionsChanged(),
    onError: error => console.error(error)
  });
  baseLayer.setRegions(regionManager);
  const inBox = (b, lat, lon) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  const REGION_VIEW_PAD = .18;
  /** The map view (west/east/south/north) a viewport of the map's size has when centred on `at` at `zoom`. */
  function regionViewAround(at, zoom, pad = REGION_VIEW_PAD) {
    const size = map.getSize(), RM = RegionManager, halfX = size.x / 2 / 256 * (1 + pad), halfY = size.y / 2 / 256 * (1 + pad);
    const cx = RM.lonToX(at.longitude, zoom), cy = RM.latToY(at.latitude, zoom);
    return {zoom, west: RM.xToLon(cx - halfX, zoom), east: RM.xToLon(cx + halfX, zoom), north: RM.yToLat(cy - halfY, zoom), south: RM.yToLat(cy + halfY, zoom)};
  }
  /** Where street detail at a point comes from: an installed package, the bundled Gainesville data, or nowhere. */
  function streetSource(lat, lon) {
    const pkg = regionManager.covers(lat, lon);
    if (pkg) return {kind: 'package', pkg};
    if (hasLocalData && inBox(mapMeta.bounds, lat, lon)) return {kind: 'bundled'};
    return {kind: 'none'};
  }
  /** Starts loading the tiles the final view and the descent will need, while the globe is still turning. */
  function prefetchRegions(location) {
    if (!regionManager.size || !regionManager.covers(location.latitude, location.longitude)) return;
    let zoom;
    try {zoom = globeDirector.finalFor(location).zoom;} catch (error) {return;}
    for (const drop of [0, 1.5, 3]) {
      try {regionManager.ensure(regionViewAround(location, Math.max(RegionManager.DEFAULTS.minMapZoom, zoom - drop)));} catch (error) {console.error(error);}
    }
  }
  /** The five-mile frame around a point as a view: 2.5 miles each way on the ground, a little more in longitude away from the equator. */
  function frameViewAround(at, zoom) {
    const dLat = 4023.36 / 111320, dLon = dLat / Math.max(0.05, Math.cos(at.latitude * Math.PI / 180));
    return {zoom, west: at.longitude - dLon, east: at.longitude + dLon, south: Math.max(-85, at.latitude - dLat), north: Math.min(85, at.latitude + dLat)};
  }

  /* ------------------------------------------------------------------- globe -- */

  const GM = GlobeMath;
  const GLOBE_HOME = {lon: -25, lat: 18};
  const GLOBE_IDLE_RATE = 3.2;                       // degrees per second while the globe waits
  const globePack = window.TRACE_GLOBE_PACK ? GlobeData.load(window.TRACE_GLOBE_PACK) : null;
  const mapPanel = document.querySelector('.map-panel');
  // The shallowest the person may zoom the globe by hand: about 1.8 km per pixel, where the flat map takes over.
  const globeUserLimit = () => GM.altForGroundScale(globe.camera.focal, 0, 1800);
  const globe = GlobeView.create({
    canvas: $('globeCanvas'), data: globePack, readout: $('globeReadout'),
    width: Math.max(1, $('map').clientWidth), height: Math.max(1, $('map').clientHeight),
    lon: GLOBE_HOME.lon, lat: GLOBE_HOME.lat, alt: GM.IDLE_ALT,
    onUserInput: () => globeDirector.interrupt(),
    onHome: () => recenter(),
    onZoomPastLimit: from => {if (!globeDirector.running) globeDirector.showMap({fadeMs: effectiveMotion() === 'reduced' ? 180 : 450, from});}
  });
  globe.setUserMinAlt(globeUserLimit());

  // Where the bundled street data is. Installed regional packages (see Map data) add boxes here.
  const coverageBoxes = () => (hasLocalData ? [mapMeta.bounds] : []).concat(regionManager.coverageBoxes());
  const mapDirector = MapDirector.create({L, map, bounds: coverageBoxes, zoomFor: loc => globeDirector.finalFor(loc).zoom, onInterrupt() {
    toast('The map is yours now. Use Recenter to return to the GPS position.');
  }});
  const globeDirector = GlobeDirector.create({
    L, map, mapDirector, globe, panel: mapPanel, frame: $('frame5'), idleRate: GLOBE_IDLE_RATE,
    userMinAlt: globeUserLimit,
    // The heading above and the coverage note below keep bands of the pane (CSS custom properties); the frame stays clear of them.
    reserve: () => {
      const cs = getComputedStyle(mapPanel), px = name => {const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? v : 0;};
      return {top: px('--reserve-top'), bottom: px('--reserve-bottom')};
    },
    onError: error => console.error(error),
    hooks: {
      onView: view => syncViewControls(view),
      onPhase: (name, info) => onFlightPhase(name, info),
      onDetail: level => onFlightDetail(level),
      onInterrupt: () => onFlightInterrupt()
    }
  });
  // The one object the rest of the app talks to. Classification stays with the map director; every camera move goes
  // through the globe director, which owns both renderers.
  const director = {
    classify: loc => mapDirector.classify(loc),
    fly: (loc, o) => globeDirector.fly(loc, o),
    jump: (loc, o) => globeDirector.jump(loc, o),
    rise: o => globeDirector.rise(o),
    rest: () => globeDirector.rest(),
    recenter: (loc, o) => globeDirector.recenter(loc, o),
    cancel: why => {const a = globeDirector.cancel(why), b = mapDirector.cancel(why); return a || b;},
    get view() {return globeDirector.view;},
    get flying() {return globeDirector.running || mapDirector.flying;},
    get flightId() {return mapDirector.flightId;}
  };
  new ResizeObserver(() => {
    map.invalidateSize({pan: false});
    const box = $('map').getBoundingClientRect();
    globe.resize(box.width, box.height);
    if (!globeDirector.running && globeDirector.view === 'globe') globe.setUserMinAlt(globeUserLimit());
    stage.resize();
    globeDirector.refit();
  }).observe($('map'));
  // Zooming the flat map far out hands back to the globe at the same ground scale.
  map.on('zoomend', () => {
    if (globeDirector.busy || globeDirector.view !== 'map') return;
    const c = map.getCenter();
    if (GM.mercatorGroundScale(c.lat, map.getZoom()).mean > 6000) globeDirector.showGlobe({fadeMs: effectiveMotion() === 'reduced' ? 180 : 450, match: true});
  });
  globe.start();
  // Build the street geometry once, early, so the descent never stalls to build it. The globe animates continuously, so a bare
  // idle callback can be postponed indefinitely and then land in the middle of a flight (measured: a 130-260 ms stall that
  // made the camera jump). The timeout bounds the wait; the presentation also calls prepare() before it starts (plan hook).
  const whenIdle = window.requestIdleCallback ? cb => window.requestIdleCallback(cb, {timeout: 1000}) : cb => setTimeout(cb, 300);
  whenIdle(() => {try {baseLayer.prepare();} catch (error) {console.error(error);}});

  /* ---------------------------------------------------------------- scan stage -- */

  const stage = Stage.create({
    bay: $('bay'), frame: $('frame'), canvas: $('scanCanvas'), ticker: $('ticker'),
    onTick: index => play('tick', {index})
  });

  /* --------------------------------------------------------- presentation hooks -- */

  const kindOf = report => report.status === 'located' ? 'located' : report.status === 'no_location' ? 'neutral' : 'warning';
  // Near a pole the flat map cannot draw, but the globe can, so every valid coordinate has a final view.
  const isMappable = plan => plan.kind === 'regional' || plan.kind === 'overview' || plan.kind === 'polar';

  const hooks = {
    enter(name, ctx) {
      if (stale(ctx.gen)) return;
      switch (name) {
        case 'acquire': try {baseLayer.prepare();} catch (error) {console.error(error);} beginPresentation(ctx); break;   // street index built before any camera move
        case 'scan': {
          stage.scan(ctx.profile);
          pres.scan = play('scan', {gen: ctx.gen, maxSeconds: 12});
          const wantsFlight = !ctx.replay || (state.report && state.report.status === 'located');
          // A replay starts from the street map, and a cancelled descent leaves the globe close to the surface: either way,
          // back up to the whole globe while the scan runs, before the readout, so the revolution always starts from it.
          if (wantsFlight && globeDirector.needsRise) {
            if (ctx.profile.animateCamera) director.rise({duration: Math.min(1.6, 0.9 * (ctx.profile.scan + ctx.profile.reveal) / 1000)});
            else if (director.view === 'map') globeDirector.showGlobe({fadeMs: 180});
          }
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
          break;                      // the sounds start with the flight itself (see the fly hook)
        case 'lock': {
          stage.lock(ctx.profile);
          if (pres.descend) pres.descend.stop(0.15);
          if (pres.spin) pres.spin.stop(0.15);
          const plan = director.classify(ctx.report.location);
          if (isMappable(plan)) {
            if (plan.kind !== 'polar' && !pres.pin) placePin(ctx.report, {animate: false});
            // If the person took the camera, the result is shown but no lock is staged on a view they are no longer in.
            if (!pres.interrupted) {
              const final = globeDirector.final;
              if (final && final.renderer === 'globe') globeDirector.lockEffect(ctx.profile.lock);
              else armPinLock(ctx.profile);
              play('lock', {gen: ctx.gen});
            }
            presentMapCoverage(ctx.report, plan, ctx);
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
      try {baseLayer.prepare();} catch (error) {console.error(error);}     // a no-op once built; never mid-flight
      if (isMappable(plan) && plan.kind !== 'polar') prefetchRegions(ctx.report.location);   // tiles load while the globe turns
      return {fly: isMappable(plan)};
    },
    fly(ctx) {
      const location = ctx.report.location;
      revealMapPanel();
      // Reduced motion: no camera travel, only a short cross-fade to the final view.
      if (!ctx.profile.animateCamera) {director.jump(location, {fadeMs: 200}); return 'arrived';}
      return director.fly(location, {duration: ctx.profile.fly / 1000, revolutions: 1, onStart: plan => startFlightSounds(ctx, plan)});
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

  /** The coordinate card opens over the pin by itself only when there is room above the pin for it. On a short pane it would
   *  sit on the five-mile frame and its label; the coordinates are also on the map, in the Location panel, and one click away. */
  function popupFits() {
    const room = mapPanel.clientHeight / 2 - (parseFloat(getComputedStyle(mapPanel).getPropertyValue('--reserve-top')) || 0);
    return room >= 200;
  }

  /** In the stacked layouts (under 1181 px) the map sits below the stage. A flight that plays below the fold is not seen,
   *  so once the coordinates have been read out the map is brought into view: smoothly when motion is allowed, and only when
   *  it is not already fully visible. */
  function revealMapPanel() {
    try {
      const r = mapPanel.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top >= 0 && r.bottom <= vh) return;
      mapPanel.scrollIntoView({block: r.height >= vh ? 'start' : 'nearest', behavior: effectiveMotion() === 'reduced' ? 'auto' : 'smooth'});
    } catch (error) {/* scrolling is a courtesy; the sequence does not depend on it */}
  }

  /* The sounds follow the real camera. The spin cue is shaped by the planned rotation speed, the descent starts with the
     descent, one soft blip marks each level of detail, and the lock closes the sequence. */
  function startFlightSounds(ctx, plan) {
    const samples = 48, rates = [];
    let peak = 0;
    for (let i = 0; i <= samples; i++) {const r = Math.max(0, GM.spinRateAt(plan, plan.spinT * i / samples)); rates.push(r); peak = Math.max(peak, r);}
    pres.spin = play('spin', {gen: ctx.gen, duration: plan.spinT, curve: rates.map(r => peak > 0 ? r / peak : 0)});
  }
  function onFlightPhase(name, info) {
    if (stale(pres.gen) || !controller.running) return;
    if (name === 'descend' && globeDirector.plan) {
      const plan = globeDirector.plan;
      pres.descend = play('descend', {gen: pres.gen, duration: Math.max(.5, plan.T - plan.descT0)});
    } else if (name === 'handoff' && info.to === 'map' && state.report && state.report.location && !pres.pin) {
      placePin(state.report, {animate: false});        // the marker is already on the map as it fades in
    }
  }
  function onFlightDetail(level) {
    if (stale(pres.gen) || !controller.running || level > 4) return;
    play('detail', {gen: pres.gen, index: level - 1});
  }
  function onFlightInterrupt() {
    pres.interrupted = true;
    audio.stopGeneration(pres.gen, 0.15);
    toast('The view is yours now. Use Recenter to return to the GPS position.');
  }

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

  /** The coverage note: text, and optionally a button that opens the Map data dialog. */
  function setCoverage(text, action) {
    const note = $('coverageNote');
    note.textContent = text;
    if (action) {
      const button = node('button', 'coverage-action', action);
      button.type = 'button';
      button.id = 'coverageAdd';
      button.addEventListener('click', () => openMapData(button));
      note.append(button);
    }
  }
  /** What the person is told about the street detail at a located point. Only what the loaded data supports. */
  function coverageFor(location) {
    const src = streetSource(location.latitude, location.longitude);
    if (src.kind === 'package') {
      const info = src.pkg.info, name = src.pkg.name || info.name || 'the installed map package';
      const credit = info.attribution ? ' Map data: ' + info.attribution.replace(/[.\s]+$/, '').slice(0, 160) + '.' : '';
      const lead = [info.synthetic ? 'Generated test pattern, not a map of this place.' : '',
        info.maxZoom >= 14 ? (info.synthetic ? '' : 'Streets and buildings from "' + name + '".')
          : '"' + name + '" is coarse here (zoom ' + info.maxZoom + ' at most), so roads and buildings may be missing.'].filter(Boolean).join(' ');
      return {kind: 'package', subtitle: 'Five-mile view with streets from "' + name + '".', badge: 'OFFLINE / STREETS',
        note: lead + credit + ' Coordinates come from the image.'};
    }
    if (src.kind === 'bundled') {
      return {kind: 'bundled', subtitle: 'Five-mile view with Gainesville street data.', badge: 'OFFLINE / STREETS',
        note: (mapMeta.features || 0).toLocaleString() + ' local map features cover the middle of the frame. Coordinates come from the image.'};
    }
    return {kind: 'none', subtitle: 'Five-mile view centered on the GPS point.', badge: 'OFFLINE / OUTLINES',
      note: 'No offline roads or buildings are installed for this area, so only coastlines, borders and the exact GPS point are drawn. Nothing is drawn that is not in the data.',
      action: 'Add map data'};
  }
  function idleCoverageNote() {
    const added = regionManager.packages(), shown = added.slice(0, 2).map(p => p.name + (p.attribution ? ' (' + p.attribution.slice(0, 80) + ')' : ''));
    return 'Offline globe with coastlines, national borders and reference cities. Street detail is bundled for Gainesville and the University of Florida.'
      + (added.length ? ' Added map data: ' + shown.join('; ') + (added.length > 2 ? ' and ' + (added.length - 2) + ' more' : '') + '.' : '');
  }

  function presentMapCoverage(report, plan, ctx) {
    if (pres.shown.mapCoverage) return;
    pres.shown.mapCoverage = true;
    const p = report.location, c = coverageFor(p), gen = generation;
    hideNotice();
    setText('mapCoordinate', pair(p));
    $('mapCoordinate').hidden = false;
    setText('mapTitle', 'Embedded GPS');
    setText('mapSubtitle', c.subtitle);
    setText('coverageBadge', c.badge);
    setCoverage(c.note, c.action);
    if (!(ctx && ctx.replay)) log(c.kind === 'none' ? 'GPS marker placed on the offline globe and outline map; no local streets for this area.'
      : c.kind === 'package' ? 'GPS marker placed on the map from an installed map package.' : 'GPS marker placed on the local street map.', 'ok');
    if (c.kind === 'package') verifyPackageCoverage(report, gen);
  }
  /**
   * An installed package covers the point by its bounds, but a bounding box is not data. Once its tiles have loaded for the
   * final view, say so if nothing was found there.
   */
  function verifyPackageCoverage(report, gen) {
    const location = report.location;
    regionManager.whenIdle(6000).then(() => {
      if (stale(gen) || !state.report || state.report.location !== location) return;
      const at = regionManager.featuresIn(frameViewAround(location, map.getZoom()));
      if (!at.settled || at.features) return;
      const src = streetSource(location.latitude, location.longitude);
      const name = src.kind === 'package' ? src.pkg.name : 'The installed map package';
      setCoverage('"' + name + '" covers this area on paper but has no map features in this frame, so only outlines and the GPS point are drawn. Nothing is drawn that is not in the data.', 'Map data');
      setText('coverageBadge', 'OFFLINE / OUTLINES');
    }, error => console.error(error));
  }

  function presentPolar(report, ctx) {
    if (pres.shown.mapCoverage) return;
    pres.shown.mapCoverage = true;
    hideNotice();
    setText('mapCoordinate', pair(report.location));
    $('mapCoordinate').hidden = false;
    setText('mapSubtitle', 'Five-mile view on the globe. The flat map cannot draw latitudes above 85.051°.');
    setText('coverageBadge', 'OFFLINE / GLOBE');
    setCoverage('Near a pole the globe stays the map. Only coastlines and borders from the bundled data are drawn; there are no roads or buildings here.');
    if (!(ctx && ctx.replay)) log('GPS marker placed on the globe; the coordinates are outside the flat map range (85.051°).', 'ok');
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
          director.jump(report.location, {fadeMs: ctx && ctx.profile && !ctx.profile.animateCamera ? 200 : 0});
        }
        if (plan.kind === 'polar') presentPolar(report, ctx);
        else {
          if (!pres.pin) placePin(report, {animate: false});
          presentMapCoverage(report, plan, ctx);
          if (pres.pin && globeDirector.view === 'map' && popupFits()) pres.pin.openPopup();
        }
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

  /** Starts the target-lock animation on a pin that has been waiting as a plain reticle. */
  function armPinLock(profile) {
    const element = pres.pin && pres.pin.getElement && pres.pin.getElement(), pin = element && element.querySelector('.trace-pin');
    if (pin) pin.dataset.lock = profile.theatrics ? 'true' : 'done';
  }
  function placePin(report, {animate}) {
    removePin();
    const p = report.location;
    // The pin and the accuracy circle sit exactly on the recorded coordinate. They are never snapped to a road.
    const icon = L.divIcon({className: 'trace-pin-icon', iconSize: [64, 64], iconAnchor: [32, 32], html: '<div class="trace-pin" data-lock="' + (animate ? 'true' : 'wait') + '">' + RETICLE + '</div>'});
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
    globeDirector.hideFrame();
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
    setText('coverageBadge', globeDirector.view === 'map' ? 'OFFLINE MAP' : 'OFFLINE GLOBE');
    setCoverage(idleCoverageNote());
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
    globe.setMarker(null);
    if (globeDirector.view === 'map') globeDirector.showGlobe({fadeMs: effectiveMotion() === 'reduced' ? 180 : 320});
    else globeDirector.relax(effectiveMotion() === 'reduced' ? 0 : 900);       // a descent cancelled by this very choice
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
    globe.setMarker(null);
    globeDirector.showGlobe({fadeMs: 0});
    globe.setCamera({lon: GLOBE_HOME.lon, lat: GLOBE_HOME.lat, alt: GM.IDLE_ALT});
    setText('coverageBadge', 'OFFLINE GLOBE');
    document.body.dataset.presentation = 'idle';
    syncControls();
    announce('Cleared. Waiting for an image.');
  }

  function chooseImage() {
    $('fileInput').value = '';       // so choosing the same file again still fires a change event
    $('fileInput').click();
  }

  function recenter() {
    if (controller.running) return;
    const report = state.report, animate = effectiveMotion() !== 'reduced';
    if (report && report.location && isMappable(director.classify(report.location))) {
      director.recenter(report.location, {animate});
      return;
    }
    // Nothing located: bring the globe back to its home view.
    if (globeDirector.view === 'map') {globeDirector.showGlobe({fadeMs: animate ? 320 : 180}); return;}
    const cam = globe.getCamera();
    globe.markUserActive();
    if (animate) globe.tweenTo({lat: GLOBE_HOME.lat, alt: GM.IDLE_ALT}, 900);
    else globe.setCamera({lat: GLOBE_HOME.lat, alt: GM.IDLE_ALT});
  }

  function syncViewControls(view) {
    const toMap = view === 'globe';       // the globe is showing, so the toggle's job is to go to the street map
    useIcon('viewToggleIcon', toMap ? 'i-streets' : 'i-globe');
    $('viewToggle').setAttribute('aria-label', toMap ? 'Switch to street map' : 'Switch to globe');
    $('viewToggle').title = toMap ? 'Switch to street map' : 'Switch to globe';
    $('map').setAttribute('tabindex', toMap ? '-1' : '0');
    $('map').setAttribute('aria-hidden', String(toMap));
    $('globeCanvas').setAttribute('aria-hidden', String(!toMap));
    $('globeCanvas').setAttribute('tabindex', toMap ? '0' : '-1');
    if (!state.report || !state.report.location) setText('coverageBadge', toMap ? 'OFFLINE GLOBE' : 'OFFLINE MAP');
  }
  function toggleView() {
    if (controller.running) return;
    const reduced = effectiveMotion() === 'reduced';
    if (globeDirector.view === 'globe') globeDirector.showMap({fadeMs: reduced ? 180 : 450});
    else if (reduced) globeDirector.showGlobe({fadeMs: 180});
    else globeDirector.rise({duration: 1.6});
  }
  /** The zoom buttons act on whichever renderer is in view. */
  function zoomBy(factor) {
    globeDirector.interrupt();             // the person took the camera: stops a flight, its sounds and the five-mile frame
    director.cancel('interrupted');
    if (globeDirector.view === 'map') {map[factor < 1 ? 'zoomIn' : 'zoomOut'](); return;}
    const cam = globe.getCamera(), alt = cam.alt * factor;
    globe.markUserActive();
    if (alt < globeUserLimit()) globeDirector.showMap({fadeMs: effectiveMotion() === 'reduced' ? 180 : 450, from: {lon: cam.lon, lat: cam.lat, alt}});
    else globe.tweenTo({alt: Math.min(alt, GM.MAX_ALT)}, 380);
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
    $('recenter').disabled = controller.running;
    $('viewToggle').disabled = controller.running;
    $('mapSkip').hidden = !controller.running;
    document.body.setAttribute('aria-busy', String(busy));
    document.body.dataset.analysis = state.analysis;
    // A focused control that has just been disabled would strand keyboard users: move focus on.
    if (before && (before.disabled || before.hidden)) {
      const next = (before.id === 'mapSkip' ? ['recenter', 'replay', 'analyze', 'changeImage'] : ['replay', 'analyze', 'changeImage']).map($).find(b => !b.disabled);
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
  $('mapSkip').addEventListener('click', skip);
  $('changeImage').addEventListener('click', chooseImage);
  $('replay').addEventListener('click', replay);
  $('cleanView').addEventListener('click', toggleClean);
  $('clear').addEventListener('click', clearAll);
  $('tagSearch').addEventListener('input', () => renderTags({animate: false}));
  $('zoomIn').addEventListener('click', () => zoomBy(1 / 1.6));
  $('zoomOut').addEventListener('click', () => zoomBy(1.6));
  $('recenter').addEventListener('click', recenter);
  $('viewToggle').addEventListener('click', toggleView);
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
          view: globeDirector.view,
          sequence: globeDirector.snapshot(),
          globe: {...globe.getCamera(), zoom: globe.zoom, quality: globe.quality, gridStep: globe.gridStep, frames: globe.stats.frames, lastMs: globe.stats.lastMs, avgMs: globe.stats.avgMs, size: globe.size},
          pin: pres.pin ? {lat: pres.pin.getLatLng().lat, lng: pres.pin.getLatLng().lng, popupOpen: pres.pin.isPopupOpen()} : null,
          accuracy: pres.accuracy ? {lat: pres.accuracy.getLatLng().lat, lng: pres.accuracy.getLatLng().lng, radius: pres.accuracy.getRadius()} : null,
          mapNotice: $('mapNotice').hidden ? null : $('mapNoticeTitle').textContent,
          coverage: $('coverageBadge').textContent,
          stagePhase: stage.phase,
          stageActive: stage.active,
          audio: audio.snapshot(),
          layer: {...baseLayer.stats},
          regions: {...regionManager.snapshot(), packages: regionManager.packages().map(p => ({id: p.id, name: p.name, bounds: p.bounds, minZoom: p.minZoom, maxZoom: p.maxZoom, bytes: p.bytes}))},
          mapData: {persistent: mapPackages.store ? mapPackages.store.persistent : null, restored: mapPackages.restored, open: mapDataDialog.open, listed: mapPackages.list.length, faults: [...mapPackages.faults.values()]}
        };
      }
    })
  });

  /* ------------------------------------------------------------------ map data dialog -- */

  const KEEP_MAX_BYTES = 512 * 1048576;               // larger files are used from where they are, never copied automatically
  const mapPackages = {store: null, list: [], faults: new Map(), opener: null, busy: false, restored: false, keepTouched: false};
  const mapDataDialog = $('mapDataDialog');
  const trim0 = text => text.replace(/\.0+$/, '');
  const formatBytes = n => n >= 1073741824 ? trim0((n / 1073741824).toFixed(2)) + ' GB' : n >= 1048576 ? trim0((n / 1048576).toFixed(1)) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const degrees = (v, pos, neg) => Math.abs(v).toFixed(Math.abs(v) < 1 ? 3 : 2) + '° ' + (v < 0 ? neg : pos);
  const describeBounds = b => degrees(b[1], 'N', 'S') + ' to ' + degrees(b[3], 'N', 'S') + ', ' + degrees(b[0], 'E', 'W') + ' to ' + degrees(b[2], 'E', 'W');

  function mapDataStatus(text, kind) {
    const element = $('mapDataStatus');
    element.textContent = text;
    if (kind) element.dataset.kind = kind; else delete element.dataset.kind;
  }
  function dataItem(name, facts, credit, flags, actions, fault) {
    const li = node('li');
    const title = node('span', 'data-name', name);
    for (const f of flags || []) title.append(node('span', 'data-flag' + (f.ok ? ' is-ok' : ''), f.text));
    li.append(title);
    if (actions) li.append(actions);
    li.append(node('span', 'data-facts', facts));
    if (credit) li.append(node('span', 'data-credit', credit));
    if (fault) li.append(node('span', 'data-fault', fault));
    return li;
  }
  function renderMapData() {
    const bundled = $('mapDataBundled');
    bundled.replaceChildren(dataItem('World outlines and reference cities',
      'Whole world · coastlines and country borders only · 1:110 m',
      'Natural Earth (public domain). Reference cities: IANA time zone database.', [{text: 'Built in', ok: true}]));
    if (hasLocalData) {
      bundled.append(dataItem('Gainesville, Florida streets and buildings',
        describeBounds(mapMeta.bounds) + ' · ' + (mapMeta.features || 0).toLocaleString() + ' features' + (mapMeta.dataDate ? ' · data dated ' + mapMeta.dataDate : ''),
        '© OpenStreetMap contributors, Open Database License.', [{text: 'Built in', ok: true}]));
    }
    const list = $('mapDataList'), loaded = new Map(regionManager.packages().map(p => [p.id, p]));
    list.replaceChildren();
    for (const rec of mapPackages.list) {
      const info = rec.info || {}, live = loaded.get(rec.id), fault = mapPackages.faults.get(rec.id);
      const flags = [{text: rec.persisted ? 'Saved in this browser' : 'This visit only', ok: true}];
      if (info.synthetic) flags.push({text: 'Test pattern, not a real map'});
      const facts = describeBounds(info.bounds || [0, 0, 0, 0]) + ' · zoom ' + info.minZoom + '–' + info.maxZoom + ' · ' + formatBytes(rec.size)
        + (info.tiles ? ' · ' + info.tiles.toLocaleString() + ' tiles' : '');
      const credit = [info.attribution, info.licenseNote].filter(Boolean).join(' · ');
      const remove = node('button', 'btn btn-quiet', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + rec.name);
      remove.addEventListener('click', () => removeMapPackage(rec.id));
      const wrap = node('span', 'data-actions');
      wrap.append(remove);
      list.append(dataItem(rec.name, facts, credit, flags, wrap, fault ? 'Not in use: ' + fault : (live ? '' : 'Not in use.')));
    }
    $('mapDataEmpty').hidden = mapPackages.list.length > 0;
    const store = mapPackages.store, keep = $('mapDataKeep');
    const canKeep = !!(store && store.persistent);
    keep.disabled = !canKeep;
    if (!canKeep) keep.checked = false;
    else if (!mapPackages.keepTouched) keep.checked = true;
    setText('mapDataKeepText', canKeep ? 'Keep a copy in this browser so it is here next time (files up to ' + formatBytes(KEEP_MAX_BYTES) + '; a copy uses that much disk space)'
      : 'Packages last for this visit only: this browser is not offering storage here');
    $('mapDataPick').disabled = mapPackages.busy;
  }
  async function renderStorageLine() {
    const store = mapPackages.store;
    if (!store) {setText('mapDataStorage', ''); return;}
    if (!store.persistent) {setText('mapDataStorage', store.reason); return;}
    const q = await store.quota();
    setText('mapDataStorage', q ? 'Browser storage: ' + formatBytes(q.usage) + ' used, ' + formatBytes(q.free) + ' free.' : '');
  }
  async function refreshPackages() {
    if (mapPackages.store) mapPackages.list = await mapPackages.store.list();
    renderMapData();
  }
  /** After packages change, a result already on screen shows what the data now supports. */
  function refreshCoverage() {
    const report = state.report;
    if (!report) {setCoverage(idleCoverageNote()); return;}
    if (report.status !== 'located' || !report.location || !pres.shown.mapCoverage || globeDirector.running) return;
    if (director.classify(report.location).kind === 'polar') return;
    const c = coverageFor(report.location);
    setText('mapSubtitle', c.subtitle);
    setText('coverageBadge', c.badge);
    setCoverage(c.note, c.action);
    if (c.kind === 'package') verifyPackageCoverage(report, generation);
  }

  async function addMapPackage(file) {
    if (mapPackages.busy) return;
    const store = mapPackages.store;
    if (!store) {mapDataStatus('Map data storage is still starting. Try again in a moment.', 'error'); return;}
    mapPackages.busy = true;
    renderMapData();
    try {
      mapDataStatus('Reading ' + file.name + '…');
      const source = PMTiles.blobSource(file);
      let info;
      try {info = await PMTiles.describe(source);}
      catch (error) {mapDataStatus(file.name + ' was not added. ' + (error && error.message ? error.message : error), 'error'); return;}
      if (info.layers.length && !TileSchema.recognisesLayers(info.layers)) {
        mapDataStatus(file.name + ' was not added. Its layers (' + info.layers.join(', ') + ') are not ones this map draws: roads, buildings, water, places or points of interest.', 'error');
        return;
      }
      const id = PackStore.idFor(file), reader = await PMTiles.open(source);
      const keepWanted = $('mapDataKeep').checked && store.persistent, keep = keepWanted && file.size <= KEEP_MAX_BYTES;
      let note = '';
      try {await store.add({id, name: info.name, info, blob: file, remember: keep});}
      catch (error) {
        await store.add({id, name: info.name, info, blob: file, remember: false});
        note = ' A copy could not be saved (' + (error && error.message ? error.message : error) + '), so it lasts for this visit only.';
      }
      if (keepWanted && !keep) note = ' It is larger than ' + formatBytes(KEEP_MAX_BYTES) + ', so no copy was saved and it lasts for this visit only.';
      if (regionManager.packages().some(p => p.id === id)) regionManager.removePackage(id);
      mapPackages.faults.delete(id);
      regionManager.addPackage({id, name: info.name, reader, info});
      await refreshPackages();
      refreshCoverage();
      mapDataStatus('Added "' + info.name + '", ' + describeBounds(info.bounds) + '.' + (info.synthetic ? ' This is a generated test pattern, not a map of the place it covers.' : '') + note, 'ok');
      announce('Map package added: ' + info.name);
    } catch (error) {
      console.error(error);
      mapDataStatus(file.name + ' was not added. ' + (error && error.message ? error.message : error), 'error');
    } finally {
      mapPackages.busy = false;
      renderMapData();
      renderStorageLine();
    }
  }
  async function removeMapPackage(id) {
    const rec = mapPackages.list.find(r => r.id === id);
    regionManager.removePackage(id);
    mapPackages.faults.delete(id);
    try {await mapPackages.store.remove(id);} catch (error) {console.error(error);}
    await refreshPackages();
    refreshCoverage();
    mapDataStatus('Removed ' + (rec ? '"' + rec.name + '"' : 'the package') + '. Your file on disk was not touched.', 'ok');
    announce('Map package removed');
    renderStorageLine();
  }
  function openMapData(opener) {
    mapPackages.opener = opener || $('mapData');
    mapDataStatus('');
    renderMapData();
    renderStorageLine();
    if (!mapDataDialog.open) mapDataDialog.showModal();
  }
  mapDataDialog.addEventListener('close', () => {
    const opener = mapPackages.opener && mapPackages.opener.isConnected ? mapPackages.opener : $('mapData');
    opener.focus();
  });
  $('mapData').addEventListener('click', () => openMapData($('mapData')));
  $('mapDataClose').addEventListener('click', () => mapDataDialog.close());
  $('mapDataKeep').addEventListener('change', () => {mapPackages.keepTouched = true;});
  $('mapDataPick').addEventListener('click', () => $('mapDataFile').click());
  $('mapDataFile').addEventListener('change', () => {
    const file = $('mapDataFile').files && $('mapDataFile').files[0];
    $('mapDataFile').value = '';
    if (file) addMapPackage(file);
  });

  // Packages saved on an earlier visit come back after the page is up; nothing waits for them.
  (async () => {
    let idb = null;
    try {idb = window.indexedDB || null;} catch (error) {idb = null;}
    mapPackages.store = await PackStore.create({indexedDB: idb, storage: navigator.storage});
    await refreshPackages();
    for (const rec of mapPackages.list) {
      try {
        const reader = await PMTiles.open(PMTiles.blobSource(rec.blob));
        regionManager.addPackage({id: rec.id, name: rec.name, reader, info: rec.info});
      } catch (error) {mapPackages.faults.set(rec.id, error && error.message ? error.message : String(error));}
    }
    mapPackages.restored = true;
    renderMapData();
    if (!state.report && mapPackages.list.length) setCoverage(idleCoverageNote());
  })().catch(error => {mapPackages.restored = true; console.error(error);});

  /* ---------------------------------------------------------------------- start -- */

  loadSettings();
  audio.setEnabled(settings.sound);
  audio.setVolume(settings.volume / 100);
  $('volume').value = String(settings.volume);
  applyMotion();
  syncSoundChip();
  syncViewControls('globe');
  syncControls();
  document.body.dataset.presentation = 'idle';
})();
