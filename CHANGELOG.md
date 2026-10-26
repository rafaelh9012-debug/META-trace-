# Changelog

## 2.2.0-rc.1 — globe and mapping upgrade (release candidate)

Built on 2.1.0-rc.1. Release tagging is left to the owner; no tag was created or moved (only the local
`baseline-2.0.0-zip` tag exists in the working clone). The private repository could not be reached from the working
session, so nothing was pushed. How the numbers below were measured is in `docs/VERIFICATION.md`; what the map data
is, what it costs and how to add more is in `docs/MAP_DATA.md`; the design and its reasons are in
`docs/MAP_ARCHITECTURE.md`.

### What the person sees

- **A real 3D globe is the default view.** Dark-red ocean, land, coastlines, national borders, a graticule that follows the
  zoom, country names, reference cities, limb darkening and a rim light. It is a perspective camera over a sphere: drag to
  turn it (with a short coast), scroll or pinch to zoom, arrow keys, `Home` or Recenter to come back, double-click to
  move toward a point. With nothing selected it turns slowly by itself, unless motion is reduced, the tab is hidden, or the
  person has zoomed in.
- **A located image plays one continuous camera path.** The globe takes the stage and turns **at least one full
  revolution** (measured: 406.2 degrees for Gainesville, 529.8 degrees for Sydney in the package scenario), swings its latitude to the
  target with north kept up, descends without a break to about 1 km per pixel, hands over to the flat map at the same
  place and scale through a short cross-fade, and keeps descending to the final view. The point is centred and its marker
  locks with a pulse, closing frame brackets and a sound.
- **The final view is exactly five miles by five miles.** A square frame (5 mi, 8.05 km) is fitted around the point from the
  latitude; it is not a zoom constant. Measured from outside the app over 14 places (both hemispheres, the equator, the
  antimeridian from both sides, Tromsø, Longyearbyen, McMurdo, 85 degrees, both poles) each side is within 0.34 % of 5 miles
  (the two sides differ in opposite directions; their mean is 5 miles) and the point is within 3.7 m of the centre (0.2 px).
  Where Web Mercator cannot draw the whole viewport around the frame (within a fraction of a degree of its 85.05 degree
  limit, and at the poles) the globe stays on screen as the final view with the same frame.
- **After the frame is reached the person is in charge.** Zoom with the buttons, wheel or pinch, drag, and press Recenter to
  come back to the frame.
- **Switch view** (globe or streets) in the map controls moves between the two renderers at the same place and scale.
- **Timing.** Cinematic 11.5 s (acquire 0.3, scan 0.9, reveal 1.0, resolve 0.6, camera 8.0, lock 0.7), Fast 5.07 s with
  the whole revolution kept, Reduced about 0.8 s with no camera flight at all (also what the system "reduce motion"
  setting selects until the person chooses). Skip, Replay and Escape work at every moment; Clear, a new image or any manual
  camera input cancels the sequence and its sound at once.
- **Sound.** Two new synthesised cues, a spin that follows the real rotation speed and a soft blip per level of detail,
  join the existing ones. Mute, volume, the gesture unlock and the "blocked" and "unavailable" states are unchanged and the
  sequence never waits for audio.
- **Map data (new button in the map controls).** Optional map packages, one `.pmtiles` file each, add streets,
  buildings, water and names for other places. The app downloads and uploads nothing: the file is read from where it is, a few
  kilobytes at a time. The person chooses whether the app keeps a copy in the browser's storage (on by default when the browser
  allows it, never above 512 MiB) so the package is there next time; **Remove** forgets it. Packages draw through the same
  canvas layer as the bundled Gainesville streets. Without one the point sits on the globe-scale overview with a
  plain note and an **Add map data** action; with one, the note names the package and its credit. If a package covers the
  point on paper but its tiles hold nothing in the frame, the note says so instead of implying streets.
- **Real Protomaps basemaps draw as a map.** The PMTiles project publishes a real Protomaps basemap sample (central Florence);
  reading it showed that a real package drew only buildings and business names. Now it draws roads by class, rail, rivers
  and streams (named), water, parks and paved areas, and names for streets, places, landmarks and businesses, ranked so that
  street names come before businesses and the producer's own ordering is respected. The sample is included as
  `data/samples/protomaps-basemap-firenze.pmtiles` (6.6 MB, ODbL, credit shown). It is not built into the page and it does not
  add detail outside its own 5.3 km by 4.9 km box; worldwide street data is still not bundled and still has to come from a
  package the person chooses. `docs/MAP_DATA.md` lists what is and is not drawn.
