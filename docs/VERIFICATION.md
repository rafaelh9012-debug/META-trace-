# Verification report — META trace 2.1.0-rc.1

This says what was actually run, what it showed, and what was not checked. Nothing here is a claim about a machine
other than the one described.

## Environment

| | |
| --- | --- |
| Machine | Linux 6.18 container, no display, no audio output device |
| Browser | Chromium 141.0.7390.37 (Playwright 1.56.1), headless, software rasterisation |
| Node / Python | Node 22.22.0, Python 3.13 |
| Page under test | the built single file `Qwen_Map_Console.html`, opened from `file://` (and once over `http://127.0.0.1` through the real `RUN_CONSOLE.py`) |
| Not available | Windows, Edge, Firefox, Safari, a GPU, speakers, a headed browser, the GitHub repository (see HANDOFF.md) |

Playwright and Chromium are development tools only. The app has no runtime dependency.

## Result

The run that produced the screenshots and timings in `docs/verification/` (`node tests/run.cjs` with
`META_TRACE_ARTIFACTS` set) finished with **173 tests, 173 passed, 0 failed, 0 skipped, in 352 s**. One test (the
fullscreen button) was added after it. The suite was then run again on the committed tree, from a fresh `git clone` of it
(so nothing depended on an uncommitted file): **174 tests, 174 passed, 0 failed, 0 skipped, in 359 s**. That clone was at
commit `d291330` (hashes are those of the delivered patch series); everything committed after it changes documentation
only. Rebuilding the HTML from the committed sources in that clone reproduced `Qwen_Map_Console.html` and
`BUILD_INFO.json` byte for byte (SHA-256 `52fd328a…`, 4,227,641 bytes).

| File | Tests | What it covers |
| --- | ---: | --- |
| `metadata.test.cjs` | 25 | The baseline suite: parser, coordinate validation, statuses, worker, built-HTML checks. Unchanged from 2.0.0. |
| `presentation.test.cjs` | 18 | The presentation state machine on a fake clock: order, skip, cancel, replay, waiting for the report, errors, disposal. |
| `map-director.test.cjs` | 16 | Camera decisions against a fake map: classification, short-way longitude, arrival, interruption, rest, jump, recenter. |
| `audio.browser.test.cjs` | 24 | Every cue rendered offline in Chromium and measured; stop behaviour; muted, blocked, missing and throwing audio. |
| `layer.browser.test.cjs` | 6 | The canvas base map against Leaflet's own projection and drawing. |
| `browser.test.cjs` | 35 | Whole flows in the real built page (see below). |
| `browser-cancel.test.cjs` | 13 | New file, Clear, Skip, Replay at awkward moments; slow reads; a rapid-fire stress run. |
| `browser-env.test.cjs` | 24 | Sound states, reduced motion, offline, CSP, missing street data, hidden tab, six layouts, touch targets. |
| `contrast.test.cjs` | 11 | WCAG ratios from the tokens and from every visible text element in seven live states. |
| `launcher.browser.test.cjs` | 1 | The real Python launcher serving the page to a real browser. |

### What the whole-flow tests establish

- The exact stated values appear and are plotted: 29.64885278, -82.33788889, elevation 47.46 m, error 12.5 m, SHA-256
  equal to the file's real hash; the pin and the camera end on the recorded coordinate to 1e-9 degrees at zoom 18.
- Every non-located status (no GPS, partial, missing reference, invalid, conflicting with both candidates listed,
  read failures, unsupported, empty, 65 MiB) gets its own message, no pin, and no coordinates.
- Outside the bundled streets the exact point sits on the world overview at zoom 5 with the coverage note. With the
  street data removed from the page, the same file also ends on the overview rather than flying into a blank map.
- 85 degrees is plotted. 89.5 north and south show the numbers with "GPS found near a pole" and no pin.
- Antimeridian: from a camera 30 degrees away, the flight travels about 30 degrees, not 330, in both directions, and
  ends on the true longitude (checked by sampling the camera every 25 ms).
- Cancelling is total: choosing a file or pressing Clear during the scan, the flight or the sound leaves no pin, no
  coordinates, no table, no camera movement afterwards, and silences every voice within 400 ms (voices fade out over
  about 40 ms). A read that finishes after the person has moved on is discarded.
- Replay performs no second file read and no second worker. Skip at any stage, including before the file has been read,
  ends in the same state as a complete run.
