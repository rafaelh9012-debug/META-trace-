# META trace — development handoff

Date: 2026-10-21 · Version: 2.2.0-rc.1 (release candidate; tagging is left to the owner) · Target: a free, local Windows/browser application.

## Outcome and next owner

2.0.0 was a working local image-metadata inspector. 2.1.0-rc.1 kept its data boundary exactly as it was and put a dark-red
analysis instrument on top (scan, reveal, settling digits, sounds). **2.2.0-rc.1 upgrades the map side:** the default view is
an interactive 3D globe; a located photo plays one continuous camera path (a full revolution, orientation, a descent, a
hand-off to the flat map) and ends on a square frame exactly five miles by five miles centred on the embedded point;
optional offline map packages (PMTiles) add streets for other places. **The animation only shows a result that already
exists.** It never decides, delays or alters what the analysis found, and only validated embedded GPS ever triggers it.

`metadata-core.js`, `metadata-parser.js`, `metadata-worker.js`, the vendored exifr and Leaflet, the bundled map datasets, both
launchers and `tests/metadata.test.cjs` are byte-identical to 2.0.0. The content-security-policy is byte-identical
(`connect-src 'none'`). Report schema and statuses are unchanged and contain no presentation state.

Read `CHANGELOG.md` for what changed and what was deliberately not done, `docs/MAP_ARCHITECTURE.md` for why the globe and the
package stack are built the way they are, `docs/MAP_DATA.md` for the map data (what is built in, packages, sizes, licences,
how to make one) and `docs/VERIFICATION.md` for exactly what was tested and what was not. Preserve local-only processing, the
dark-red look, no-cost operation, the simple Windows launcher, and the rule that only embedded GPS is ever plotted.

### Repository state

The private repository (`META-trace-`) could not be reached from the working session: the GitHub integration was not
linked. The work was done from `Crimson_Image_Metadata.zip` in a local git repository whose first commit is that ZIP's
content (hash-verified against `BUILD_INFO.json`), tagged locally `baseline-2.0.0-zip`. That tag is not part of your
repository and no tag was created or moved there.

The 2.2.0 work is a series of small commits on top of the 2.1.0-rc.1 history (the first is the plan, `244f98a`; `git log --oneline 523ce23..HEAD` lists them).
Delivered: the complete source tree as a ZIP, the history as a `git format-patch --binary` series (`523ce23..HEAD`), and a
`git bundle` of the whole local history (including the `baseline-2.0.0-zip` tag). To bring it into the repository, either
copy the tree over a checkout whose content matches 2.0.0, apply the series on top of it with `git am`, or fetch from the
bundle (`git fetch META-trace-2.2.0-rc.1.bundle 'refs/heads/*:refs/remotes/bundle/*'`) and push what you want. Nothing was
pushed anywhere and no tag was created or moved in your repository; tagging 2.2.0-rc.1 is yours to do.

## Run and build

1. Extract the archive into a folder and run `START_WINDOWS.bat`.
2. The launcher uses `RUN_CONSOLE.py` when Python is available, otherwise it opens the self-contained HTML directly. The
   Python server binds to loopback, prefers port 8765 and falls back to an available port.
3. `META_trace_Console.html` is the retained legacy entry filename. Its visible title is **META trace**. Open it directly to
   use the app without installing anything.
4. Choose or drop a single image, then press **Analyze**. Input is limited to 64 MiB.
5. Rebuild the HTML with `python3 build_metadata.py`; the build uses only Python's standard library and the bundled map
   data. It also rewrites `BUILD_INFO.json` (parser and HTML hashes). Do not edit the generated HTML; edit the modules and rebuild.

Runtime dependencies are included, with no CDN requests: Leaflet 1.9.4 and exifr 7.1.3. The interface sounds are
synthesised at runtime; there are no audio, font or image assets.

## Architecture and file map

