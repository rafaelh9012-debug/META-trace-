# Verification report — META trace 2.2.0-rc.1

This says what was actually run, what it showed, and what was not checked. Nothing here is a claim about a machine
other than the one described. Every number below is from the final recorded run unless it says otherwise.

## Environment

| | |
| --- | --- |
| Machine | Linux 6.18 container, no display, no audio output device, no GPU |
| Browser | Chromium 141.0.7390.37 (Playwright 1.56.1), headless, software rasterisation |
| Node / Python | Node 22.22.0, Python 3.13 |
| Page under test | the built single file `META_trace_Console.html` (4,723,697 bytes), opened from `file://` (and once over `http://127.0.0.1` through the real `RUN_CONSOLE.py`) |
| Not available | Windows, Edge, Firefox, Safari, a GPU, speakers, a headed browser, the GitHub repository (see HANDOFF.md), any network |

Playwright and Chromium are development tools only. The app has no runtime dependency.

## Result

`node tests/run.cjs all` with `META_TRACE_ARTIFACTS` set, on commit `010c370`, finished with **366 tests, 366 passed, 0 failed,
0 skipped, in 1,079 s**. The screenshots and measurements recorded for the real Protomaps file
(`docs/verification/real-florence-*.png`, `regions-real-florence.json`) come from that run. The other screenshots and
measurements in this report and in `docs/verification/` were recorded on the earlier run on `851adbc` (below) and were not
re-recorded. What changed since then is how package tiles are read and how names are placed and checked for overlap (and the
sample, the tests and the docs); the camera, the globe, the sound and the analysis are untouched, and every test that asserts on
the changed parts passed in the new run. The commits after `010c370` change documentation and recorded
artifacts only (`git diff 010c370 HEAD --stat` shows it).

Reading the real Protomaps file added 17 tests to the 349 that existed before it: 6 in the new `real-protomaps.test.cjs`,
7 in `tile-schema.test.cjs`, 2 in `pmtiles-reader.test.cjs` (the credit as text; MapLibre Tile packages named and refused) and 2
browser scenarios in `regions.browser.test.cjs`. A fresh clone of `010c370` rebuilt a byte-identical page (SHA-256
`d8432469…6215`) and the unit suite passed 201 of 201 there in 17 s; the browser suites were not re-run from the clone. (For the
349-test state, `851adbc`, a fresh clone had passed all 349 in 1,049 s.)

Five full runs were needed to get a clean 349 of 349, and the earlier ones are part of the record:

| Run | Commit | Result | What it found |
| --- | --- | --- | --- |
| 1 | `35a6739` | 349 / 349 | Nothing failed. An earlier run on the same code had failed two assertions that still expected the words "regional map package", which the coverage note no longer says (it offers an **Add map data** button); they were updated to check the button. |
| 2 | `4522511` | 347 / 349 | A **real layout defect**: at 390 px the coverage note, narrowed to clear the scale bar, grew tall enough to cover the lower-left corner of the five-mile frame at 85 N. And a **test timing race**: the add/remove-package scenario compared line counts while label selection (throttled to 250 ms) was still catching up (989 against 918). |
| 3 | `ea06cab` | 349 / 349 | Passed. Reading its phone screenshots showed one more defect the tests did not look for: the globe's altitude readout ran underneath the row of map buttons. |
| 4 | `16e7987` | 348 / 349 | One audio check required two identical offline renders to match bit for bit; they differed by 6e-10 in a checksum (one float32 step in a tail near -142 dBFS). The noise source is seeded, so this is the browser's audio arithmetic. The check now allows 1e-6, and was shown to fail when the noise source is replaced by `Math.random`. |
| 5 | `851adbc` | 349 / 349 | The last run before the real Protomaps file was added. |
| 6 | `634cca4` | stopped | Stopped before it finished, to include one more small change (naming MapLibre Tile packages); no result is claimed. |
| 7 | `7c6e6eb` | 365 / 365 | The 349, plus 16 tests that read the real Protomaps file. Nothing failed. Reading its screenshots then showed a defect that no test looked for: a long business name was drawn in full but checked for overlap as at most 190 px wide, so it ran under its neighbour ("Biblioteca dell'Opera di Santa Maria del Fiore di Fir" under "Rentway"). The estimate was raised and a test added. |
| 8 | `010c370` | 366 / 366 | The run reported here. Nothing failed. (The real-file defects listed below were found by running the new tests on their own while they were written, not by a full run.) |

