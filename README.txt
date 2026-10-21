META TRACE 2.1.0-rc.1 — LOCAL IMAGE METADATA INSTRUMENT
(formerly Crimson Image Metadata. The entry file keeps its old name, Qwen_Map_Console.html, so shortcuts still work.)

START ON WINDOWS
1. Extract the complete ZIP to a new folder.
2. Double-click START_WINDOWS.bat.
3. Choose an image (or drop one onto the image area), then press Analyze.

You can also open Qwen_Map_Console.html directly.
On macOS/Linux open that HTML file or run: python3 RUN_CONSOLE.py
No Python packages, model downloads, account, map key, or internet connection
are required to use the application. The optional Python launcher uses only
the standard library and serves the folder on 127.0.0.1.

USING IT
- Choosing a file only seats it and checks that it is an image. Analyze reads it.
- While the result is shown you can press Skip animation (the button says Show result
  if the file is still being read) or Escape. You land on exactly the same final state.
- Replay shows the saved result again. It does not read or parse the file a second time.
- Change image and Clear stop everything at once: the animation, the camera move and any sound.
- Clean view hides the decorative instrument layers. The file name, the outcome and
  the controls are always visible.
- Motion: Cinematic (about 6 seconds), Fast (about 3), Reduced (about a second, no camera flight).
  It follows your system's "reduce motion" setting until you choose one here.
- Sound: short original sounds made in your browser. On/off and volume are remembered.
  If the browser blocks audio, or has none, the Sound control says so and nothing else changes.
- Recenter returns the map to the exact point. Dragging, zooming or clicking the map
  always takes the camera back from any move in progress.
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
It does not inspect scene content, use AI to guess a location, or recover
metadata removed before the file was received. IPTC city/country text alone
is not converted to an exact coordinate.
Use the original image where possible; a screenshot or a file exported through
another app may have different metadata than the original.

MAPS
The dark red map works offline and uses no external tile requests.
- A Natural Earth overview supports embedded GPS anywhere the Web Mercator
  projection can display (approximately 85.051 degrees N to 85.051 degrees S).
- Detailed OpenStreetMap street/building geometry is bundled for part of the
  Gainesville/UF area: longitude -82.351 to -82.324; latitude 29.638 to 29.659.
  A coordinate inside it ends at street scale (zoom 18).
- Outside that local area the exact coordinate gets a pin on the world overview
  (zoom 5), with an explicit note that detailed streets are not included for that
  place. The map never flies into an empty maximum zoom. There is no way yet to add
  more regions.
- Valid polar coordinates remain visible in the results, but no misleading pin
  is placed outside the map's projection range; the screen says why.
- Position-error circles are shown only when a valid GPSHPositioningError tag
  records a value in metres. They are centred on the recorded coordinate and are
  not fabricated accuracy estimates. The pin is never moved to "snap" to a road.
- Coordinates across the 180-degree meridian are flown to the short way round and
  end on their true longitude.

PRIVACY AND OUTPUT
Your image is not uploaded. It is not added to this app's folder, a server, a
map service or an AI provider. The app's connection policy blocks external
network requests. Preview data uses temporary local blob URLs.
The JSON report is saved only when you click Export report; it can contain GPS
and other metadata from your image, so inspect it before sharing.
Clear resets the current results. No photo history is stored.
Only three preferences are kept, in this browser's local storage: sound on/off,
volume and motion. Nothing else is stored.
A fallback parser runs locally if a browser worker cannot start.

DEVELOPMENT
The complete source, offline map datasets, parser license and synthetic fixtures
are included. Read HANDOFF.md for the architecture, tests, known limits and a
copy-paste prompt for continuing with a larger model. CHANGELOG.md lists what
changed in 2.1.0 and what was deliberately not done. docs/VERIFICATION.md says
exactly what was tested, how, and what was not.
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