| File | Responsibility |
| --- | --- |
| `metadata-core.js` | **Unchanged.** Format signatures, coordinate validation, hemisphere conversion, conflict detection, bounded flattening, report schema, DMS, coverage checks. No DOM. |
| `metadata-parser.js`, `metadata-worker.js` | **Unchanged.** Pinned exifr adapter, strict parse errors, bounded WebP RIFF traversal, Blob worker. |
| `metadata-app.js` | The application. Holds the **analysis state** and the **presentation state** separately. File selection, drag and drop, generation counter, real log, SHA-256, preview lifecycle, hooks that drive the presentation, tables, pin, Copy, Export, Recenter, settings, diagnostics. |
| `presentation-controller.js` | A state machine with no DOM access. Its timers are injectable (real ones by default), which is how the unit tests run it on a fake clock. It runs the beats in order and supports skip, cancel, replay, waiting for the report, errors and a camera-timeout recovery. |
| `map-director.js` | Camera decisions: what a coordinate can honestly show (street scale / world overview / polar / none), short-way longitude, arrival checking, interruption by manual input, widen, rest, jump, recenter. Pure logic over a Leaflet-shaped map object. |
| `trace-canvas-layer.js` | The offline flat-map layer drawn on one canvas in world-pixel space: grid culling, level of detail, wrapped world copies, label fade continuity, a graticule. Draws the bundled Gainesville streets and, stage by stage across tile edges, the tiles of installed packages. |
| `globe-math.js` | No DOM, no clock. WGS84 ground scale, Vincenty and haversine distances, the five-mile frame bounds (antimeridian and polar aware), the Web Mercator fit from latitude, a north-up perspective camera continuous through the poles, and the cinematic plan whose longitude is unwrapped so the turn is at least 360 degrees. |
| `globe-data.js` | Decodes `data/globe-pack.json` into unit-vector geometry with a bounding cap per ring and polyline chunk; subdivision follows the same Web Mercator line as the flat map, so the two coincide at the hand-off. |
| `globe-view.js` | The Canvas 2D globe: ocean shading, graticule, land with horizon clipping, coast glow, borders, labels with collision, target marker and lock effect, limb darkening. Drag, wheel, pinch, keys, double-click, inertia; draws only when something changed; lowers its own quality (glow, pixel density, labels) when frames run slow. Requests nothing. |
| `globe-director.js` | One camera path on one clock from the whole globe to the five-mile frame: places the globe camera each frame, hands over to Leaflet at about 1 km per pixel through a short cross-fade, carries the descent to the fitted frame, and cancels / jumps / yields to manual input. Near the poles the globe stays the final renderer. |
| `pmtiles-reader.js` | PMTiles v3 by byte range from a Blob (header, root and leaf directories, Hilbert tile ids, gzip). Refuses raster, brotli, zstd, other versions. |
| `mvt-decoder.js`, `tile-schema.js` | Mapbox Vector Tile decoding into typed arrays, then reduction of Protomaps / OpenMapTiles / this repository's own layers to what the layer draws (`mt_kind` extension for converted packages). |
| `region-manager.js` | Which tiles the view needs (one level finer than the map zoom), two reads at a time, an LRU cache bounded in tiles and bytes, whole-level swaps, one package per tile, antimeridian copies, `featuresIn` (is there geometry in the frame?). |
| `pack-store.js` | Where installed packages live between visits: IndexedDB copy (optional, <= 512 MiB, quota-checked) or session-only. |
| `tools/build_globe_pack.py`, `tools/make_pmtiles.py` | Standard-library Python: the globe pack from the Natural Earth and IANA files in the repository; a package from GeoJSON in the app's street format. |
| `scan-stage.js` | The scan canvas over the photo: real sampled bytes and real tag names in the margins, decorative tiles (`aria-hidden`), settle, and fail visuals. |
| `audio-engine.js` | Web Audio synthesis (oscillators and filtered noise), voice registry, `stopAll` / `stopGeneration`, master gain into a compressor, blocked / unsupported contexts as quiet no-ops. |
| `metadata-template.html` / `metadata-styles.css` | Three-zone layout, SVG icon sprite, tokens, responsive rules, focus ring, reduced-motion rules. |
| `map-utils.js` | Zoom-aware label selection with collision suppression. |
| `build_metadata.py` | Inlines everything into one HTML file; writes `BUILD_INFO.json`. |
| `data/`, `vendor/`, `map_builder.py` | Map datasets, pinned libraries, licences, regeneration scripts. `data/globe-pack.json` is new; the rest is unchanged. |
| `tests/` | See `docs/VERIFICATION.md`. `run.cjs` runs everything serially. `helpers/browser.cjs` is the Playwright harness. `fixtures/` are synthetic images; `generate_fixtures.py` makes them (Pillow). |
| `docs/` | `MAP_ARCHITECTURE.md`, `MAP_DATA.md`, `VERIFICATION.md`; `docs/verification/` holds screenshots and timings from the final run. |

