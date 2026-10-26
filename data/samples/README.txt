Sample map package: Florence, Italy
===================================

protomaps-basemap-firenze.pmtiles is a real Protomaps basemap archive, copied unchanged from the PMTiles project:

  Source      https://github.com/protomaps/PMTiles, file spec/v3/protomaps(vector)ODbL_firenze.pmtiles
  Commit      aec8fa1341222fdddb3318e9ffa8e18e19b312f7 (read 2026-10-26)
  SHA-256     7190f3d807a62f4f012b574007c96b809f6842f45a6b0c508639331fc68fd30a
  Size        6,601,156 bytes, 92 tiles, zoom 0 to 15, PMTiles v3, gzip, vector (MVT)
  Area        11.221 E to 11.288 E, 43.745 N to 43.789 N (central Florence)
  Content     Protomaps Basemap 3.7.1 (planetiler build): roads, buildings, water, landuse, natural, places, points of
              interest, transit, physical lines and points, boundaries
  Licence     ODbL 1.0 for the map data; credit "(c) OpenStreetMap contributors". The PMTiles project's own annotation for
              this file is "(c) OpenStreetMap Contributors, ODbL-1.0".

It is not built into the page. To see it: open META trace, choose Map data, Add a .pmtiles file, pick this file, then analyze
a photo tagged inside the area above (tests/fixtures/gps-florence-duomo.jpg is tagged at the Piazza del Duomo, 43.7731 N,
11.2558 E). It is also what the package tests read, so the map package support is checked against a real third-party file.

Only this small area is covered. It does not add detail anywhere else.
