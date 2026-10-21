# META trace

**2.1.0-rc.1** is a release candidate for the local image-metadata instrument,
built on Crimson Image Metadata 2.0.0. It adds a dark red cinematic analysis
presentation while keeping real EXIF/GPS extraction and offline operation.

## Run on Windows

Clone or download this repository and double-click `START_WINDOWS.bat`.
You can also open `Qwen_Map_Console.html` directly, or run
`python3 RUN_CONSOLE.py` to serve the app on loopback.

Choose or drop an image, then press **Analyze**. No package installation,
model download, account, internet connection or map API key is needed to use
the app. Images are processed locally and are not uploaded.

## What changed

- Image acquisition, scan, metadata reveal and coordinate-settle sequence.
- Smooth map descent to street scale within the bundled Gainesville region.
- Pin lock, original synthesised sound cues, sound and volume controls.
- Cinematic, Fast and Reduced motion modes; Skip, Replay and Clean view.
- Cancellation of stale analysis, map movement and sound on a new file or Clear.
- Expanded logic and real-browser tests, with verification screenshots and limits.

The app maps validated embedded GPS only and reports **No location metadata
found** when GPS is absent. Incomplete, invalid and conflicting coordinates
remain separate outcomes. Copy and JSON export use the actual analysis report.

## Map and format coverage

Detailed streets cover part of Gainesville, Florida. Other valid GPS coordinates
use a coarse offline world overview with a coverage notice. Photographic Street
View and additional regional downloads are not included. GPS metadata can be
edited and is not proof of where a photograph was taken.

JPEG, PNG, TIFF and WebP GPS have synthetic test coverage. HEIC and AVIF remain
best effort. Inputs are limited to 64 MiB and processed one at a time.

## Development and verification

```bash
python3 build_metadata.py
node tests/run.cjs unit
```

For browser development tests, use Node 20 or newer:

```bash
npm install
npx playwright install chromium
node tests/run.cjs
```

The integration check ran **59 logic tests with no failures or skips**.
Claude's [verification report](docs/VERIFICATION.md) separately records 174
passing checks in headless Chromium and explains the limits of that run.
Windows, other browsers and real-speaker listening still need user verification;
the imported browser suite has not been rerun during this integration step.

Read [README.txt](README.txt) for complete controls and usage,
[HANDOFF.md](HANDOFF.md) for architecture and remaining work,
[CHANGELOG.md](CHANGELOG.md) for release changes, and
[SOURCES.txt](SOURCES.txt) for dependency and data attribution.

## Version history

| Ref | Version |
| --- | --- |
| `snapshot/terminal-map` | Archived staged terminal and map iteration |
| `v2.0.0` | Real local metadata reader |
| `v2.1.0-rc.1` | Cinematic release candidate, after tagging the imported commits |

The import preserves Claude's nine commits and adds a repository-integration
commit for this README and the combined ignore rules. The changelog import was
adjusted to update the file already present in the existing repository.
Older versions remain recoverable through the existing commits and tags.
