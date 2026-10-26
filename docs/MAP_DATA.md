# Map data: adding streets and buildings for other places

META trace works with no map data beyond what is inside the page. That gives it a world overview (coastlines and country
borders), 177 country names, 418 reference cities, and street-level detail for Gainesville, Florida. For any other place it draws the
overview and the exact GPS point, and says so. To see streets and buildings elsewhere you add a **map package**: one file,
stored on your computer, that you choose in the Map data dialog.

Nothing is downloaded or uploaded by the app. The page's security policy still forbids every network request
(`connect-src 'none'`); a package is read from the file you chose, a few kilobytes at a time.

## What is built in, and what is not

| | Where | What it holds | Source and licence |
| --- | --- | --- | --- |
| World overview | inside the HTML | land, coastlines, country borders, 1:110 m | Natural Earth, public domain |
| Reference cities | inside the HTML | 418 places, one per IANA time-zone region (not a list of the largest cities); 177 country names |  IANA time zone database, public domain |
| Gainesville streets and buildings | inside the HTML | 12,671 features in a box about 2.5 km by 2.4 km (29.638 N to 29.659 N, 82.351 W to 82.324 W) | OpenStreetMap contributors, ODbL, data dated 2026-10-16 |
| Map packages | files you add | whatever the package holds, for the area it covers | the package's own metadata |
| Sample package: central Florence | `data/samples/protomaps-basemap-firenze.pmtiles`, not inside the HTML | a real Protomaps basemap for 11.221 E to 11.288 E, 43.745 N to 43.789 N: 6.6 MB, 92 tiles, zoom 0 to 15 | OpenStreetMap contributors, ODbL; copied unchanged from the PMTiles project (`data/samples/README.txt`) |

