QWEN / CRIMSON MAP CONSOLE
==================
A local terminal-and-map interface with a crimson vector map.

QUICKEST START ON WINDOWS
1. Extract the entire ZIP into a folder.
2. Double-click START_WINDOWS.bat.
3. The browser opens and starts the sequence automatically.

The launcher uses Python if available. Without Python, it opens the standalone
HTML file in your browser instead. Nothing needs to be installed. You can also
open Qwen_Map_Console.html directly; it starts automatically. On macOS/Linux, open
the HTML file or run: python3 RUN_CONSOLE.py

WHAT YOU WILL SEE
- The first three Bash commands type character by character, with varied
  timing, pauses, typos, backspaces and corrected text.
- Qwen initialization starts after those three commands, followed by the
  automatic command stream in a Windows Terminal style window.
- Qwen-3.8-27b-obliterated initialization and a progress bar, all for show.
- The metadata commands from the prior artwork, including a missing-file
  error, find command, corrected path, jq pipelines and checksum text.
- The terminal moves to the left while a black-and-red map opens on the right.
- Coordinates type into the map field and the map zooms to the supplied point.
- A question-mark Find My style marker appears.
- Bash returns to the foreground, displays the coordinates and elevation,
  and concludes: identity: inconclusive / user not in contacts.
- Npcap, Wireshark and Suricata tabs have illustrative local display buffers.

OFFLINE MAP / NO API KEYS
This version uses only the bundled local street and building geometry.
No account, API key, payment, internet connection or website is required.
Online map layers and API-key settings have been removed entirely.
The app's network policy also blocks external map or data connections.

EXPANDED MAP DETAIL
The dataset includes 12,671 geometry features and 1,657 label candidates:
- 2,323 building footprints, including inner courtyards where mapped
- 6,284 road, footpath and sidewalk segments
- 407 parking areas and individual mapped parking spaces
- 338 green spaces, 39 water features and 114 paved areas
- 1,038 trees, 1,763 benches/cycle-parking/crossing/other small map features
- 123 bus stops, 197 points of interest and 45 fences/walls/barriers
Labels include street names, building names, public businesses and parking.
Only relevant labels appear at each zoom level; overlapping labels are hidden.
Trees and other fine detail appear from zoom 17.5 onward.
Click Map details or the gear to toggle street names, place names or fine detail.

Coverage: the local Gainesville/UF neighborhood between longitude -82.351
and -82.324, latitude 29.638 and 29.659. Panning stays in this bundled area;
this is a detailed local map, not an offline map of the whole world.
Geometry detail depends on what is present in the public source dataset.

COORDINATES
Latitude:  29 degrees 38 minutes 55.87 seconds N = 29.6488527778
Longitude: 82 degrees 20 minutes 16.40 seconds W = -82.3378888889
Elevation: 47.46 m (user supplied, not measured by the app)
Marker placement: exact supplied coordinates, within the public mapped
Courtyards Building A footprint. No apartment number or occupant is inferred.

CONTROLS
Space: suspend/resume. Transport controls are not shown on screen.
R: restart from the first command.
The opening uses natural typing speed. There is no visible speed selector.
Fullscreen: top-right icon, or your browser's F11 control on Windows.
Map focus: M after the map opens.
Map: drag to pan, scroll or +/- to zoom; crosshair recenters.
Tool tabs: switch displays; Bash continues and returns at the map reveal and end.
Map detail settings suspend the process while the settings window is open.

The HTML file is self-contained with Leaflet, styling, source code and a small
local street dataset. The terminal and map work offline.
No internet connection is needed for the terminal or map.
No OpenAI/Hugging Face account, downloaded model, npm packages, Npcap,
Wireshark, Suricata, Bash, or EXIF utilities are required.

IMPLEMENTATION
The displayed commands are text animation. They are never passed to a shell.
No photo metadata is actually read or scrubbed, no packets are captured, and
no person is identified or located. Coordinates are explicitly supplied data.
The optional Python launcher serves only the local folder on loopback.
Closing the browser does not stop that optional launcher: press Ctrl+C in its
console or close the launcher window when finished.

SOURCE
core.js: reference coordinates, command steps, timing and opening typing plan.
app.js: terminal, controls and map rendering.
styles.css and template.html: interface.
build.py and map_builder.py: build the single-file HTML and offline dataset.
RUN_CONSOLE.py: optional loopback web server and browser launcher.
START_WINDOWS.bat: Windows launcher with browser-only fallback.
data/map-data.json: public street/building/point geometry in the portable HTML.
data/map-labels.json and map-meta.json: label candidates and bundle statistics.
The public OSM source extracts are included as data/part-0.osm to part-3.osm.
Running the already-built HTML does not need source files or build tools.

Attribution and source references: see SOURCES.txt and LEAFLET_LICENSE.txt.
