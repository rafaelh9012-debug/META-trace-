META TRACE 2.2.0-rc.1 — LOCAL IMAGE METADATA INSTRUMENT

START ON WINDOWS
1. Extract the complete ZIP to a new folder.
2. Double-click START_WINDOWS.bat.
3. Choose an image (or drop one onto the image area), then press Analyze.

You can also open META_trace_Console.html directly.
On macOS/Linux open that HTML file or run: python3 RUN_CONSOLE.py
No third-party Python packages, account, map key, or internet connection
are required to use the application. The optional Python launcher uses only
the standard library and serves the folder on 127.0.0.1.

USING IT
- Choosing a file only seats it and checks that it is an image. Analyze reads it.
- Nothing selected: the map is a 3D globe. Drag to turn it, scroll or pinch to zoom, arrow keys to move, Home or
  Recenter to bring it back, double-click to move toward a point. It turns slowly by itself until you touch it.
- A photo with valid GPS in it plays one camera path: the globe turns at least a full revolution, swings to the right
  latitude, descends without a break, hands over to the flat map and ends on a square frame exactly 5 miles by 5 miles
  centred on the embedded point. You can then zoom, drag and press Recenter to come back to the frame.
- While the result is shown you can press Skip animation (the button says Show result if the file is still being read),
  the Skip button on the map, or Escape. You land on exactly the same final state.
- Replay shows the saved result again. It does not read or parse the file a second time.
- Change image and Clear stop everything at once: the animation, the camera move and any sound. So does touching the
  map or globe during a sequence.
- Clean view hides the decorative instrument layers. The file name, the outcome and the controls are always visible.
- Motion: Cinematic (about 11.5 seconds), Fast (about 5, still a full turn), Reduced (under a second, no camera flight).
  It follows your system's "reduce motion" setting until you choose one here.
- Sound: short original sounds made in your browser, including a turning sound that follows the globe's speed.
  On/off and volume are remembered. If the browser blocks audio, or has none, the Sound control says so and nothing
  else changes.
- Switch view (map controls) goes between the globe and the street map at the same place and scale.
- Map data (map controls) adds optional offline map packages for other places. See MAPS below and docs/MAP_DATA.md.
- Copy coordinates and Export report work as before.
- Keyboard: Tab through the controls, Enter or Space to press, Escape to skip.

WHAT IT ACTUALLY DOES
- Reads the selected image's bytes locally, validates its signature, and parses
  EXIF/GPS/XMP/IPTC metadata with the bundled exifr 7.1.3 parser.
- Computes the selected file's real SHA-256 when browser crypto is available.
- Displays readable metadata tags, camera/time fields when recorded, valid GPS
  coordinates, elevation and horizontal position error when recorded.
- Maps only a validated embedded coordinate pair. It never defaults to the old
  Courtyards example or assumes a location from a filename or image content.
- Shows No location metadata found if GPS coordinates are not embedded.
- Distinguishes missing, incomplete, invalid, conflicting and unreadable data.
- Clears an earlier GPS marker when a new image is selected or the image cleared.
- The animation is only a way of showing a result that already exists. It does not
  decide, delay or change what the analysis found. The coordinate digits settle on
  screen, but the real text of the result is exact from the start.
- Copies decimal coordinates and exports a JSON metadata report on request.

SUPPORTED FORMATS
JPEG, PNG, TIFF and WebP EXIF/GPS are covered by synthetic-image tests.
XMP-only GPS in a JPEG is also tested. WebP EXIF/XMP chunks are handled by a
bounded RIFF reader before passing EXIF to the parser.
HEIC/AVIF are best effort. Some newer phone container variants are not
supported by the bundled parser. An unreadable variant produces a parse-error
message, not a false claim that GPS is absent. Preview support also depends
on the browser; metadata can be readable even if the thumbnail cannot display.
RAW camera files, GIF/BMP, SVG, sidecar files and videos are not supported.
Maximum input: 64 MiB. Images are analyzed one at a time.

LOCATION RESULTS
Embedded GPS tags are editable records, not proof of where a photograph was
actually taken. The app does not identify people or infer their residences.
It does not inspect scene content to guess a location or recover
metadata removed before the file was received. IPTC city/country text alone
is not converted to an exact coordinate.
Use the original image where possible; a screenshot or a file exported through
another app may have different metadata than the original.

