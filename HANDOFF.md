# Crimson Image Metadata — development handoff

Date: 2026-10-21 · Version: 2.0.0 · Target: a free, local Windows/browser application.

## Outcome and next owner

This project has been advanced from a staged terminal/map interface into a working local image-metadata inspector. It now reads image bytes, parses embedded metadata, validates GPS coordinates and places a map marker only when those coordinates are usable. It explicitly reports when no GPS coordinate pair is embedded. There is no Qwen/model startup, prerecorded command output, contact matcher or fixed-coordinate fallback in the built application.

The user wants the next model to continue development from this implementation. Preserve the dark red appearance, no-cost offline operation, simple Windows launcher and truthful separation between what a file records and what can be concluded from it. A larger language model can review and extend the code; no LLM is necessary to extract EXIF metadata, and no model API is currently part of the product.

## Run and build

1. Extract the archive into a folder and run `START_WINDOWS.bat`.
2. The launcher uses `RUN_CONSOLE.py` when Python is available, otherwise it opens the self-contained HTML directly. The Python server binds to loopback, prefers port 8765 and falls back to an available port.
3. `Qwen_Map_Console.html` is the retained legacy entry filename. Its visible title is **Crimson / Image Metadata**. Open it directly to use the app without installing anything.
4. Choose or drop a single image. Input is limited to 64 MiB.
5. Rebuild the HTML with `python3 build_metadata.py`; the build uses only Python's standard library and already-bundled map data.

Runtime dependencies are included, with no CDN requests: Leaflet 1.9.4 and exifr 7.1.3. Parser and HTML checksums are recorded in `BUILD_INFO.json`. Do not edit the generated HTML as the primary source; edit the modules and rebuild.

## Architecture and file map

| File | Responsibility |
| --- | --- |
| `metadata-core.js` | Format signatures, numeric/rational coordinate validation, hemisphere conversion, conflict detection, bounded metadata flattening, report schema, DMS formatting and coverage checks. It has no DOM dependency and supports CommonJS tests. |
| `metadata-parser.js` | Pinned exifr adapter, format/header checks, strict parse-error reporting and bounded WebP RIFF EXIF/XMP chunk traversal. |
| `metadata-worker.js` | Worker request/response handler. Reads an already-selected file buffer and returns parsed metadata or a structured error. |
| `metadata-app.js` | File selection/drop, cancellation/generation tokens, real log output, actual SHA-256, preview lifecycle, results/filter/export/copy controls and map state. |
| `metadata-template.html` / `metadata-styles.css` | Responsive dark red UI, accessible status messages, image upload, GPS results, tag table, analysis log and offline map. |
| `map-utils.js` | Zoom-aware label selection with collision suppression, shared by the local street and world labels. |
| `build_metadata.py` | Inlines scripts, styles, dependencies, worker source and data. Escapes JSON embedded in script blocks and writes build hashes. |
| `data/map-data.json`, `map-labels.json`, `map-meta.json` | Detailed public Gainesville/UF street dataset: 12,671 features and 1,657 label candidates. |
| `data/world-data.json`, `world-labels.json` | Compact Natural Earth world overview. This is not a worldwide street map. |
| `map_builder.py` and `data/part-0.osm` through `part-3.osm` | Source for regenerating the detailed local map if needed. Normal builds use the cached GeoJSON. |
| `vendor/` and the license files | Unmodified bundled parser/rendering dependencies and licensing information. |
| `tests/` | Synthetic images, reproducible fixture generator and Node/parser/DOM tests. No user photographs are bundled. |

## Actual analysis flow

File selection increments a generation token and cancels an earlier worker. The UI clears the earlier coordinate result, marker, metadata table and export state before reading the next file. File size and signature are checked from bytes rather than trusting an extension or MIME string. A local object URL supplies the preview; no remote URL or HTML from a filename is inserted into the page.

SHA-256 is calculated with browser Web Crypto where available. Metadata is parsed in a Blob worker containing the bundled parser. A 12-second limit terminates the worker. If worker startup is unavailable, a local main-thread parser is used; that fallback cannot forcibly preempt synchronous parser execution and deserves further hardening.

Parser options enable TIFF/EXIF/GPS, XMP, IPTC, JFIF and PNG IHDR data. ICC, MakerNote and UserComment extraction are disabled. Key names are translated but values/dates remain unrevived to avoid inventing time-zone interpretation. Output is grouped so distinct EXIF and XMP coordinate records can be compared.

GPS normalization validates a pair, finite numeric/rational values, DMS minutes/seconds, latitude/longitude limits and hemisphere references. Zero latitude, zero longitude and zero elevation remain valid values. Missing hemisphere references for raw EXIF DMS are not guessed. Multiple distinct embedded coordinate pairs produce a conflict result and no selected marker. Altitude is signed only when its above/below-sea-level reference is understood. Only a valid `GPSHPositioningError` is used for a position-error circle; DOP is not treated as metres.

## Result contract

`metadata-core.js` exposes `describe(raw, file, format, sha256)` with this report structure:

```json
{
  "schemaVersion": 1,
  "analyzedAt": "ISO timestamp of analysis",
  "file": {
    "name": "selected filename",
    "sizeBytes": 1234,
    "type": "jpeg",
    "lastModified": "filesystem modification time or null",
    "sha256": "real digest or null"
  },
  "status": "located | no_location | incomplete_location | invalid_location | conflicting_location",
  "location": {
    "latitude": 0,
    "longitude": 0,
    "altitude": null,
    "accuracyMeters": null,
    "source": "gps"
  },
  "issues": [],
  "metadata": [{"tag": "group.TagName", "value": "readable value"}],
  "summary": {"make": null, "model": null, "recordedTime": null}
}
```