- **Phones and short windows.** Below 1181 px the map is scrolled into view when the flight starts, and a Skip button appears
  in the map controls for the length of the sequence. The frame is made no larger than the room above and below the centre
  (it is still exactly five miles, only smaller on screen). The map controls move to a row under the heading at 720 px and
  below, and the map pane is 560 px tall there. The coverage note and the coordinate readout share one box so they cannot overlap.

### What did not change

- `metadata-core.js`, `metadata-parser.js` and `metadata-worker.js` are byte-identical to 2.0.0, as are the vendored exifr
  and Leaflet and `tests/metadata.test.cjs`. The report schema and statuses (`located`, `no_location`,
  `incomplete_location`, `invalid_location`, `conflicting_location`; unsupported formats and read failures separately) and
  the rule that **only validated embedded GPS is plotted and triggers the descent** are unchanged.
- The content-security policy is byte-identical (`default-src 'none'; … connect-src 'none'; worker-src blob:; …`). The
  globe needs no WebGL, worker, fetch or font, and packages are read from a chosen file.
- No paid service, key, account or network request. Nothing is invented: every globe vertex comes from the Natural Earth
  and IANA files already in the repository, and the frame, the marker and the camera come from the embedded coordinate only.

### New files

- `globe-math.js` (geodesy, the five-mile frame, camera, the unwrapped sequence plan), `globe-data.js` (pack to unit-vector
  geometry), `globe-view.js` (the Canvas 2D renderer), `globe-director.js` (one camera path from globe to street map),
  `data/globe-pack.json` (0.3 MB: coastline, borders, reference cities), `tools/build_globe_pack.py`.
- `pmtiles-reader.js`, `mvt-decoder.js`, `tile-schema.js`, `region-manager.js`, `pack-store.js`: the optional package
  stack. `tools/make_pmtiles.py` converts GeoJSON in the app's street format into a package.
- `docs/MAP_ARCHITECTURE.md`, `docs/MAP_DATA.md`.
- `data/samples/protomaps-basemap-firenze.pmtiles` and `data/samples/README.txt` (source, commit, SHA-256, licence), copied
  unchanged from the PMTiles repository; `tests/real-protomaps.test.cjs`; `tests/fixtures/gps-florence-duomo.jpg` (a synthetic
  image with GPS tags for the Piazza del Duomo, made by `tests/generate_fixtures.py`).
- Tests: `globe-math`, `globe-data`, `globe-director` and the new `globe.browser`, `regions.browser` suites, plus
  `pmtiles-reader`, `mvt-decoder`, `tile-schema`, `region-manager`, `pack-store` and `make-pmtiles`.

### Deliberate contract changes

- **The map finish is the five-mile frame, not zoom 18.** Tests that asserted zoom 18, the world-overview zoom 5 for
  places outside the street data, and the "projection notice instead of a pin" for polar points were rewritten:
  the frame is measured from outside, an uncovered place ends on the same frame over the overview with the coverage
  note, and a polar point ends on the globe with its marker and the frame.
- Cinematic is about 11.5 s (was 6.2 s) and Fast 5.07 s (was 2.8 s). Reduced is unchanged.
- Recenter with nothing located brings the globe back to its home view; with a located result it returns to the five-mile frame.
- The idle turn runs only at or above 80 % of the globe's resting height, so a person who has zoomed in keeps the view.
- The zoom buttons cancel a running flight and its sounds like every other manual control (they cancelled the camera and
  left the sounds to play out).
- ArrowUp and ArrowDown on the globe now move north and south like the flat map and the left and right keys (they were swapped).
- The street index is built before any camera move, not in an idle callback that the browser may postpone.
- The page is 4,723,697 bytes (2.1.0-rc.1: 4,227,641): the globe pack is 0.3 MB and the rest is code.

### Defects found by reading a real Protomaps package, and fixed