**Not included:** worldwide streets, buildings, rivers, lakes, regional boundaries or railways. A worldwide street dataset
is not small: Protomaps documents its full-planet basemap as roughly 120 GB to zoom 15
(<https://docs.protomaps.com/basemaps/downloads>, read 2026-10-21; not measured here). It cannot be bundled and the app does
not pretend to have it. The default package stays small (4.7 MB for the whole page); anything larger is optional.

## Adding a package

1. Open **Map data** (the layers button on the map, or **Add map data** in the note under the map when a place has no street
   data).
2. Choose **Add a .pmtiles file**. The file is checked first (a PMTiles v3 archive of vector tiles, readable compression,
   layers the map draws). If it is refused, the dialog says why and nothing is added.
3. It is drawn wherever it covers, at the next redraw. The note under the map names the package whenever it is the source of
   the streets at the located point, with its credit.

**Keep a copy in this browser** (on by default where the browser allows it) stores a copy of the file in the browser's own
storage, so the package is there the next time you open the page. That copy uses as much disk space as the file. Files over
512 MiB (537 MB) are never copied: they are used from where they are for this visit only. If the browser has no room or no storage,
the package lasts for this visit and the dialog says so. **Remove** forgets the package and its copy; the file you chose is
never touched.

The copy lives in the browser's storage for this page's origin. For a page opened from a file, that origin is shared with the
other local pages you open the same way, and clearing site data removes the copies.

## Making a package

### From a Protomaps basemap (recommended for a real region)

Protomaps publishes planet builds in PMTiles format and a command-line tool, `pmtiles`, that cuts a region out of one
without downloading the rest (<https://docs.protomaps.com/pmtiles/cli>, read 2026-10-21):

```
pmtiles extract SOURCE.pmtiles my-city.pmtiles --bbox=MIN_LON,MIN_LAT,MAX_LON,MAX_LAT --maxzoom=15
```

`SOURCE` can be a local file or a URL; it must be a clustered archive. Daily builds are listed at
<https://maps.protomaps.com/builds>. `--maxzoom` keeps the extract small (a full pyramid down to that zoom needs little
I/O). Zoom 14 or 15 is the most this app uses: the five-mile view is at about map zoom 13 to 14, and you can zoom in
further by hand, where the last level is drawn larger.

**What was and was not run.** The `pmtiles extract` command above comes from Protomaps' documentation and was **not run**: the
sandbox this was built in could not reach the internet. One real Protomaps basemap archive was read, though: the sample that
the PMTiles project publishes for central Florence (`data/samples/`, Protomaps Basemap 3.7.1, 92 tiles, zoom 0 to 15). It is
not a worldwide map and it adds nothing outside its own box of about 5.3 km by 4.9 km; it is the one piece of real third-party data that
could be obtained, and it is what the reader, decoder and schema adapter are now checked against. Reading it found a real
defect, which is fixed: Protomaps writes its feature properties with a `pmap:` prefix (`pmap:kind`, `pmap:kind_detail`,
`pmap:min_zoom`), which the adapter, written from the documentation, did not read. Without that, only 41.7 % of the features
were drawn (buildings and business names), and the roads, rivers, rail, parks and place names, which are what a person looks
for in a map, were not. The five-mile view of Florence had 1,593 bright line pixels then, with no names at all; it has 32,061 now,
with the Arno, Torrente Mugnone and 25 places named.

What is drawn from a Protomaps basemap, with the counts from the Florence sample (136,928 features in all; 117,437, or 85.8 %,
are drawn):

| Protomaps layer | Features in the sample | Drawn | What it becomes |
| --- | ---: | ---: | --- |
| `buildings` | 31,041 | 30,808 | filled footprints; names at close zoom (building parts are skipped: they repeat the outline) |
| `roads` | 9,424 | 8,643 | lines by class (motorway down to service roads and paths) and the street names, along the longest stretch inside a tile; sidewalks, crossings, platforms and ferries are skipped |
| `transit` | 2,641 | 2,519 | rail, subway and tram lines |
| `water`, `physical_line`, `physical_point` | 295, 1,714, 99 | 295, 482, 19 | water areas; rivers, streams and canals as lines with their names (drains and ditches are skipped); named water bodies |
| `landuse`, `landcover`, `natural` | 11,691, 38,867, 804 | 8,935, 33,054, 790 | green areas, paved areas, parking, water; the other land-use kinds are not drawn |
| `places` | 2,450 | 2,450 | city, town, village, suburb and neighbourhood names |
| `pois` | 37,626 | 29,442 | named businesses, landmarks and stops with their names at close zoom; unnamed points are drawn only if they are trees, street furniture, bus stops or parking |
| `boundaries`, `earth` | 184, 92 | 0 | not drawn (administrative boundaries; the globe's own land is drawn underneath) |

Names are the file's `name` property, which Protomaps fills with the local-language name (Italian in Florence); a package
built with a different name language shows that language. When a tile holds more names than the map will place (500 per tile),
the most important are kept: street names before businesses, and within the same importance the one Protomaps ranks higher
(its own `min_zoom`). A name is checked for overlap at its whole width (up to 360 px), so a long business name hides the shorter ones
beneath it rather than running under them.

Measured on the Florence sample (Node, one thread): all 92 tiles decode and adapt without a failure, in 13.3 ms per tile on
average and 228 ms for the slowest (the densest tile). Nothing else from a real Protomaps build has been read, so another
version of the basemap, another region or another script may differ; `tile-schema.js` is the one file that decides how layers
and properties become drawing kinds, and `tests/tile-schema.test.cjs` and `tests/real-protomaps.test.cjs` show how to add a case.

OpenMapTiles-schema tiles (`transportation`, `building`, `water`, `landuse`, `poi`, `place`) are read as well, but only on the
description of that schema: no real OpenMapTiles archive was read.

### From GeoJSON in this app's format

`tools/make_pmtiles.py` (Python standard library only) converts GeoJSON features with `properties.kind` of `road`, `building`,
`green`, `parking`, `paved`, `water`, `barrier`, `tree`, `furniture`, `bus` or `poi` into a package. It is how the Gainesville
numbers below were measured:

```
python3 tools/make_pmtiles.py data/map-data.json -o gainesville.pmtiles --name "Gainesville (bundled data)" ^
    --attribution "(c) OpenStreetMap contributors" --license "ODbL 1.0"
```

It is not an OpenStreetMap pipeline. It generalises lower zooms (minor features wait for their zoom; lines are simplified to
half a pixel of a 512 px tile) and writes the top zoom unsimplified.

## What a package must be

- PMTiles **version 3**, vector tiles (**MVT**). Raster archives and MapLibre Tile (MLT) archives are refused.
- Tile and directory compression **none or gzip**. Brotli and zstd archives are refused with that reason (the browser has no
  decompressor for them that does not need a download).
- At least one layer the map draws, when the package lists its layers.
- Bounds that fit between -180 and 180 degrees. A package that crosses the antimeridian as one box cannot be described in
  PMTiles bounds; split it into an east and a west file (the app joins them at the seam; this is tested).
- Credit in the package's `attribution` metadata, which the app shows in the dialog and in the note under the map.

## How it is drawn

- The tile zoom follows the map zoom: one level finer than the rounded map zoom, within the package's own range. Past its
  maximum the last level is drawn larger.
- When the zoom crosses a level, the previous level stays on screen until the new one is in, so there is never a hole or a
  mix of two levels. If the new level takes more than 0.9 s, it is swapped in as it is.
- Tiles are read when the view needs them, a couple at a time, decoded between frames, and kept in a cache limited to 220 tiles
  and 56 MiB of decoded geometry, whichever comes first. The least recently used tiles that the view does not need go first.
- While the globe turns, the tiles for the target's final view are already being read, so the map arrives drawn.
- Where two packages overlap, the one with the smaller coverage owns each tile; ties go to the later one.
- A package whose box covers all four corners of the bundled Gainesville area down to zoom 14 replaces the bundled streets
  there (they would be drawn twice). A package that is coarser, or covers only part of that area, does not.
- **Nothing is drawn that is not in the data.** If a package's box includes the located point but its tiles hold nothing in the
  five-mile frame, the note says so instead of claiming streets.

## Size, disk and memory

What the default package, the page itself, holds (raw sizes of the inlined files; the remainder is the application's own code,
styles and markup, found by difference):

| Part | Bytes (about) | Notes |
| --- | ---: | --- |
| Gainesville streets and buildings (`map-data.json`) | 3,294,727 | 12,671 features |
| Gainesville names (`map-labels.json`) | 209,975 | 1,657 label candidates |
| World overview (`world-data.json`, `world-labels.json`) | 230,931 | Natural Earth 1:110 m, 177 countries |
| Globe pack (`globe-pack.json`) | 299,237 | coastline, borders, 418 reference cities |
| exifr, Leaflet | 238,206 | the parser and the flat-map library |
| Application code, styles, markup | about 450,600 | by difference |
| **The page** | **4,723,697** | 921,394 gzipped (Node zlib, level 9); about 4.5 MiB |

That is the "practical default": one file, no install, nothing to download. Detail for other places is optional and costs
what the package costs:

- **Download size** is the size of the package file you obtain. The app downloads nothing itself. A Protomaps planet build is
  documented at about 120 GB to zoom 15; a city is a small fraction of that. The Gainesville conversion below is 0.57 MiB; the
  synthetic metropolitan test pattern is 2.7 MiB.
- **Disk** is the file you chose (wherever you keep it) plus, if you let the app keep a copy, the same size again in the
  browser's storage (never for files over 512 MiB; checked against the free quota with 64 MiB left over).
- **Memory** does not follow the file's size. A package is read tile by tile, two at a time, into a cache of at most 220
  decoded tiles or 56 MiB, whichever comes first. The tour below read 2.51 MB through that cache without the heap growing.

## Measured

All numbers are from the final recorded run of headless Chromium 141 with software rasterisation on the build machine; they
show what happened there and are not a performance claim for other machines. The packages used for sizes and timing are the
Gainesville conversion (real OpenStreetMap data) and synthetic street grids (generated test data, flagged as such in their
metadata and in the app).

| Package | Size | Tiles | Features | Notes |
| --- | --- | --- | --- | --- |
| Gainesville, converted from the bundled data, zoom 9-16 | 597,138 bytes (0.57 MiB) | 80 | 12,671 | converter 1.5 s; the bundled JSON for the same features is 3,294,727 bytes (plus 209,975 bytes of labels) |
| Synthetic metropolitan test pattern, 0.5 x 0.5 degrees, zoom 9-15 | 2,854,848 bytes (2.7 MiB) | 3,553 | 275,984 | for the cache and memory tour only |

Cache and memory, from the scripted tour (520 views at zoom 15 across the 3,553-tile synthetic package, in the page):

- 593 tiles were read and 409 evicted; 199 tiles stayed in the cache (about 2.1 MB of decoded geometry); 2.51 MB of the
  2.85 MB file was read in total, tile by tile, and no tile failed.
- Decode 87 ms and adapt 63 ms in total over all 593 tiles; the slowest single tile took 55 ms from request to ready.
- Drawing the package's tiles took 0.12 ms on average per redraw and 1.3 ms at most, as sampled after each view.
- JS heap: 66 MB before the tour, 55 MB after it (garbage collection ran); it did not grow.

The bundled Gainesville data drawn as a package matches the original picture to within 0.3 % of the pixels at the street
zoom (the differences are sub-pixel edges and one highlighted building); see `docs/VERIFICATION.md`.

(See `docs/VERIFICATION.md` for the full run and the layout, offline and cancellation results.)

## If something goes wrong

| The dialog says | What it means | What to do |
| --- | --- | --- |
| "This is not a PMTiles file" / "too short" | The file does not start with the PMTiles header | Choose the `.pmtiles` file, not a `.mbtiles`, `.geojson` or a download page saved as a file |
| "This PMTiles file is version 2" | An old archive | Re-create it with a current `pmtiles` tool (version 3) |
| "These tiles are png/webp..., not vector" | A raster map | This app draws vector tiles only |
| "These tiles are in the newer MapLibre Tile (MLT) format" | A package built with tile type 6 (PMTiles spec 3.5 and later) | Re-export it as MVT; the reader does not decode MLT |
| "The tiles are compressed with brotli/zstd" | Compression the browser cannot read offline | Re-extract with gzip or no compression |
| "Its layers (...) are not ones this map draws" | A vector archive of something else (contours, hillshade) | Use a basemap that has roads, buildings, water, places or points of interest |
| "covers this area on paper but has no map features in this frame" | The package's bounds include the point, its tiles do not | Check the area the package was cut for; nothing is drawn that is not there |
| "Not in use: ..." beside a package | A saved copy could not be re-opened | Remove it and add the file again |
| "Packages last for this visit only" | The browser offers no storage here | Add the file again next visit, or use a normal (not private) window |