MAPS
The dark red globe and map work offline and use no external tile requests. There are two separate things, and it
helps to keep them apart. The renderer is the code that draws (a Canvas 2D globe written for this project, and
Leaflet 1.9.4 for the flat map); it contains no geography. The map data is what it draws.
- Built in: a Natural Earth 1:110 m world overview (land, coastlines, national borders, 177 country names), 418
  reference cities (one per IANA time-zone region; this is not a list of the largest cities), and detailed
  OpenStreetMap street/building geometry for part of the Gainesville/UF area: longitude -82.351 to -82.324;
  latitude 29.638 to 29.659. Everything is inside the HTML file (about 4.7 MB).
- Not built in: streets, buildings, rivers, lakes, regional boundaries or railways for the rest of the world. A
  worldwide street dataset is far too large to bundle (Protomaps documents its planet basemap at about 120 GB; not
  measured here).
- Optional map packages: Map data > Add a .pmtiles file adds streets, buildings, water and names for a region from a
  single PMTiles v3 vector-tile file that you choose. The app reads it a few kilobytes at a time from where it is; it
  never loads a whole package into memory and never connects to anything. You choose whether it also keeps a copy in
  this browser's storage (that copy uses as much disk space as the file; files over 512 MiB are never copied). Remove
  forgets a package and its copy; the file you chose is never touched. docs/MAP_DATA.md has sizes, licences, how to
  make a package (tools/make_pmtiles.py, or the Protomaps "pmtiles extract" command) and what was and was not tested.
  data/samples/ holds one real Protomaps basemap package for central Florence, Italy (6.6 MB, copied unchanged from the
  PMTiles project) to try it with; it is not built into the page and covers only that small area.
- The result view for a valid GPS point is a square frame 5 miles by 5 miles (8.05 km) centred on it. Where no local
  roads are installed the frame sits over the world overview, and the note under the map says exactly that and offers
  Add map data. Nothing is drawn that is not in the data.
- Valid polar coordinates (beyond about 85.05 degrees) cannot be shown by the flat map, so they stay on the globe, with
  their marker and the same frame.
- Position-error circles are shown only when a valid GPSHPositioningError tag records a value in metres. They are
  centred on the recorded coordinate and are not fabricated accuracy estimates. The pin is never moved to "snap" to
  a road.
- Coordinates across the 180-degree meridian are flown to the short way round and end on their true longitude.

PRIVACY AND OUTPUT
Your image is not uploaded. It is not added to this app's folder, a server, a
map service. The app's connection policy blocks external
network requests. Preview data uses temporary local blob URLs.
The JSON report is saved only when you click Export report; it can contain GPS
and other metadata from your image, so inspect it before sharing.
Clear resets the current results. No photo history is stored.
Only three preferences are kept, in this browser's local storage: sound on/off,
volume and motion. The one other thing that can be stored is a map package you
chose to keep (Map data dialog); Remove deletes it. Nothing else is stored.
A fallback parser runs locally if a browser worker cannot start.

DEVELOPMENT
The complete source, offline map datasets, parser license and synthetic fixtures
are included. Read HANDOFF.md for the architecture, tests, and maintenance
notes. CHANGELOG.md lists what
changed in 2.2.0 and what was deliberately not done. docs/VERIFICATION.md says
exactly what was tested, how, and what was not.
docs/MAP_ARCHITECTURE.md explains the globe and package design; docs/MAP_DATA.md is the map-data guide.
Build the self-contained HTML: python3 build_metadata.py
Logic tests (Node.js 20+, nothing to install): node tests/run.cjs unit
Browser tests need Playwright and its Chromium, for development only:
  npm install
  npx playwright install chromium
  node tests/run.cjs            (everything, one file after another)
  node tests/run.cjs browser    (only the real-browser suites)
Without Playwright the browser tests are reported as skipped, with the reason.
Set META_TRACE_ARTIFACTS=some-folder to also save screenshots and frame timings.
Pillow is required only to regenerate the synthetic fixtures; it is not required
to run the app or the tests.
