CRIMSON IMAGE METADATA — REAL EXTRACTION EDITION

START ON WINDOWS
1. Extract the complete ZIP to a new folder.
2. Double-click START_WINDOWS.bat.
3. Click Choose an image, or drop one into the upload area.

You can also open Qwen_Map_Console.html directly. Its legacy filename is kept
for compatibility; the interface is now a real image-metadata inspector.
On macOS/Linux open that HTML file or run: python3 RUN_CONSOLE.py
No Python packages, model downloads, account, map key, or internet connection
are required to use the application. The optional Python launcher uses only
the standard library and serves the folder on 127.0.0.1.

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
- Outside that local area the exact coordinate gets a pin on the world overview,
  with an explicit note that detailed streets are not included for that place.
- Valid polar coordinates remain visible in the results, but no misleading pin
  is placed outside the map's projection range.
- Position-error circles are shown only when a valid GPSHPositioningError tag
  records a value in metres. They are not fabricated accuracy estimates.

PRIVACY AND OUTPUT
Your image is not uploaded. It is not added to this app's folder, a server, a
map service or an AI provider. The app's connection policy blocks external
network requests. Preview data uses temporary local blob URLs.
The JSON report is saved only when you click Export JSON; it can contain GPS
and other metadata from your image, so inspect it before sharing.
Clear resets the current results. No photo history is stored.
A fallback parser runs locally if a browser worker cannot start.

DEVELOPMENT
The complete source, offline map datasets, parser license and synthetic fixtures
are included. Read HANDOFF.md for the architecture, tests, known limits and a
copy-paste prompt for continuing with a larger model.
Build the self-contained HTML: python3 build_metadata.py
Core/parser tests (Node.js): node --test tests/metadata.test.cjs
For the DOM regression test, install jsdom locally then run:
  npm install --no-save jsdom@26.1.0
  node --test tests/metadata.test.cjs tests/ui.test.cjs
Pillow is required only to regenerate the synthetic fixtures; it is not required
to run the app or the existing tests.