- **Real Protomaps tiles drew almost nothing.** Protomaps writes its own properties with a `pmap:` prefix (`pmap:kind`,
  `pmap:kind_detail`, `pmap:min_zoom`, `pmap:level`, `pmap:link`); the adapter, written from the documentation and synthetic
  packages, read none of them. Of the 136,928 features in the Florence sample only 41.7 % were drawn (buildings and business
  names) and the five-mile view had 1,593 bright line pixels and no names. Properties are now read with or without the prefix
  (the prefixed value wins), and the layers real builds use (`physical_line`, `physical_point`, `transit`, `natural`) are mapped.
  85.8 % are drawn now and the same view has 32,061 line pixels with the Arno, Torrente Mugnone and 25 places named.
- The package credit, written `&copy; OpenStreetMap contributors` in the file, was shown with the entity spelled out. It is
  now decoded to text; it still only ever reaches the page as text, never as markup.
- A dense tile (zoom 15) filled its 500-name allowance with businesses (the layer comes before the roads) before any street was reached. Names are now
  collected up to 20,000 per tile and trimmed to the 500 that are placed, by importance (street names before businesses) and
  then by the producer's own rank.
- A long name ("Biblioteca dell'Opera di Santa Maria del Fiore di Firenze") was drawn in full but checked for overlap as at most
  190 px wide, so it ran under the names next to it. Found by reading the Florence screenshots; the estimate now follows the text up
  to 360 px, and a test fails with the old limit.
- A package whose tiles are MapLibre Tile (type 6, PMTiles 3.5 and later) was reported as "unknown"; it is now named and
  refused with the reason.
- Tests, not product: a wrong expectation (a tertiary road is a main road for naming, so its name appears at zoom 13) and two
  thresholds and one "before" figure that had been written without being measured; they were measured and corrected.

### Defects found by real-browser verification, and fixed

- **Large buildings lost their fill** in the street layer of 2.1.0-rc.1: a footprint that crosses a line of the data
  grid is listed in each cell it touches, the visible cells' lists are added to one path, and the even-odd fill rule
  cancelled every footprint listed an even number of times. Found when the bundled data, converted to a package, drew
  differently from the original. Rings are now wound outer one way and holes the other and the fill rule is non-zero; a new
  layer test (footprints in two and four cells, overlaps, courtyards wound either way) fails on the old rule and passes now.
- Names from an installed package never appeared: label selection is throttled and tiles arrive after the last selection.
  A trailing timer now re-selects, and new tiles reset the throttle.
- The coverage note sat on top of the coordinate readout at 1180 px and below (18 px at tablet widths, 8 px at 720 and 390),
  and at 390 px its corner overlapped the scale bar. Both texts now share one box that grows upward from the bottom edge. The
  layout test gained an overlap check between the map's overlays; it flagged five of the six layouts on the previous build.
- On a phone (390 px) the coverage note, narrowed to clear the scale bar, grew tall enough to cover the lower-left corner of
  the five-mile frame at 85 N (found by the globe test at that width). The note now takes the full width of the pane, the pane
  is 560 px tall with a larger bottom reserve (the frame is still exactly five miles, only smaller on screen), and the scale
  bar shows one line (miles) on phones; the frame's own label carries both units.
- On a phone the globe's altitude readout ran underneath the row of map buttons (found by reading screenshots; the overlap
  check now includes it). It sits below the row on phones.
- Tests, not product: two assertions still expected the words "regional map package"; a package scenario compared line counts
  before throttled label selection had settled; and an audio check demanded bit-for-bit identical renders, which the browser's
  audio engine did not always give (a 6e-10 checksum difference once in five runs). They now check the button, the settled
  count, and equality to 1e-6; the last was shown to still fail when the noise source is made random.
- After a cancelled descent the globe stayed frozen near the surface, so the next revolution did not start from a
  recognisable globe. The scan phase now backs the globe off first, and choosing another image eases it back.
- The idle turn resumed after a sequence that ended on the globe (a polar target) and carried the marker away from the
  middle of the frame at 3.2 degrees per second.