| File | Tests | What it covers |
| --- | ---: | --- |
| `metadata.test.cjs` | 25 | The baseline suite: parser, coordinate validation, statuses, worker, built-HTML checks. Unchanged from 2.0.0. |
| `presentation.test.cjs` | 18 | The presentation state machine on a fake clock: order, skip, cancel, replay, waiting for the report, errors, disposal. |
| `map-director.test.cjs` | 16 | Camera decisions against a fake map: classification, short-way longitude, arrival, interruption, rest, jump, recenter. |
| `globe-math.test.cjs` | 26 | Geodesy (WGS84 scale, Vincenty against haversine), the five-mile frame bounds, the Web Mercator fit, the north-up camera through the poles, the unwrapped sequence plan (never less than a full turn, no step of 180 degrees or more), easing. |
| `globe-data.test.cjs` | 13 | The globe pack decoded to unit vectors; bounding caps; subdivision follows the same Mercator line as the flat map. |
| `globe-director.test.cjs` | 20 | The camera path with fake renderers on a manual clock: the full turn, hand-off, frame distances, antimeridian, polar, replacement, interruption, resize refit, backing the globe off and easing it back. |
| `pmtiles-reader.test.cjs` | 18 | PMTiles v3 header, directories, Hilbert ids (against the specification's published values), byte-range reads, refusals with reasons. |
| `mvt-decoder.test.cjs` | 13 | Vector tiles from bytes written by hand to the specification; every truncation and 4,000 random corruptions raise only a named error. |
| `tile-schema.test.cjs` | 19 | Protomaps / OpenMapTiles / this repository's own layers reduced to what the layer draws; the `pmap:` property prefix, rivers, rail, name ranking, the width a long name is given; coordinates against the layer's Web Mercator; tile-seam outline trimming. |
| `real-protomaps.test.cjs` | 6 | A real Protomaps basemap archive (central Florence, from the PMTiles repository): see below. |
| `region-manager.test.cjs` | 14 | Which tiles a view needs, the bounded cache, whole-level swaps, overlapping packages, antimeridian copies, failure and retry, `featuresIn`. |
| `pack-store.test.cjs` | 10 | The package store: browser storage and the session-only fallback, quota, replacing, removing. |
| `make-pmtiles.test.cjs` | 3 | The Python converter, read back by the independent JavaScript reader, decoder and adapter. |
| `audio.browser.test.cjs` | 28 | Every cue (including the new `spin` and `detail`) rendered offline in Chromium and measured; stop behaviour; muted, blocked, missing and throwing audio. |
| `layer.browser.test.cjs` | 7 | The canvas street layer against Leaflet's own projection and drawing, and (new) solid building fills across grid cells, overlaps and courtyards. |
| `globe.browser.test.cjs` | 25 | The globe and camera in the real page: see below. |
| `regions.browser.test.cjs` | 20 | Installed map packages in the real page: see below. |
| `browser.test.cjs` | 36 | Whole flows in the real built page, moved to the five-mile-frame contract. |
| `browser-cancel.test.cjs` | 13 | New file, Clear, Skip, Replay at awkward moments; slow reads; a rapid-fire stress run. |
| `browser-env.test.cjs` | 24 | Sound states, reduced motion, offline, CSP, missing street data, hidden tab, layouts, touch targets. |
| `contrast.test.cjs` | 11 | WCAG ratios from the tokens and from every visible text element in seven live states. |
| `launcher.browser.test.cjs` | 1 | The real Python launcher serving the page to a real browser. |

### What the globe suite (`globe.browser.test.cjs`) establishes

- **The idle globe** is a real 3D globe in dark space, red and legible: 60.5 % of the canvas is space and 39.5 % is the sphere,
  no pixel is near white (no bloom), the lit parts are red (mean 124, 48, 75), the four corners are dark, and it turns west by
  itself (the test checks the turn is between 1.5 and 9 degrees in about 1.2 s; the designed rate is 3.2 degrees a second). Drag,
  wheel, double-click, `+`, arrow keys and Recenter all act on it. The canvas is `role="application"` with a label that says how to
  use it.
- **The revolution is measured, not assumed.** The per-frame camera trace of the full sequence for Gainesville swept 406.2
  degrees of longitude (one revolution plus the 46.2 remaining to the target meridian), matching the plan to within 4 degrees,
  without ever turning back (largest eastward step under 0.3 degrees) and never by more than 14 degrees in a frame (the plan
  peaks near 3.3). The full turn was complete while the whole globe was still in view (camera height above 6,000 km). The
  phases run in order spin, orient, descend; the height never rises during the descent and never drops by more than 15 % in one
  frame; the latitude never overshoots or retreats from the target; the view is within 50 m of the target at the end of the
  globe's descent.
- **The hand-off agrees.** When the flat map takes over, the globe's ground scale was 1,046 m per pixel and Leaflet's was 995 m
  per pixel (ratio 0.951; the test requires 0.9 to 1.1, "within one frame of descent"), the centres agree to within 0.01 degrees
  (measured 0 and 0), and the view hands over once and never flickers back.
- **The sounds ride the sequence.** At least 80 % of the revolution frames and of the descent frames have a sound playing,
  and every voice has ended shortly after the sequence.
- **Fourteen places end centred in a five-mile frame** (table below), including both hemispheres, the equator, 69.6 N, 78.2 N,
  77.8 S, either side of the antimeridian, 85 N and both poles, measured from outside the app (the frame's DOM rectangle plus
  the renderer's camera, Vincenty on WGS84; the test uses haversine).
- **Interruptions.** Skip, Clear and a replacement image during the revolution and during the descent each leave one clean final
  state or none, no marker from the old target, and silence every sound; the next run starts again from the whole globe with a
  full revolution. A drag, the wheel, an arrow key or the zoom button takes the camera at once, the result is still reported and
  Recenter returns to the frame. Replay repeats the whole sequence.
- **Reduced motion** plans no sweep and ends in the same frame. **A muted run** moves the camera exactly as a sounding one and
  creates no audio node.
- **Limited graphics.** With the processor slowed six-fold (Chromium's CPU throttling) the fast sequence kept its clock,
  turned once (406.6 degrees) and ended in the same frame: wall time 7,208 ms for a 5.07 s plan (this includes the slowed read and
  parse), 40 frames at a median 66.7 ms and worst 216.6 ms. The globe's own quality control stayed at its top level the whole
  time (its drawing averaged 5.6 ms, below the 16 ms at which it steps down), so this measures frame pacing under a
  slow processor, not the lower-quality path.
- **Offline.** With every outside request refused, the globe, the whole sequence and the final frame come from bundled data.
- **Four layouts** (1440 x 900, 1024 x 768, 768 x 1024, 390 x 844): the globe fills its panel, the frame is square and visible,
  and no panel covers the marker.

| Place | Renderer | Width (mi) | Height (mi) | Mean | Point off the centre |
| --- | --- | ---: | ---: | ---: | ---: |
| Gainesville, Florida | map | 5.0127 | 4.9873 | 5.0000 | 0 m |
| Sydney (S, E) | map | 5.0116 | 4.9884 | 5.0000 | 0 m |
| Quito, near the equator (S, W) | map | 5.0168 | 4.9832 | 5.0000 | 0 m |
| 0, 0 | map | 5.0168 | 4.9832 | 5.0000 | 0 m |
| Qinghai-Tibet plateau | map | 5.0115 | 4.9885 | 5.0000 | 0 m |
| Paris (outside the street data) | map | 5.0073 | 4.9927 | 5.0000 | 0 m |
| Tromsø, 69.6 N | map | 5.0020 | 4.9980 | 5.0000 | 0 m |
| Longyearbyen, 78.2 N | map | 5.0007 | 4.9993 | 5.0000 | 0 m |
| McMurdo, 77.8 S | map | 5.0007 | 4.9993 | 5.0000 | 0 m |
| just east of the antimeridian (17.75 S) | map | 5.0152 | 4.9848 | 5.0000 | 0 m |
| just west of the antimeridian (17.75 S) | map | 5.0152 | 4.9848 | 5.0000 | 0 m |
| 85 N, the Web Mercator limit | globe | 5.0005 | 5.0003 | 5.0004 | 3.7 m |
| 89.5 N | globe | 5.0004 | 5.0004 | 5.0004 | 3.7 m |
| 89.5 S | globe | 5.0004 | 5.0004 | 5.0004 | 3.7 m |

The frame is square on screen, and Web Mercator is not equal-scale east-west and north-south on the ellipsoid, so the two
sides differ from 5 miles by up to 0.34 % (at the equator) in opposite directions and their mean is 5 miles. The test allows
0.6 %. The frame is 446 px on a 1440 x 900 window; on short panes it is smaller on screen (never below 160 px) and still five
miles.

### What the package suite (`regions.browser.test.cjs`) establishes

- The Map data dialog lists what is built in, works from the keyboard, and the page policy is unchanged (byte-equal CSP). It
  fits at four window sizes.
- Files that are not usable packages are refused with a reason and nothing is added.
- A package added while a result is on screen draws its streets, its names appear (`layer.regionLabels > 0`), the coverage
  note names it, and **Remove** takes all of that away.
- With a package installed the choreography is unchanged and its tiles are already in before the map takes over (4 tiles
  ready at the hand-off in the recorded scenario).
- A package that covers the point only on paper says nothing is drawn there; outside every package the note says so, offers
  the dialog, and focus returns to the control. A bundled-data place gives way to a package that is detailed enough and not
  to a coarse one.
- Synthetic packages laid over both hemispheres, the equator and either side of the antimeridian give centred five-mile frames
  with the package drawn (Sydney 5.0116 x 4.9884 mi, Quito 5.0168 x 4.9832, Gainesville 5.0127 x 4.9873, and 5.0152 x 4.9848 on
  each side of the antimeridian).
- A kept copy survives a reload, a visit-only package does not, and Remove forgets both; without browser storage packages
  work for the visit only and the dialog says so.
- **Cache and memory** (a scripted tour of 520 views at zoom 15 across a synthetic 2,854,848-byte package of 3,553 tiles and
  275,984 features): 593 tile reads, 409 evictions, 199 tiles left in the cache (2.09 MB of decoded geometry); 2.51 MB of the
  2.85 MB file was read in total and never more than a few tiles at once; decoding took 87 ms and adapting 63 ms in total, the
  slowest tile 55 ms from request to ready; drawing the package took 0.12 ms on average per redraw (1.3 ms at most); the JS heap
  was 66.1 MB before the tour and 55.0 MB after it (garbage collection ran), so it did not grow.
- Damaged tiles are counted and skipped, the readable ones draw and the sequence completes. Skip, Clear and a replacement
  during the revolution and the descent leave nothing half-loaded.
- **The same data, two renderers.** The bundled Gainesville data, converted to a package (597,138 bytes, 80 tiles, 12,671
  features), draws the same picture as the bundled renderer, geometry only (label selection is switched off in that page):

  | View | Pixels that differ by more than 24 luma levels | Of the drawn pixels | Mean difference |
  | --- | ---: | ---: | ---: |
  | the final five-mile view (map zoom 12.88) | 0.03 % | 1.7 % | 0.05 |
  | zoom 15.5 | 0.15 % | 0.34 % | 1.32 |
  | zoom 17.2 (buildings, paths, points) | 0.30 % | 0.67 % | 0.92 |

  What still differs is explained: edge pixels move by a fraction of a pixel (a package keeps coordinates on a 4096 grid and
  simplifies lower zooms), and the one building the bundled data flags as highlighted is drawn plain, since a package carries
  no such flag. This comparison is what exposed the street-layer fill defect listed in the changelog.

### What the real Protomaps file establishes (`real-protomaps.test.cjs` and two package scenarios)

The input is `data/samples/protomaps-basemap-firenze.pmtiles`, a Protomaps basemap archive (version 3.7.1, built with
planetiler) that the PMTiles project publishes, copied unchanged (its SHA-256 is asserted: 6,601,156 bytes, 92 tiles, zoom 0
to 15, central Florence). Everything else in the package tests is written by this repository, so this is the one place the
reader, the decoder and the adapter meet data somebody else produced.

- **The reader.** `describe` reads the name, version, layers, bounds, zoom range and compression from under 25,000 bytes of a
  6.6 MB file. The credit in the file is written `&copy; OpenStreetMap contributors`; it is shown as text (`© OpenStreetMap
  contributors`) in the dialog and the note, never as markup.
- **All 92 tiles decode and adapt** with no failure; of 136,928 features, 117,437 (85.8 %) are drawn, including 8,643 road
  features and 2,519 rail features. The rest is what the map does not draw: administrative boundaries, the background
  `earth` polygon, sidewalks and crossings, drains and ditches, land-use kinds it has no colour for and unnamed points (per-layer
  counts in `docs/MAP_DATA.md`). Mean 13.3 ms per tile and 228 ms for the slowest, in Node on one thread.
- **What is on the tile under the Piazza del Duomo at zoom 14:** a street network (more than 400 road features), rail (more than
  50), the river, parks, buildings, and the names of streets, places and businesses, among them `Via dell'Oriuolo`,
  `Cupola del Brunelleschi` and `Torrente Mugnone`. At zoom 12 the tile has more than 50 place names, each appearing at the zoom
  the file itself chooses; at zoom 10 `Fiume Arno` is named, and `Firenze` is named on the tiles around the Duomo.
- **Names are ranked.** At zoom 15 a tile holds more than the 500 names a tile may carry; street names are kept before
  businesses, and within one importance the name Protomaps ranks higher (its `min_zoom`) is placed first.
- **In the real page** (`regions.browser.test.cjs`, scenario "a real Protomaps basemap"): the package is added, the dialog and
  the note show its credit as text, no tile fails, the frame is five miles around the Duomo, and the final view has 32,061 bright
  line pixels (the road net, the Arno, rail and parks) with `Fiume Arno`, `Torrente Mugnone` and 25 places named. At zoom 15.5 at
  least ten street names are drawn; at zoom 17.5 landmarks and businesses such as `Cupola del Brunelleschi` and `Campanile di
  Giotto` are. Outside the package's box (a photo in Sydney) the note says that no roads or buildings are installed there and
  offers Add map data: nothing is claimed. The three screenshots are `docs/verification/real-florence-1-five-mile-view.png`,
  `-2-street-names.png` and `-3-landmarks.png`.
- **What this found, before it was fixed.** Real tiles prefix Protomaps' own properties with `pmap:` (`pmap:kind`,
  `pmap:kind_detail`, `pmap:min_zoom`). The adapter, written from the documentation and the synthetic packages, read none of
  them, so it drew 41.7 % of the features (buildings and named points) and none of the roads, rivers, rail, parks or place names:
  the five-mile view had 1,593 bright line pixels and no names. Other things found the same way: the credit's `&copy;` showed
  as raw text; once roads were being read, the cap of 500 names per tile was filled by businesses before the roads were reached, so streets went
  unnamed at zoom 15; and the producer's own ranking was not used; and, found by reading the screenshots, a long business name was checked for overlap as at most 190 px wide while being drawn in full (now up to 360 px). All are fixed and each has a test.

### What the whole-flow tests establish

- The exact stated values appear and are plotted: 29.64885278, -82.33788889, elevation 47.46 m, error 12.5 m, SHA-256 equal
  to the file's real hash; the pin and the camera end on the recorded coordinate, framed at five miles.
- Every non-located status (no GPS, partial, missing reference, invalid, conflicting with both candidates listed, read
  failures, unsupported, empty, 65 MiB) gets its own message, no pin and no coordinates, and the camera rests on the whole
  globe, never mid-descent.
- Outside the bundled streets the exact point sits in the same five-mile frame over the world overview with the coverage
  note and the Add map data button. With the street data removed from the page, the same file also ends framed rather than
  flying into a blank map.
- 85 degrees north, 89.5 north and 89.5 south end on the globe with the marker and the frame: the flat map is used only where
  Web Mercator can draw the whole viewport around the frame inside +-85.05 degrees. 78.2 north and 77.8 south still end on the
  flat map.
- Antimeridian: the camera is sampled on every frame and never travels the long way.
- Cancelling is total: choosing a file or pressing Clear during the scan, the flight or the sound leaves no pin, no
  coordinates, no table, no camera movement afterwards, and silences every voice within 400 ms (voices fade out over about
  40 ms). A read that finishes after the person has moved on is discarded.
- Replay performs no second file read and no second worker. Skip at any stage, including before the file has been read, ends
  in the same state as a complete run.
- For a located result the export contains exactly the baseline report keys and no presentation state.
- With sound blocked, missing, muted or throwing, the result is identical and the run is not slowed. Muted creates zero audio
  nodes. Reduced motion has no intermediate camera zoom at all.
- No request ever leaves the page: every whole-flow, cancellation, globe, package and environment scenario asserts that. The
  CSP refuses fetch, WebSocket, a cross-origin worker, `data:` workers, eval, remote images, remote scripts and frames.
- No console error or warning in any scenario.

### Timing, measured (headless Chromium, software rendering — not a performance claim)

Cinematic profile, 1440 x 900, final run:

| Beat | Planned | Measured |
| --- | ---: | ---: |
| acquire | 300 ms | 313 ms |
| scan | 900 ms | 915 ms |
| reveal | 1000 ms | 1005 ms |
| resolve | 600 ms | 604 ms |
| fly (revolution, orientation, descent, hand-off, frame) | 8000 ms | 8009 ms |
| lock | 700 ms | 708 ms |
| whole sequence | 11500 ms | 11554 ms |

During the flight: 455 frames, median frame interval 16.7 ms, 95th percentile 33.3 ms, worst 33.5 ms. In the camera-only
measurement (451 frames: 311 drawn by the globe, 140 by the flat map after the hand-off) the median was 16.7 ms and the worst
33.4 ms, and the flat map's 140 frames never exceeded 16.8 ms. A software renderer is probably slower than a real device here,
but this has not been measured on one. Redrawing the street layer on the full bundled data took (median / worst) 0.1 / 0.3 ms
at zoom 11, 0.1 / 0.8 ms at 14, 0.9 / 1.4 ms at 17, 0.7 / 1.0 ms at 18 and 0.3 / 0.4 ms at 19, after a one-time 127 ms build.
Redrawing with a package installed averaged 0.26 ms per draw in the sequence scenario (11.7 ms at worst, once).

### Weight and memory, measured

- Page: 4,723,697 bytes (4.50 MiB; 921,394 bytes gzipped by Node's zlib at level 9). 2.1.0-rc.1 was 4,227,641 bytes. The globe pack is 0.3 MB of that.
- JS heap at rest 19.8 MB, after two full analyses 15.4 MB (total heap 30.5 and 32.1 MB; a collection ran in between); DOM nodes
  771 at rest, 963 after two results (tag tables).
- Disk: a package costs the size of its file if the person lets the app keep a copy (never above 512 MiB), and nothing if not.
  Measured packages are in `docs/MAP_DATA.md`.

### Sound, measured, not heard

The cues were rendered offline and measured. Peaks at default settings: intake -20.2 dBFS, tick -28.3, resolve -14.7,
lock -17.5, neutral -16.2, error -13.7, confirm -18.2, descend -14.7, spin -14.6, detail -30.4. At full volume every cue stays
under -5 dBFS. All cues end silent with no DC offset. **Nobody has listened to them.** Whether they sound good, are too quiet
or too loud on real speakers, or are annoying after the tenth analysis, needs a person with speakers.

### Contrast

Text colours on every surface they are used on: between 5.1:1 (the accent on the raised surface) and 16.9:1 (body text on
the darkest surface). In the live app, the lowest measured ratio of any visible text was 6.19:1 across seven states.

### Layout

Idle, scanning, located and no-location states were checked at 1440 x 900, 1180 x 800, 1024 x 768, 768 x 1024, 720 x 900 and
390 x 844 for sideways page scroll, controls leaving the window, clipped button text, a usable map and a square five-mile frame
that fits inside it. At phone width every primary control is at least 44 px in one direction. Screenshots are in
`docs/verification/` (palette-optimised copies of the test screenshots from the run above, to keep the repository small).

The text and controls laid over the map (coverage note, coordinate readout, scale bar, map buttons, map title, status badge,
attribution and, on the globe, the altitude readout) are measured against one another at all six widths and none overlaps
another. Writing this check, and reading the screenshots, found three real defects that the earlier tests had missed: the
note overlapped the coordinate readout and scale bar on tablets; on a phone the note grew tall enough to cover a corner of
the frame at 85 N; and on a phone the globe's altitude readout ran under the map buttons. All three are fixed (see the
changelog). The frame is still exactly five miles in each case; on a phone it is smaller on screen (about 180 px, read from the screenshot) to leave room for
the note.

### Mutation checks (done by hand, each mutant caught, real code restored)

| Break introduced | Caught by |
| --- | --- |
| Even-odd fill put back in the street layer (2.2) | `layer.browser`: "a footprint listed in two cells is filled (alpha 0)" |
| Flights not unwrapped across the antimeridian (2.1) | `antimeridian…` (camera moved 329.9 degrees, limit 40) |
| Stale-read guards removed in `runAnalysis` (2.1) | both "a read that finishes after…" tests |
| Tag-table guard removed (2.1) | "typing in the tag filter before the reveal…" |
| A 600 px-wide Analyze button (2.1) | the 390 px layout test |
| Muted text colour made too dark (2.1) | the token and live contrast tests |
| Arrival tolerance set back to 1e-7 degrees (2.1) | the director's sub-pixel arrival test (other director tests also failed in that run, so only that one is claimed) |
| Seeded noise source replaced by `Math.random` (2.2) | "identical renders are identical" (checksums -143.6 and -147.9) |
| The label-width limit put back to 190 px (2.2, real-file work) | `tile-schema`: "a long name keeps its whole width…" |
| The adapter before the real-file work put back (properties read without the `pmap:` prefix) | 4 of the 6 `real-protomaps` tests fail (drawn share 0.417 against the required 0.8; the Duomo tile, the zoom 12 tile and the name ranking); the byte-identity and `describe` tests still pass, as they should |

The 2.1 rows were done against 2.1.0-rc.1 and their tests are unchanged. No mutation checks were done for the globe and package
code beyond the first row and the rows marked 2.2 or real-file work. Two checks were, however, shown to fail on the real defects they were written for, before
those were fixed: the 390 px globe test failed with `sw: coverageNote` (note over the frame corner at 85 N), and the overlap
check failed with "the map controls and the globe readout overlap by 125 x 16 px".

## What this does not show

- It has not been run on Windows, Edge, Firefox or Safari, on a real GPU, or in a headed browser. `START_WINDOWS.bat`
  was not executed (it is unchanged from 2.0.0); `RUN_CONSOLE.py`, which it starts, was.
- **Only one real third-party map package has been read**, the Protomaps basemap sample for central Florence. Everything else
  about packages was verified against the specifications' own test values, files written by this repository's writers,
  synthetic packages and the converter's output from the bundled OpenStreetMap data. Not read: any other area, any other
  Protomaps version, any OpenMapTiles archive, any archive with leaf directories or a different planet build, names in
  non-Latin scripts, and the output of the Protomaps `pmtiles extract` command in `docs/MAP_DATA.md`, which comes from their
  documentation and was not run because the sandbox could not reach the internet. If a real extract draws wrongly,
  `tile-schema.js` is the one file that decides how layers and properties become drawing kinds.
- The app has no worldwide street data. The Florence sample covers about 5.3 km by 4.9 km; everywhere else outside Gainesville
  needs a package the person obtains.
- MapLibre Tile (tile type 6), raster, brotli and zstd archives are refused with a reason, not read; none was tried beyond a
  package whose header says so.
- The globe's data is Natural Earth 1:110 m (accurate to a few kilometres) and the 418 reference cities come from the time-zone
  table. There are no rivers, lakes, regional boundaries or transport lines at world scale; richer Natural Earth layers could
  not be downloaded.
- `tools/build_globe_pack.py` was run only with its default inputs (it reproduces `data/globe-pack.json` byte for byte). Its
  options for richer Natural Earth files (50 m and 10 m, states, lakes, rivers, roads, railways, populated places) have no test
  and were not run, because those files could not be obtained.
- A package that crosses the antimeridian as one box cannot be described in PMTiles bounds and has to be split in two (the
  split case is tested with synthetic packages). Where packages overlap, one owns each tile; they are not merged.
- Resizing the window during a flight refits the frame only when the flight ends. On short panes the frame is smaller on
  screen (never below 160 px) and still five miles.
- The street layer and the flat map use Leaflet 1.9.4's private `_move*` methods for the hand-off; a different Leaflet
  version needs this re-checked.
- The hidden-tab behaviour was tested by dispatching the `visibilitychange` event with `document.hidden` forced true, not by
  switching real tabs.
- Drag and drop was tested by dispatching drag events carrying real `File` objects, not by dragging from a file manager.
- The 65 MiB limit was tested with a sparse file; real large photographs were not used.
- HEIC and AVIF were not re-tested; that code is untouched.
- Screen-reader output was not listened to. Live-region text and `aria-hidden` on decoration are asserted, not heard.
- Frame timing and the six-fold CPU slowdown say nothing about how smooth it is on the owner's machine or on a real
  low-end graphics stack.

## Reproduce

```bash
npm install                      # development only: Playwright 1.56.1
npx playwright install chromium
node tests/run.cjs               # all, serially (about eighteen minutes)
node tests/run.cjs unit          # logic tests only, no browser
META_TRACE_ARTIFACTS=out node tests/run.cjs browser   # also writes screenshots and measurements to ./out
```

Without Playwright every browser test is reported as skipped with the reason, not as a pass.