## The two states, and why they are separate

* **Analysis state** (`state.analysis`: idle, selected, reading, complete, failed; `state.report`). It is produced by
  `runAnalysis` from the file's bytes and nothing else.
* **Presentation state** (controller: idle, acquire, scan, reveal, resolve, fly, lock, settled, cancelled, error). It is
  told what the analysis found through `session.signal.{acquired, report, fail}` and decides only how and when that is
  shown. The controller never sees coordinates it could change; the hooks in `metadata-app.js` read them from the report.

A **generation counter** is bumped by select, Analyze, Replay, Clear and every cancel. Every asynchronous step (file
read, hash, worker parse, timers, camera moves, scramblers, sound start) checks it before touching the page, so a
result from an abandoned run cannot appear.

Beats (milliseconds):

| Profile | acquire | scan | reveal | resolve | fly | lock | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cinematic | 300 | 900 | 1000 | 600 | 8000 | 700 | 11500 |
| Fast | 140 | 420 | 450 | 260 | 3400 | 400 | 5070 |
| Reduced | 90 | 140 | 220 | 140 | 0 | 200 | 790 |

`fly` is the whole globe sequence (revolution, orientation, descent, hand-off, frame). Fast keeps the full revolution; only
the time is shorter. Reduced has no camera animation and no theatrics. It is the default when the system asks for reduced motion and is
overridden by the person's choice. The acquire beat lasts until the file has actually been read; if the parse is slower
than the scan beat, the presentation holds in `waiting` until the report exists.

Rules the code follows (each has a test):

* The result **text is exact from the first frame it appears.** Coordinate digits may scramble in an `aria-hidden`
  overlay; the real element always holds the real text.
* Skip (`finish`) produces the same final state as a complete run; `dispose(..., 'settled')` must not stop a closing
  cue or camera move that is still ringing out.
* Analysis log result lines are held until the reveal but keep the time at which they really happened.
* The current file name, the outcome and the controls are visible in every state, including Clean view.
* Replay re-presents `state.report`; it never reads or parses again.

## Camera: globe, hand-off and the five-mile frame

