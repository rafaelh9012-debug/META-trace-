# META-trace

**Local Image Metadata Analysis & Geospatial Visualization**

META-trace is a privacy-focused image metadata analysis application featuring an interactive 3D globe, cinematic analysis sequences, and offline geographic visualization.

## Features

- Local EXIF, GPS, XMP, and IPTC metadata extraction
- Interactive dark-red 3D globe
- Cinematic globe rotation and coordinate descent
- Five-mile-by-five-mile geographic visualization
- Offline world overview and regional street maps
- Optional PMTiles geographic data packages
- SHA-256 file hashing
- Downloadable JSON metadata reports
- Animated scanning and analysis interfaces
- Reduced-motion and audio controls
- No account, external API key, or internet connection required

## Getting Started

### Windows

1. Download or clone the complete repository.
2. Run `START_WINDOWS.bat`.
3. Select an image.
4. Press **Analyze**.

Alternatively, open `META_trace_Console.html` directly in your browser.

### macOS / Linux

Open `META_trace_Console.html` or run:

`python3 RUN_CONSOLE.py`

## Offline Geographic Visualization

META-trace includes:

- A globally navigable 3D globe
- Offline world geographic data
- Detailed bundled Gainesville map coverage
- Optional regional maps using PMTiles
- A sample Florence, Italy geographic dataset

When valid GPS coordinates are embedded in an image, the globe performs an animated rotation and descends toward the recorded location.

The final view represents an approximately 5 x 5-mile area centered on the coordinates.

Geographic detail depends on the locally available map data.

## Privacy

Image analysis runs locally.

- No image uploads
- No external metadata-processing service
- No account requirements
- No external map API requests

GPS metadata can be modified and does not independently prove where an image was taken.

## Development

The repository includes application source code, offline geographic data, build tools, and automated tests.

Build the standalone application:

`python build_metadata.py`

Run unit tests:

`node tests/run.cjs unit`

Node.js 20 or newer is recommended for development.

## Documentation

- [Application Guide](README.txt)
- [Map Architecture](docs/MAP_ARCHITECTURE.md)
- [Map Data](docs/MAP_DATA.md)
- [Verification Report](docs/VERIFICATION.md)
- [Changelog](CHANGELOG.md)
- [Third-Party Sources](SOURCES.txt)

## Version Information

Distribution: META-trace 2.2.1

The packaged application's internal version identifier remains 2.2.0-rc.1 pending release metadata synchronization.
