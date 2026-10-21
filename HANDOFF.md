# META trace — development handoff

Date: 2026-10-21 · Version: 2.1.0-rc.1 (release candidate; tagging is left to the owner) · Target: a free, local Windows/browser application.

## Outcome and next owner

2.0.0 was a working local image-metadata inspector. 2.1.0-rc.1 keeps its data boundary exactly as it was and puts a
dark-red analysis instrument on top: image acquisition, a scan sweep, a reveal of real metadata, coordinate digits that
settle, a smooth map descent, a pin lock, and short original sounds. **The animation only shows a result that already
exists.** It never decides, delays or alters what the analysis found.

`metadata-core.js`, `metadata-parser.js`, `metadata-worker.js`, the vendored exifr and Leaflet, the map data, both
launchers and `tests/metadata.test.cjs` are byte-identical to 2.0.0. The content-security-policy is byte-identical
(`connect-src 'none'`). Report schema and statuses are unchanged and contain no presentation state.

Read `CHANGELOG.md` for what changed and what was deliberately not done, and `docs/VERIFICATION.md` for exactly what was
tested and what was not. Preserve local-only processing, the dark-red look, no-cost operation, the simple Windows
launcher, and the rule that only embedded GPS is ever plotted.

### Repository state

The private repository (`META-trace-`) could not be reached from the working session: the GitHub integration was not
linked. The work was done from `Crimson_Image_Metadata.zip` in a local git repository whose first commit is that ZIP's
content (hash-verified against `BUILD_INFO.json`), tagged locally `baseline-2.0.0-zip`. That tag is not part of your
repository and no tag was created or moved there.

Delivered: the complete source tree as a ZIP, and the history as a `git format-patch` series. To bring it into the
repository either copy the tree over a checkout whose content matches 2.0.0, or apply the series on top of it with
`git am`. Nothing was pushed anywhere.

## Run and build

1. Extract the archive into a folder and run `START_WINDOWS.bat`.
2. The launcher uses `RUN_CONSOLE.py` when Python is available, otherwise it opens the self-contained HTML directly. The
   Python server binds to loopback, prefers port 8765 and falls back to an available port.
3. `Qwen_Map_Console.html` is the retained legacy entry filename. Its visible title is **META trace**. Open it directly to
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
| `trace-canvas-layer.js` | The offline base map drawn on one canvas in world-pixel space, with grid culling, level of detail, wrapped world copies, label fade continuity and a graticule. Replaces per-feature vector layers. |
| `scan-stage.js` | The scan canvas over the photo: real sampled bytes and real tag names in the margins, decorative tiles (`aria-hidden`), settle, and fail visuals. |
| `audio-engine.js` | Web Audio synthesis (oscillators and filtered noise), voice registry, `stopAll` / `stopGeneration`, master gain into a compressor, blocked / unsupported contexts as quiet no-ops. |
| `metadata-template.html` / `metadata-styles.css` | Three-zone layout, SVG icon sprite, tokens, responsive rules, focus ring, reduced-motion rules. |
| `map-utils.js` | Zoom-aware label selection with collision suppression. |
| `build_metadata.py` | Inlines everything into one HTML file; writes `BUILD_INFO.json`. |
| `data/`, `vendor/`, `map_builder.py` | Unchanged map datasets, pinned libraries, licences, regeneration script. |
| `tests/` | See `docs/VERIFICATION.md`. `run.cjs` runs everything serially. `helpers/browser.cjs` is the Playwright harness. `fixtures/` are synthetic images; `generate_fixtures.py` makes them (Pillow). |
| `docs/verification/` | Screenshots and frame timing from the final test run. |

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
| Cinematic | 300 | 900 | 1000 | 600 | 2900 | 500 | 6200 |
| Fast | 140 | 420 | 450 | 260 | 1300 | 260 | 2830 |
| Reduced | 90 | 140 | 220 | 140 | 0 | 200 | 790 |

Reduced has no camera animation and no theatrics. It is the default when the system asks for reduced motion and is
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

## Camera rules (`map-director.js`)

* A coordinate inside the bundled bounds (lon −82.351..−82.324, lat 29.638..29.659) ends at zoom 18. Any other valid
  non-polar coordinate ends at zoom 5 on the world overview with the coverage note. With no street data at all (bounds
  `null`) nothing is regional. |lat| above 85.05112878 is "polar": numbers stay on screen, no flight, no pin, a notice.
* Longitude is unwrapped to the world copy nearest the camera for the flight path, and normalised to the true longitude on
  arrival, so flights cross the antimeridian the short way and the pin, camera and readout always agree.
* Arrival means "within 1.5 px at the target zoom", then the last sub-pixel gap is closed with an exact view reset.
  (Leaflet quantises the centre to whole pixels after a manual pan; an exact-equality check would hang.)
