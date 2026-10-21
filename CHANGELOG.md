# Changelog

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
- The visible product name is **META trace**. The entry file is still `Qwen_Map_Console.html` and `BUILD_INFO.json`
  still says "Crimson Image Metadata", so existing shortcuts and tooling keep working.

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
