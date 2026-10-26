# Globe and map architecture (2.2.0-rc.1)

This began as the plan the implementation followed and was written before the code, so each decision records what was known at
that point and how it was known. Where the build departed from the plan the text has been corrected to what was built (the
changelog lists the contract changes). Measured numbers are in section 9; the full test record is `docs/VERIFICATION.md`, and
`docs/MAP_DATA.md` is the guide to the data itself.

## 0. What the build environment allowed

The work was done in a sandbox with **no route to GitHub, npm, PyPI, CDNs or Natural Earth**. Every request to those hosts
was refused (HTTP 403 from the egress policy, or no connection). Consequences that shape everything below:

- The private repository could not be attached. The work continues from the local clone of 2.1.0-rc.1 (the delivered ZIP is
  the same tree). Nothing was pushed. Only Protomaps' documentation site could be read from the sandbox (and only through the
  fetch tool, not from the shell). Later in the work the public PMTiles repository (github.com/protomaps/PMTiles) could be
  attached, which supplied one real Protomaps basemap sample (central Florence); see section 3 and `data/samples/README.txt`.
- No third-party renderer could be downloaded, so none could be vendored, built or tested here.
- No finer Natural Earth data (50 m or 10 m), no rivers, lakes, roads, railways, regions or populated-places layers, and no
  OpenStreetMap extract other than the Gainesville one already in the repository could be obtained.

Anything in this plan that depends on those is either built so it can be used the moment the data exists, or reported as
not done. It is never faked.

## 1. Renderer: investigation and choice

| Candidate | Licence | Size | Fits this app? | How I know |
| --- | --- | --- | --- | --- |
| MapLibre GL JS 5.24.0 (globe projection built in) | BSD-3-Clause | `maplibre-gl.js` 1,056,837 B; CSP build 971,665 B plus a 457,880 B worker; CSS 70,024 B | Best off-the-shelf globe. Needs WebGL. It fetches style, glyphs and sprites over the network, so under `connect-src 'none'` every one of those would have to be re-routed through `addProtocol`. A global overview style and glyph PBFs would also have to be authored. | Version, licence, file sizes read from the published package listing today. Behaviour under the CSP is from its documented design, not tested. |
| three.js 0.179.1 (optionally with three-globe or globe.gl) | MIT | npm package 30.6 MB unpacked (a bundled core is far smaller; not measured) | A general 3D engine. Lines on a sphere, atmosphere, labels and LOD would all still be written by hand. | Read from the npm page today. |
| CesiumJS | Apache-2.0 | Large (workers, assets and widgets ship as static files) | Overkill for a laptop default package. Its imagery and terrain model assumes tile services. | Licence read today. Size and offline requirements not confirmed. |
| d3-geo (orthographic) | ISC | small | 2D projection only, no perspective camera. A copy exists on this machine but is not needed. | Present at `/opt/npm-tools`. |
| **In-house Canvas 2D perspective globe** | this repository | about 40 KB of source | Real 3D camera (position, orientation, perspective), horizon clipping, no WebGL requirement, nothing to download. | Written and tested in this work. |

**Choice: an in-house Canvas 2D globe.** Reasons, in order of weight:

1. It is the only option that could be built and tested here.
2. It needs no GPU. On a machine with a weak or blocked graphics stack a Canvas 2D page still works (Chrome has been
   removing automatic WebGL software fallback, so a WebGL-only globe can be a blank rectangle there).
3. The CSP stays exactly as it is. No new worker, no fetch, no style or glyph requests.
4. The camera is a pure function of three numbers (unwrapped longitude, latitude, altitude), which makes the full
   revolution and the five-mile fit directly testable.

Costs, stated plainly: no GPU shading, no terrain, polygon fills are clipped by hand against the horizon, and per-frame
vertex projection runs in JavaScript. Level-of-detail culling by bounding caps keeps that cheap, and the renderer measures
its own frame time and reduces its quality (glow, resolution, vertex budget) when it falls behind.

**Where MapLibre would fit later.** The globe sits behind a small interface (`setCamera`, `draw`, `project`, `unproject`),
so a MapLibre globe could replace it when someone can supply the library and style. That is not done and not promised.

## 2. Offline data: formats and the three tiers

### Formats considered