- Below 1181 px the cinematic played off screen; the frame sat under the coverage note on short panes; the seven map controls
  overflowed a 480 px phone pane (Playwright's click hung); the "keep a copy" box defaulted to off; a package that covered only part of the bundled Gainesville area
  hid the bundled streets there (now it must cover all four corners down to zoom 14); `PackStore.remove` answered true for
  an id it did not have.

## 2.1.0-rc.1 — cinematic upgrade (release candidate)

Built from the supplied 2.0.0 source (baseline hash verified; the 25 baseline Node tests passed before any change).
Release tagging is left to the owner.

### What the person sees

- **A dark-red analysis instrument.** Three zones: the image bay (scan sweep over the photo, real sampled bytes and real
  tag names in the margins), the readout rail, and the offline map.
- **Choosing a file only seats it. Analyze runs the analysis.** The result is then shown in beats: acquire, scan, reveal,
  resolve (the coordinate digits settle), fly (smooth descent), lock (the pin lands), settled.
- **Skip animation / Show result** finishes the presentation at once, with the same final state as a full run.
  **Replay** shows the saved result again without reading or parsing the file a second time.
  **Clean view** hides the instrument layers; the file name, outcome and controls always stay visible.
- **Motion:** Cinematic (about 6.2 s), Fast (about 2.8 s) or Reduced (about 0.8 s, no camera flight). Follows the
  system "reduce motion" setting until the person chooses.
- **Sound:** short original sounds synthesised in the browser. On/off, volume, remembered. Blocked, missing or failing
  audio never delays or changes the result; the Sound control says what state it is in.
- **Map finish:** street scale (zoom 18) where offline street geometry exists; anywhere else the exact point on the world
  overview with a plain explanation, never a flight into a blank map. Near the poles the numbers are shown with a
  projection notice instead of a pin. The position-error circle stays centred on the original coordinate; the pin is
  never moved.
- **Recenter** returns to the exact point after the person pans away; any map input hands the camera back at once.
- The browser tab has an inline `data:` icon (the reticle mark), so it no longer needs to ask the launcher for
  `/favicon.ico`. This was not observed to matter in headless Chromium, which never asks; headed browsers were not run.
- Analysis log result lines are held until the reveal, so the log does not announce the result before the screen does.
  They keep the times at which they really happened.

### What did not change

- `metadata-core.js`, `metadata-parser.js`, `metadata-worker.js`, the vendored exifr and Leaflet, the map data, the
  launchers and `tests/metadata.test.cjs` are byte-identical to 2.0.0.
- Report schema and statuses (`located`, `no_location`, `incomplete_location`, `invalid_location`,
  `conflicting_location`). Unsupported formats and read failures remain separate states. Presentation state never
  appears in a report.
- The content-security-policy is byte-identical (`connect-src 'none'`). No network request is made. No paid service,
  key or account. No fixed or guessed location.

### Deliberate contract changes

- The jsdom UI test (`tests/ui.test.cjs`) is removed. It could not run without an npm install, and it replaced map
  drawing, workers and audio with stand-ins. Every assertion in it is repeated in the Playwright suites, against the
  real built page.
- File selection no longer starts the analysis; the Analyze button does. The drop area element is now `#bay`
  (it was `#dropZone`). Anything scripting the old IDs needs updating.
- The visible product name is **META trace**. The entry file is `META_trace_Console.html` and `BUILD_INFO.json`
  identifies the same application, so existing shortcuts and tooling keep working.

### Defects found by real-browser verification, and fixed

- Recenter after a manual drag never finished: Leaflet rounds the map centre to whole pixels, so the director's
  `1e-7` degree arrival check could not pass and the camera stayed "flying". Arrival is now within 1.5 px at the target
  zoom, and the last sub-pixel gap is closed with an exact view reset (also used by Skip).
- A result with nothing to plot could end mid-zoom, or on the previous street view. The camera now rests on the wide
  view for every non-mapped outcome, including read failures and Skip.
- The tag table could be revealed early by typing in the filter during the scan.
- The map heading kept saying "Select an image…" while a file was being analysed.
- The Sound and Motion controls were 40 px tall on phones; now 44 px.

### Not done (see HANDOFF.md for the reasons and next steps)

- HEIC/AVIF parsing is unchanged (best effort).
- No "install a region" flow for more offline street data; outside the bundled area there is only the coverage
  explanation on the world overview.
- No street-photography provider (it was optional and would have needed an opt-in network provider).
- Nothing here has been run on Windows, Edge, Firefox or Safari, or on a real GPU. The sounds have been measured, not heard.