- For a located result the export contains exactly the baseline report keys and no presentation state.
- With sound blocked, missing, muted or throwing, the result is identical and the run is not slowed. Muted creates zero
  audio nodes. Reduced motion has no intermediate camera zoom at all.
- No request ever leaves the page: every whole-flow, cancellation and environment scenario asserts that. The CSP refuses fetch, WebSocket, a cross-origin worker,
  `data:` workers, eval, remote images, remote scripts and frames.
- No console error or warning in any scenario.

### Timing, measured (headless Chromium, software rendering — not a performance claim)

Cinematic profile, 1440 x 900, final run:

| Beat | Planned | Measured |
| --- | ---: | ---: |
| acquire | 300 ms | 283 ms |
| scan | 900 ms | 904 ms |
| reveal | 1000 ms | 1001 ms |
| resolve | 600 ms | 602 ms |
| fly | 2900 ms | 2934 ms |
| lock | 500 ms | 509 ms |
| whole sequence | 6200 ms | 6233 ms |

During the flight: 139 frames, median frame interval 16.7 ms, 95th percentile 33.4 ms, worst 66.7 ms. A GPU-less
software renderer is probably slower than a real device here, but this has not been measured on one. Redrawing the
street layer took a median of 0.1 to 1.1 ms (worst 3.1 ms) at zoom 11 to 19 on the full bundled data.

### Sound, measured, not heard

The cues were rendered offline and measured. Peaks at default settings: intake -20.2 dBFS, tick -28.3, resolve -14.7,
lock -17.5, neutral -16.2, error -13.7, confirm -18.2, descend -14.7. At full volume every cue stays under -5 dBFS.
All cues end silent with no DC offset. **Nobody has listened to them.** Whether they sound good, are too quiet or too
loud on real speakers, or are annoying after the tenth analysis, needs a person with speakers.

### Contrast

Text colours on every surface they are used on: between 5.1:1 (the accent on the raised surface) and 16.9:1 (body text on
the darkest surface); the accent, used for small highlights, is the closest to the 4.5:1 line. In the live app, the lowest measured ratio of any visible text was 6.19:1 across seven states.

### Layout

Idle, scanning, located and no-location states were checked at 1440 x 900, 1180 x 800, 1024 x 768, 768 x 1024,
720 x 900 and 390 x 844 for sideways page scroll, controls leaving the window, clipped button text and a usable map.
At phone width every primary control is at least 44 px in one direction. Screenshots are in `docs/verification/`
(palette-optimised copies of the test screenshots, to keep the repository small).

### Mutation checks (done by hand, each mutant caught, real code restored)

| Break introduced | Caught by |
| --- | --- |
| Flights not unwrapped across the antimeridian | `antimeridian…` (camera moved 329.9 degrees, limit 40) |
| Stale-read guards removed in `runAnalysis` | both "a read that finishes after…" tests |
| Tag-table guard removed | "typing in the tag filter before the reveal…" |
| A 600 px-wide Analyze button | the 390 px layout test |
| Muted text colour made too dark | the token and live contrast tests |
| Arrival tolerance set back to 1e-7 degrees | the director's sub-pixel arrival test (other director tests also failed in that run, so only that one is claimed) |

## What this does not show

- It has not been run on Windows, Edge, Firefox or Safari, on a real GPU, or in a headed browser. `START_WINDOWS.bat`
  was not executed (it is unchanged from 2.0.0); `RUN_CONSOLE.py`, which it starts, was.
- The hidden-tab behaviour was tested by dispatching the `visibilitychange` event with `document.hidden` forced true,
  not by switching real tabs.
- Drag and drop was tested by dispatching drag events carrying real `File` objects, not by dragging from a file manager.
- The 65 MiB limit was tested with a sparse file; real large photographs were not used.
- HEIC and AVIF were not re-tested; that code is untouched.
- Screen-reader output was not listened to. Live-region text and `aria-hidden` on decoration are asserted, not heard.
- Frame timing says nothing about how smooth it is on the owner's machine.

## Reproduce

```bash
npm install                      # development only: Playwright 1.56.1
npx playwright install chromium
node tests/run.cjs               # all, serially (about six minutes)
node tests/run.cjs unit          # logic tests only, no browser
META_TRACE_ARTIFACTS=out node tests/run.cjs browser   # also writes screenshots and frame-timing.json to ./out
```

Without Playwright every browser test is reported as skipped with the reason, not as a pass.