| Format | Licence of spec / reader | Progressive loading | Notes |
| --- | --- | --- | --- |
| GeoJSON / TopoJSON | open | none: whole file parsed into RAM | Fine for small overview data. Not for archives. |
| MBTiles | SQLite; needs a SQLite build in the page | yes | Would need sql.js or similar (a WASM download). |
| FlatGeobuf | BSD-2 | yes, with a spatial index | Good for features, no tile pyramid, no standard styled basemaps. |
| **PMTiles v3** | spec public domain / CC0; reference implementations BSD-3 (read from the project README today) | **yes: header, then a directory, then individual tiles by byte range** | Single file. Works from a local `File`/`Blob` with `slice()`. Carries Mapbox Vector Tiles. Regional files can be cut from larger ones with existing tools. |

**Choice: PMTiles v3 containing gzip-compressed MVT tiles**, read by a small reader written for this app (header 127 bytes,
varint directories and the Hilbert tile ID were checked against the specification's published test values).

### Why a plain `fetch` is not used

The content-security policy is unchanged (`connect-src 'none'`) and must stay so. A package is therefore read from a
`File`/`Blob` the person chose: `blob.slice(offset, offset + length).arrayBuffer()` is not a network request. The first
time, the person chooses the `.pmtiles` file. The app can also keep a copy in IndexedDB (browsers store large blobs as files
on disk, not in RAM) so later sessions need no picker; that is a choice, on by default when storage is available, never for
files over 512 MiB, and checked against the storage quota. If storage is refused or declined, the file works for that visit
only and the app says so.

### The tiers

1. **Bundled world pack (always present, inline in the HTML).** Whatever global vector data the repository can honestly
   contain. In this build that is Natural Earth 1:110 m admin-0 (already shipped, public domain): land polygons, a
   coastline and a national-border set derived from them (an edge shared by two countries is a border; an unshared edge is
   coast), 177 country labels, and about 400 reference cities taken from the IANA time-zone database (public domain; one
   city per zone region, so it is *not* a ranking of the largest cities and is labelled that way). Expected cost: well under
   1 MB of JSON.
   **This build cannot provide lakes, rivers, regions or transport at world scale**, because that data could not be
   downloaded. `tools/build_globe_pack.py` accepts Natural Earth GeoJSON for coastline, admin-0, admin-1 lines, lakes,
   rivers, roads, railways and populated places at any scale; run it on a machine that can reach the data and rebuild.
2. **Built-in street detail.** The existing OpenStreetMap extract for Gainesville/UF stays inline exactly as in 2.1.0.
3. **Optional regional packages (`.pmtiles`).** Installed from the new Map data panel. Drawn in the flat map at street
   scale through the same canvas layer as the built-in streets. Read lazily: header, root directory, then only the tiles in
   view; decoded tiles live in a small LRU cache (220 tiles or 56 MiB of decoded geometry), so memory does not grow with the
   file. `tools/make_pmtiles.py` makes a package from GeoJSON in the app's own street format (it is not an OpenStreetMap or
   Natural Earth pipeline); a real regional basemap is cut from a Protomaps build with their `pmtiles extract` command, which was
   not run here. No package is built into the page. One real Protomaps basemap archive (central Florence, 6.6 MB, copied
   unchanged from the PMTiles repository) is kept in `data/samples/` as a sample and as the test input for real-file reading.

Packages are never required, never fetched by the app, and each has a stated size, bounds and licence in its own metadata.

### What the app will not claim

No worldwide street or building detail. A coordinate outside every installed package gets the world overview, the
five-mile frame, a coverage line saying which layers exist, and the button to add a package.

## 3. Camera model

One camera drives everything: `{longitude (unwrapped, degrees), latitude, altitude (metres above the surface)}`, north up.
A perspective projection with a focal length set by the smaller viewport side makes the visible field the same on any
window shape.

- `scale at the target = altitude / focal length` metres per pixel, which is also exactly Leaflet's scale at the final view,
  so the two renderers can be matched numerically at the hand-off.
- Longitude is stored **unwrapped**. The sequence never normalises it, so no easing function can take a shorter path.
- Polar views need no special case: the north-up direction is `d(position)/d(latitude)`, which is defined and continuous
  even at ±90°.

