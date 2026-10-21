# Crimson Image Metadata

A free, offline image-metadata inspector with a dark red map and analysis interface.

## Run

Download or clone the project, then double-click `START_WINDOWS.bat` on Windows.
You can also open `Qwen_Map_Console.html` directly, or run
`python3 RUN_CONSOLE.py` for a loopback-only local server. No package installation,
map API key or model download is needed to use the application.

Choose or drop an image. The application reads embedded EXIF/GPS/XMP data locally,
validates coordinate pairs and places a marker when valid GPS is present.
It explicitly reports **No location metadata found** when no GPS coordinate pair
is embedded, and distinguishes incomplete, invalid, conflicting and unreadable data.
Copy coordinates or export a JSON report using the result controls.

## Scope

- JPEG, PNG, TIFF and WebP GPS have synthetic test coverage; HEIC/AVIF are best effort.
- Inputs are limited to 64 MiB and processed one at a time. Images are not uploaded.
- Detailed streets are bundled for part of Gainesville, Florida. Other valid GPS
  coordinates use a coarse offline world overview. Polar results retain numeric
  coordinates when the map projection cannot display them.
- GPS tags can be edited and are not proof of where a photo was taken.

## Development

```bash
python3 build_metadata.py
node --test tests/metadata.test.cjs
```

For the DOM regression test, install the optional development dependency:

```bash
npm install --no-save jsdom@26.1.0
node --test tests/metadata.test.cjs tests/ui.test.cjs
```

Read [HANDOFF.md](HANDOFF.md) for the architecture, verified behavior, remaining
limitations and a continuation prompt for a larger model. [README.txt](README.txt)
has full end-user instructions. Dependency and data attribution is in
[SOURCES.txt](SOURCES.txt).

## Recovering iterations

The Git history preserves both available project snapshots as separate commits.

| Ref | Contents |
| --- | --- |
| `snapshot/terminal-map` | Archived earlier staged terminal and offline map application |
| `v2.0.0` | Real metadata extraction, GPS validation, missing-location notices and handoff |

Use `git log --oneline --decorate` to see the history. To inspect the older
iteration without changing the current folder:

```bash
git worktree add ../crimson-terminal-map snapshot/terminal-map
```

Future iterations should be ordinary commits. Keep original image inputs and
exported location reports outside the tracked source; synthetic fixtures are
included in `tests/fixtures`.