* Any pointer, wheel, touch, double-click or navigation key on the map, and the zoom buttons, take the camera back at once
  and freeze it where it is. Cancel freezes in place; it does not jump to the target.
* When nothing is plotted the camera comes to rest on the wide view (`rest()`), never mid-zoom and never left on an
  earlier street view.
* The position-error circle is centred on the original coordinate and the pin is never snapped.

## Audio (`audio-engine.js`)

Cues: `intake`, `tick`, `scan` (loops until stopped), `resolve`, `descend`, `lock`, `neutral`, `error`, `confirm`. All
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

A new session opens a neutral world overview with no marker. GPS in the bundled Gainesville bounds gets the detailed
street map and a street-scale finish. Any other valid non-polar point gets its exact marker on the overview and a plain
statement that detailed streets are not included there. Beyond ±85.05112878° the numbers are shown and no marker is
drawn. An image without valid GPS cannot leave the previous pin behind. Embedded GPS can be edited and is not proof of a
photograph's origin; nothing is inferred about people, residences or scene content.

## Validation

See `docs/VERIFICATION.md`. In short: the final serial run was 173 of 173 passing, none skipped, using the real built
page in headless Chromium 141, plus the unchanged 25 baseline tests. It has **not** been run on Windows, Edge, Firefox,
Safari, a GPU or a headed browser, and the sounds have been **measured, not heard**.

```bash
node tests/run.cjs unit      # no browser, nothing to install
npm install && npx playwright install chromium
node tests/run.cjs           # everything, serially (about six minutes)
```

## Known limits and prioritised next work

1. **Listen to it, and run it on real machines.** Sound, frame pacing and the Windows launcher are the three things
   automation here could not stand in for. Try Cinematic and Fast on the machines it will really be used on; the Motion
   control and `Reduced` are there if something is too much.
2. **"Install a region".** The brief allowed a way to add offline street data for other places; it was not built.
   Outside Gainesville the person gets the exact point on the world overview and an honest explanation. A region bundle
   would need validated bounds, attribution and licence handling, and must not fetch anything. `map-director.js` takes
   its bounds as data, but the app and the base layer currently load a single regional dataset, so several regions need
   work in both.
3. **HEIC/AVIF.** Unchanged and still best effort; the pinned exifr has a known HEIF recognition guard that can reject
   longer `ftyp` boxes from some newer phones. Build consented or synthetic fixtures and fix the container layer. Do not
   call a parse error "no GPS".
4. **Street photography.** Not added. If ever wanted it must be a separate opt-in provider with its own consent and its own
   narrowly-scoped network permission; the default stays offline with `connect-src 'none'`.
5. **Lockfile.** `package.json` pins Playwright 1.56.1 but there is no `package-lock.json` (the registry could not be
   reached where this was built). Run `npm install` once and commit the lockfile.
6. **Parser hardening, report completeness, further formats.** As in 2.0.0: fuzz malformed TIFF/RIFF input, add an explicit
   truncation flag to reports, consider a required worker instead of the non-pre-emptible fallback.
7. **Other browsers.** The test harness (`tests/helpers/browser.cjs`, `getBrowser()`) launches Chromium only. Running the
   suites on Firefox and WebKit means changing that one function; some timing tolerances may then need review.

## Continuation prompt for the larger model

> Open the supplied META trace source and read HANDOFF.md, CHANGELOG.md, docs/VERIFICATION.md, README and BUILD_INFO
> first, then run `node tests/run.cjs unit` and, with Playwright installed, `node tests/run.cjs`. The metadata data
> boundary (`metadata-core.js`, `metadata-parser.js`, the worker, vendored libraries, map data) and the CSP are
> frozen: do not change them without a failing test that demands it. Preserve local-only processing, the dark-red look,
> no-cost operation, the simple Windows launcher and exact embedded-GPS-only mapping. Never invent coordinates, accuracy,
> analysis steps or a location. Keep the analysis state and the presentation state separate and keep the generation
> check on every asynchronous step. Keep metadata absence, invalid / conflicting / partial GPS, unsupported format and
> parse errors distinct. Rebuild with `python3 build_metadata.py` and update the tests, README, this handoff and the
> changelog after each completed change. Report only what was actually run, and say plainly what was not. Do not add a
> paid service, a required key or an LLM to read EXIF tags.

## Primary references

- exifr documentation and source: <https://github.com/MikeKovarik/exifr> — pinned 7.1.3, MIT licence in `vendor/EXIFR_LICENSE.txt`.
- HEIF recognition discussion: <https://github.com/MikeKovarik/exifr/issues/138>.
- Leaflet: <https://leafletjs.com/> — bundled BSD-2-Clause licence.
- Natural Earth world data and terms: <https://www.naturalearthdata.com/about/terms-of-use/>.
- OpenStreetMap data and licence: <https://www.openstreetmap.org/copyright>.
- Playwright (development only): <https://playwright.dev/> — Apache-2.0.