### Hand-off to the flat map

The globe descends until the ground scale is about one kilometre per pixel (lower at high latitude, so that Mercator's
stretching across the window stays under about 4 %). Leaflet is then positioned on the same centre and scale underneath, the
two cross-fade over 0.45 s while both are updated every frame, and Leaflet continues the same zoom curve to the final
frame. At that scale both views draw the same land polygons in the same colours with the same edge interpolation (straight
in Mercator space, as the existing layer does), so there is no reset.

Latitudes beyond ±85.0511° cannot be shown by Web Mercator. Those targets keep the globe as the final renderer (top-down,
north-up) with its own frame, scale bar and coverage message.

## 4. The five-mile frame

The frame is a square target frame drawn over the map, centred on the coordinate, with side `S` pixels
(`S = min(width, height) − margins`, clamped). The fit is computed, not a zoom constant:

- ground metres per degree from the WGS84 ellipsoid at the target latitude (`M(φ)` for latitude, `N(φ) cos φ` for longitude);
- half-extent 2.5 mi = 4,023.36 m, full extent 8,046.72 m;
- zoom so that the frame spans 8,046.72 m on average across its two axes (Web Mercator is conformal on a sphere but the
  ellipsoid makes the vertical ground extent differ from the horizontal by up to 0.67 % at the equator, 0 at the poles);
- bounds from the local linearisation, with longitude unwrapped across the antimeridian.

The check does not trust that arithmetic: the browser test asks Leaflet where the frame's four edge midpoints are, then
measures the distances between them with an independent method (Vincenty on WGS84 in the app's diagnostics and a haversine in
the test). Tolerance 0.75 % (about 60 m) for the mean extent; both axes are reported.

## 5. Animation plan (cinematic profile)

Times are for the sequence after the existing analysis beats (acquire 0.3 s, scan 0.9 s, reveal 1.0 s, resolve 0.6 s, which are
unchanged).

| Phase | Time | What moves |
| --- | --- | --- |
| attention | 0.0 – 0.9 s | the globe takes the stage, rotation accelerates from its idle rate, a gentle pull-back shows the whole sphere |
| revolution | 0.0 – 4.8 s | camera longitude sweeps `360° + Δ` westward (the surface turns eastward, like the real Earth), where `Δ` is the remaining distance to the target meridian. Quintic Hermite easing starting at the idle speed and ending at rest: accelerates, peaks near 1.9× the mean speed, decelerates onto the target meridian |
| orientation | 0.8 – 4.6 s | latitude eases from the current value to the target's; north stays up; a faint target reticle appears as the target nears the centre |
| descent | 3.7 – 8.0 s | altitude falls continuously, interpolated in log space with ease-in-out, from about three Earth radii to the five-mile scale; layers and labels reveal on the way |
| hand-off | at about 1 km/pixel | Leaflet takes over invisibly (see above) |
| lock | final 0.5 s | reticle collapses onto the point, ring pulse, frame brackets close, confirmation sound |

The camera sequence is 8.0 s in the cinematic profile (11.5 s with the analysis beats before it and the 0.7 s lock after).
**Fast** keeps the same story, *including the full revolution*, in 3.4 s of camera time (5.07 s in all), so the turn is faster, not
shorter. **Reduced** (and the system "reduce motion" setting) makes no camera movement: a short cross-fade to the final view
(about 0.8 s in all). **Skip** goes to the final view at once from any moment.

Sound follows the camera: a spin cue tied to the rotation speed, a falling sweep over the descent, a soft blip per level of
detail, then the existing lock and confirm cues. Mute, volume and gesture unlock behave as before; cancelling the
sequence fades every voice out.

Cancellation sources: new image, Clear, Replay, Skip, manual drag/zoom/keys on the globe or map, tab hidden.

## 6. Interaction

- Globe: drag to rotate (with short inertia unless motion is reduced), wheel or pinch to change altitude, arrow keys and
  `+`/`-`, Home recentres on the result (or the default pose). The canvas is focusable and labelled.
- A Globe/Map switch in the map controls moves between the two renderers at the same place and scale.
- Idle: slow rotation (about 4°/s) only when nothing is selected; none under reduced motion; it stops while the tab is hidden.

## 7. Verification plan