* **One clock, one camera.** `GlobeMath.planSequence(...)` returns the whole path: an *unwrapped* longitude that sweeps at least 360
  degrees to the target meridian (never normalised mid-flight, so no easing can take the short way), latitude turning toward the
  target with north up, and altitude falling continuously in log space. The globe draws it while high. At about 1 km per pixel
  (lower at high latitude, so Mercator's stretch stays under about 4 %) Leaflet is placed on the same centre at the same real
  ground scale, the two cross-fade (0.45 s by default) while both are updated every frame, and Leaflet carries the descent to the
  fitted frame. Measured hand-off scale agreement is in `docs/VERIFICATION.md`.
* **The frame is computed, not a zoom constant.** Side 2.5 mi each way (8,046.72 m), from the WGS84 ground scale at the target
  latitude; bounds from the local linearisation, with longitude unwrapped across the antimeridian; the frame in pixels is
  `GM.frameSide(...)`, limited by the room the heading and the coverage note leave (CSS custom properties) with a floor of
  160 px. It is always exactly five miles, only smaller on screen on short panes. The tests measure it from outside the app
  (the DOM rectangle plus the renderer camera, Vincenty on WGS84 in the app, haversine in the test).
* A coordinate whose |latitude| is above 85.05112878 cannot be shown by Web Mercator: the globe stays the final renderer, top
  down and north-up, with the marker and the same frame. Nothing is plotted when there is no valid embedded GPS.
* Longitude is unwrapped to the world copy nearest the camera for the flight and normalised to the true longitude on arrival, so
  flights cross the antimeridian the short way and the pin, camera and readout always agree.
* Arrival on the flat map means "within 1.5 px at the target scale", then the last sub-pixel gap is closed with an exact view
  reset (Leaflet quantises the centre to whole pixels after a manual pan; an exact-equality check would hang).
* Any pointer, wheel, touch, double-click or navigation key on the map or globe, and the zoom buttons, take the camera back at
  once and freeze it where it is. Cancel freezes in place; it does not jump to the target. The scan phase backs the globe off
  first, and a new image eases a close globe back, so every revolution starts from a recognisable globe.
* Idle: the globe turns slowly by itself only when nothing is located, motion is not reduced, the tab is visible and the camera
  is at or above 80 % of its resting height.
* The position-error circle is centred on the original coordinate and the pin is never snapped.
* `map-director.js` still decides what a coordinate can honestly show (street scale / overview / polar / none) over a fake-able
  Leaflet-shaped map; it now takes an injected zoom (the fitted frame) and several coverage boxes.

## Map data (packages)

Described in full in `docs/MAP_DATA.md`. In short: the page ships the world overview and the Gainesville streets. A package is
a `.pmtiles` file the person chooses in the Map data dialog; it is checked first (PMTiles v3, vector tiles, readable
compression, a layer the map draws), then read by byte range, tile by tile, through a bounded cache. The coverage note under
the map names the source of street detail at the located point: an installed package (with its credit), the bundled Gainesville
data, or none (with an **Add map data** action). `featuresIn` makes the "covers this on paper but has no features in the frame"
case explicit. While the globe turns, the tiles of the target's final view are already being read.

`data/samples/protomaps-basemap-firenze.pmtiles` is a real Protomaps basemap (central Florence, 6.6 MB, ODbL) copied unchanged from
the PMTiles repository; it is not inlined in the page. `tile-schema.js` reads Protomaps' `pmap:`-prefixed properties and the layers
real builds use; what is and is not drawn is tabulated in `docs/MAP_DATA.md`. Names come from the file's `name` property.

## Audio (`audio-engine.js`)

Cues: `intake`, `tick`, `scan` (loops until stopped), `resolve`, `descend`, `lock`, `neutral`, `error`, `confirm`, and (2.2) `spin`, which follows a rotation-speed curve supplied by the caller, and `detail`, a soft rising blip per level of detail. All
synthesised, deterministic noise, short envelopes, master gain (volume curve v^1.6) into a compressor. The analysis never
waits for audio: `unlock()` is called from the Analyze gesture and its promise is not awaited; a cue requested before the
context runs starts when it does, unless its generation went stale first. A context that is blocked, missing or throws
turns every cue into a no-op; the Sound control shows on / off / blocked / unavailable and one retry turns sound off.
Voices fade out over about 40 ms and leave the registry when the fade ends.

## Settings and diagnostics

Preferences (`sound`, `volume`, `motion`) are kept in `localStorage` under `metatrace.settings.v1`, every access in
try/catch; the app works without storage. `window.MetaTrace.snapshot()` returns a read-only copy of the generation,
analysis and presentation state, camera, pin, accuracy circle, notice, coverage, audio and layer statistics. It exists for
the tests and for support; it cannot change anything.

## Actual analysis flow

Unchanged in substance from 2.0.0. Choosing a file increments the generation, cancels earlier work, clears the earlier
result, checks size, emptiness and the first 512 bytes' signature, then shows the preview and waits. **Analyze** reads the
bytes, checks the signature, calculates SHA-256 with Web Crypto where available, and parses in a Blob worker with a
12-second limit (a main-thread fallback exists and cannot be pre-empted). Parser options enable TIFF/EXIF/GPS, XMP, IPTC,
JFIF and PNG IHDR; ICC, MakerNote and UserComment are off. Values and dates are not revived, to avoid inventing time zones.

GPS normalisation validates finite numeric/rational values, DMS ranges, limits and hemisphere references. Zero is a valid
value. Missing hemisphere references for raw EXIF DMS are not guessed. Distinct embedded pairs produce a conflict and no
selected marker. Altitude is signed only when its reference is understood. Only a valid `GPSHPositioningError` makes an
error circle; DOP is not treated as metres.

## Result contract

`metadata-core.js` exposes `describe(raw, file, format, sha256)`:

```json
{
  "schemaVersion": 1,
  "analyzedAt": "ISO timestamp of analysis",
  "file": {"name": "selected filename", "sizeBytes": 1234, "type": "jpeg", "lastModified": "time or null", "sha256": "real digest or null"},
  "status": "located | no_location | incomplete_location | invalid_location | conflicting_location",
  "location": {"latitude": 0, "longitude": 0, "altitude": null, "accuracyMeters": null, "source": "gps"},
  "issues": [],
  "metadata": [{"tag": "group.TagName", "value": "readable value"}],
  "summary": {"make": null, "model": null, "recordedTime": null}
}
```

`location` is `null` for every non-located status; conflict reports also carry `candidates`. Unsupported formats,
oversized or empty files and parse failures are separate states and are never reported as "no GPS". Display and export
are bounded to 500 entries, depth 8 and 4,096 characters per string. Export happens only when the person presses
Export report; a failed read has nothing to export. The report never contains presentation state.

## Map behaviour

A new session opens the 3D globe with no marker. GPS inside an installed package's area (or the bundled Gainesville bounds) ends
on the five-mile frame over street detail. Any other valid non-polar point ends on the same frame over the world overview with
a plain statement that detailed streets are not included there and an Add map data action. Beyond +-85.05112878 degrees the
numbers are shown and the globe keeps the marker and frame. An image without valid GPS cannot leave the previous pin behind.
Embedded GPS can be edited and is not proof of a photograph's origin; nothing is inferred about people, residences or scene
content.

## Validation

See `docs/VERIFICATION.md` for what each suite covers, the measurements, and the full runs it took to get a clean one
(the failures are listed there with their causes). In short: `node tests/run.cjs all` on commit `010c370` passed 366 of 366
with none skipped, in 1,079 s, using the real built page in headless Chromium 141 with software rendering (this includes the
unchanged 25 baseline tests and the 6 tests that read a real Protomaps basemap). A fresh clone of that commit rebuilt a
byte-identical page (`python3 build_metadata.py`, SHA-256 `d8432469…6215`) and passed the unit suite (201 of 201) there; the
browser suites were last run from a fresh clone at 349 tests, on `851adbc` (349 of 349, 1,049 s). It has **not** been run on Windows, Edge, Firefox, Safari, a GPU or a headed
browser, and the sounds have been **measured, not heard**.

```bash
node tests/run.cjs unit      # no browser, nothing to install
npm install && npx playwright install chromium
node tests/run.cjs           # everything, serially (about eighteen minutes)
```

## Known limits and prioritised next work

1. **Listen to it, and run it on real machines.** Sound, frame pacing, a real GPU and the Windows launcher are what automation
   here could not stand in for. Try Cinematic and Fast on the machines it will really be used on (the globe is Canvas 2D, so it
   needs no WebGL, but a weak machine may drop frames: the globe lowers its own quality when its drawing exceeds 16 ms, and
   that path was not exercised by a browser test because the six-fold CPU slowdown never pushed it past that). The Motion
   control and `Reduced` are there if something is too much.
2. **Try more real regional packages.** Cut one with the Protomaps `pmtiles extract` command (`docs/MAP_DATA.md`; it was not
   run here), add it in Map data and look at the roads, buildings, water and names. **One** real package has been read: the
   Protomaps basemap sample for central Florence from the PMTiles repository, kept in `data/samples/` and read by
   `tests/real-protomaps.test.cjs`. Reading it found that real tiles prefix Protomaps' properties with `pmap:`, which was fixed
   (the adapter had drawn 41.7 % of its features; it draws 85.8 % now: roads, rail, rivers, parks, places, streets, landmarks,
   businesses). Another build version, another region, an OpenMapTiles archive, a tile with leaf directories or names in a
   non-Latin script have not been seen. If something draws wrongly, `tile-schema.js` is the one file that maps layers and
   properties to drawing kinds, and `tests/tile-schema.test.cjs` and `tests/real-protomaps.test.cjs` show how to add a case.
   There is still no worldwide street data in the app: outside Gainesville the person chooses a package, and the Florence
   sample covers about 5.3 km by 4.9 km.
3. **A richer world.** The globe draws Natural Earth 1:110 m coastlines and borders and 418 reference cities. Rivers, lakes,
   regional boundaries and transport need files that could not be obtained here. `tools/build_globe_pack.py` has options for
   them (not run, not tested); `--max-inline-mb` sends anything big to a `.pmtiles` package instead.
4. **Package features not built:** merging overlapping packages (one owns each tile), a package whose box crosses the
   antimeridian (split it in two), brotli and zstd tiles (the browser has no offline decompressor), MapLibre Tile (type 6) and raster tiles, terrain, and
   any download inside the app (the policy forbids it; the person obtains the file and chooses it).
5. **HEIC/AVIF.** Unchanged and still best effort; the pinned exifr has a known HEIF recognition guard that can reject
   longer `ftyp` boxes from some newer phones. Build consented or synthetic fixtures and fix the container layer. Do not
   call a parse error "no GPS".
6. **Street photography.** Not added. If ever wanted it must be a separate opt-in provider with its own consent and its own
   narrowly-scoped network permission; the default stays offline with `connect-src 'none'`.
7. **Lockfile.** `package.json` pins Playwright 1.56.1 but there is no `package-lock.json` (the registry could not be
   reached where this was built). Run `npm install` once and commit the lockfile.
8. **Parser hardening, report completeness, further formats.** As in 2.0.0: fuzz malformed TIFF/RIFF input, add an explicit
   truncation flag to reports, consider a required worker instead of the non-pre-emptible fallback.
9. **Other browsers.** The test harness (`tests/helpers/browser.cjs`, `getBrowser()`) launches Chromium only. Running the
   suites on Firefox and WebKit means changing that one function; some timing tolerances may then need review. The hand-off
   uses Leaflet 1.9.4's private `_move*` methods, so a Leaflet upgrade needs it re-checked.
10. **Small known behaviours.** Resizing the window during a flight refits the frame when the flight ends; on short panes the
   frame is smaller on screen (never below 160 px) but still five miles; a package's names are placed by the layer's collision
   rules, so a long road can be named in more than one tile. A package's credit is shown in the coverage note under the map
   and in the Map data dialog; Leaflet's attribution line lists only the bundled sources.

## Maintenance checklist

1. Review HANDOFF.md, CHANGELOG.md, docs/MAP_ARCHITECTURE.md, docs/MAP_DATA.md,
   docs/VERIFICATION.md, README.txt, and BUILD_INFO.json before making changes.
2. Run `node tests/run.cjs unit` and, with Playwright installed, `node tests/run.cjs`.
3. Protect the metadata parsing boundary (`metadata-core.js`, `metadata-parser.js`, the worker,
   bundled libraries and map data) and the Content Security Policy. Change them only to meet a
   documented requirement supported by tests.
4. Preserve local-only processing, the dark-red design, offline operation, the Windows launcher,
   and exact embedded-GPS-only mapping. Do not fabricate coordinates, accuracy, geography, or
   analysis results. Keep analysis and presentation state independent and validate each asynchronous step.
5. Keep missing, invalid, conflicting, incomplete, unsupported and unreadable metadata cases distinct.
   Start the globe animation only with validated embedded coordinates.
6. Rebuild with `python3 build_metadata.py` after modifications; update relevant tests and documentation.
   Record which checks were actually run and their results. Do not introduce a paid service or required key.

## Primary references

- exifr documentation and source: <https://github.com/MikeKovarik/exifr> — pinned 7.1.3, MIT licence in `vendor/EXIFR_LICENSE.txt`.
- HEIF recognition discussion: <https://github.com/MikeKovarik/exifr/issues/138>.
- Leaflet: <https://leafletjs.com/> — bundled BSD-2-Clause licence.
- Natural Earth world data and terms: <https://www.naturalearthdata.com/about/terms-of-use/>.
- OpenStreetMap data and licence: <https://www.openstreetmap.org/copyright>.
- PMTiles v3 specification: <https://github.com/protomaps/PMTiles/blob/master/spec/v3/spec.md>; Protomaps documentation: <https://docs.protomaps.com/> (basemap layers, planet downloads, the `pmtiles` CLI), read 2026-10-21.
- Mapbox Vector Tile specification 2.1: <https://github.com/mapbox/vector-tile-spec>.
- Playwright (development only): <https://playwright.dev/> — Apache-2.0.