`location` is `null` for every non-located status. Conflict reports also include candidate coordinate records. Unsupported formats, oversized/empty files and parsing failures are separate UI error states; they must not be misreported as a successful search with no GPS tags. Parse-error reports are not exported as a completed analysis.

Metadata display/export is bounded to 500 flattened entries, depth 8 and 4,096 characters per long string; binary arrays and large arrays are summarized. The JSON report is a structured readable report, not a byte-for-byte dump of every proprietary metadata block. The user must explicitly click Export JSON to save it.

## Map behavior

A new session opens a neutral world overview without a location marker. GPS in the bundled Gainesville bounds gets the detailed dark red street map. Any other valid nonpolar GPS point gets its exact marker on a coarse world overview plus a clear message that detailed streets are not included for that location. Latitude beyond Web Mercator's approximately ±85.05112878° remains a valid coordinate result, but no inaccurate map marker is rendered.

An image without valid GPS cannot leave the prior photo's pin behind. Camera identity, people, residences and scene content are not inferred. Textual IPTC city/country labels are displayed as metadata, not silently geocoded into an exact address. Embedded GPS can be edited and is not proof of a photo's origin.

## Validation completed

The supplied Node suite passed **26 tests** in this environment, with zero failures or skips. The tests use the real pinned exifr library and synthetic image bytes, not a stub metadata extractor.

Covered cases include:

- JPEG, PNG, TIFF and WebP EXIF GPS; JPEG XMP-only GPS.
- N/W and S/E conversion, below-sea-level elevation, and valid `(0, 0)` coordinates.
- JPEG/PNG/WebP with no GPS, partial tags, missing references, invalid ranges and EXIF/XMP coordinate conflicts.
- Corrupt TIFF/WebP input, unsupported signatures, rational/hemisphere validation and DMS rounding.
- Worker message success and errors; bounded report serialization.
- Built-HTML checks for blocked network connections, no external script dependencies and no former model-init/identity-matcher commands.
- DOM interaction using JSDOM with the real parser: file selection, actual checksum, tag filtering, global/local map selection, clear/reset, no-GPS notice, stale async result suppression, invalid/oversized/empty files and safe filename rendering.

Run parser/core tests with:

```bash
node --test tests/metadata.test.cjs
```

Run the DOM test too, with Node 18+ and a local development install of `jsdom@26.1.0`:

```bash
npm install --no-save jsdom@26.1.0
node --test tests/metadata.test.cjs tests/ui.test.cjs
```

The DOM harness replaces map drawing with lightweight Leaflet state objects; it does not prove native canvas rendering or native browser Blob-worker startup. Full Chrome/Edge/Firefox/Safari end-to-end testing was not performed here. Native Windows launcher execution was not available; launcher syntax/line endings and Python compilation were checked. Fixture regeneration uses Pillow, which is optional and not a runtime dependency.

## Known limits and prioritized next work

1. **Native browser coverage.** Add end-to-end tests with actual Leaflet, Blob workers, file input/drop, preview decoding, clipboard and JSON downloads. Test both direct-file launch and the optional loopback server, including clear/new-file while parsing.
2. **HEIC/AVIF compatibility.** These formats are best effort, not fully validated here. The pinned exifr code has a known HEIF recognition guard that can reject longer `ftyp` boxes used by some newer iPhone files. Build consented/synthetic fixtures and fix or replace that container layer with tests; do not simply call a parse error “no GPS.”
3. **Parser hardening.** Fuzz malformed TIFF offsets, cyclic directories, oversized XMP and unusual RIFF chunks. Consider a required worker on supported browsers instead of the non-preemptible main-thread fallback. Keep file/metadata/time limits explicit.
4. **Report completeness.** Add an explicit truncation flag to reports and a UI note when flattening limits are reached. Add optional proprietary/binary metadata inspection without making large arrays freeze the interface. Clarify which tags each format exposes.
5. **Offline map expansion.** Support user-installed regional GeoJSON bundles with bounds/attribution validation. Do not silently fetch paid tiles, add a required API key or label the world outline as street-level coverage.
6. **Further metadata formats.** Add tested sidecar import, more RAW variants and compressed XMP support only behind clear format/status distinctions. Preserve source attribution for each coordinate candidate.
7. **Usability.** Add accessible keyboard/drag-and-drop tests, optional batch analysis with per-file status, and preview-derived pixel dimensions clearly labeled separately from embedded metadata. Preserve the explicit no-GPS state.

## Continuation prompt for the larger model

> Open the supplied Crimson Image Metadata source and read this handoff, README, BUILD_INFO and tests first. This is a working real metadata reader, not the earlier terminal animation. Run the tests before changing it. Preserve local-only processing, dark red styling, no-cost operation, the simple Windows launcher and exact embedded-GPS-only mapping. Never add a default location when GPS is absent or invalid. Start by adding real browser end-to-end coverage, then improve HEIC/AVIF container support using reproducible fixtures and strict malformed-input tests. Keep metadata absence, invalid/conflicting GPS, unsupported format and parse errors separate. Update the generated single-file HTML, tests, README and handoff after each completed change. Explain what was verified and any remaining limits. Do not introduce an LLM or paid map service merely to read EXIF tags.

## Primary references

- exifr documentation and source: <https://github.com/MikeKovarik/exifr> — pinned package 7.1.3, MIT license in `vendor/EXIFR_LICENSE.txt`.
- HEIF recognition discussion: <https://github.com/MikeKovarik/exifr/issues/138>.
- Leaflet: <https://leafletjs.com/> — bundled BSD-2-Clause license.
- Natural Earth world data and terms: <https://www.naturalearthdata.com/about/terms-of-use/>.
- OpenStreetMap data and license: <https://www.openstreetmap.org/copyright>.