Unit: camera maths, frame fit, unwrapped revolution (no per-step change of 180° or more), easing monotonicity, PMTiles reader
against the specification's test values and against files written by this repo's writer, MVT decoder, offline loading with
`fetch` unavailable. Real browser: a measured revolution, centring and frame distances at several latitudes, both hemispheres,
equator, antimeridian, polar, offline with requests blocked, missing package, Skip/Replay/Clear/replacement during rotation
and descent, muted/blocked sound, reduced motion, six layouts, frame timing, memory and storage. The existing tests were kept;
tests whose subject changed on purpose were updated and are listed in the changelog. What was run, with numbers, is in
`docs/VERIFICATION.md`.

## 8. Honest limits (known in advance)

- Default world data is 1:110 m. Finer or richer global data needs the build tool and data this environment could not reach.
- PMTiles reading is verified against files this repository writes, against the specification's values, and against **one**
  real Protomaps basemap archive (central Florence, basemap 3.7.1). Nothing else third-party has been read: no other area, no
  other Protomaps version, no OpenMapTiles archive, and no output of `pmtiles extract` itself (the command could not be run).
  Reading that real file found a defect that the synthetic packages could not show (Protomaps prefixes its properties with
  `pmap:`, which the adapter did not read, so most of a real tile was ignored); it is fixed and tested.
- Canvas 2D, software-rendered headless Chromium is the only graphics stack tested. No GPU, Windows, Edge, Firefox or Safari.
- Sounds are measured, not heard.
- Package labels are drawn from the package's own tiles, where roads are named along their longest stretch inside a tile; a
  road crossing many tiles can be named more than once, subject to the layer's collision rules. Real Protomaps names were drawn
  for the Florence sample only (streets, places, landmarks, businesses, rivers); other areas, scripts and name languages were not seen.
- Two packages that overlap are not merged: the one with the smaller coverage owns each tile (ties go to the later one).
- A package that crosses the antimeridian as a single box cannot be described in PMTiles bounds; it must be split in two.

## 9. Measured

Headless Chromium 141, software rasterisation, 1440 x 900, from the final recorded run (details and the test behind each line
are in `docs/VERIFICATION.md`; the map data numbers are in `docs/MAP_DATA.md`). These are what happened on that machine, not a
performance claim.

| What | Result |
| --- | --- |
| Revolution (Gainesville) | 406.2 degrees swept (a full turn plus the 46.2 remaining), never turning back, the whole globe in view while it turns |
| Cinematic sequence | 11,554 ms for a plan of 11,500 ms (fly 8,009 ms, lock 708 ms) |
| Frames in the flight | 455; median interval 16.7 ms, 95th percentile 33.3 ms, worst 33.5 ms |
| Hand-off | globe 1,046 m per pixel, Leaflet 995 m per pixel (ratio 0.951; required 0.9 to 1.1); centres agree to 0.01 degrees; hands over once |
| The five-mile frame, 14 places | each side within 0.34 % of 5 miles (sides differ in opposite directions, mean 5 miles); point within 3.7 m of the centre; both hemispheres, equator, antimeridian, 69.6 to 78.2 degrees, 85 N, both poles |
| Slowed processor (6x) | sequence kept its clock, 406.6 degrees swept, median frame 66.7 ms, worst 216.6 ms; the globe's own quality control did not need to step down |
| Globe draw cost | 5.6 ms average per frame under the 6x slowdown |
| Street layer redraw | 0.1 to 0.9 ms median (worst 1.4 ms) at zoom 11 to 19 on the full bundled data, after a 127 ms one-time build |
| Page weight | 4,723,697 bytes (921,394 gzipped), up from 4,227,641 in 2.1.0-rc.1 |
| JS heap | 19.8 MB at rest, 15.4 MB after two full runs |
| Package cache | 520-view tour of a 2.85 MB, 3,553-tile package: 593 reads, 409 evictions, 199 tiles resident (2.1 MB), heap 66 to 55 MB |
| Gainesville as a package | 597,138 bytes, 80 tiles, 12,671 features; draws the same picture as the bundled renderer to within 0.3 % of the pixels |

What these numbers do not cover is listed at the end of `docs/VERIFICATION.md`: no GPU, no Windows or other browsers, no real
third-party package, sounds measured but not heard.
