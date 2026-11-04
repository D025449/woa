# Workout Map Views

The workout detail map has an in-place **2D / 3D** switch. Leaflet remains the
default. The existing MapTiler-powered flyover modal and the separate segment
page are unchanged.

## Rendering and Data Sources

- 2D keeps the existing OpenStreetMap, OpenTopoMap and CyclOSM choices.
- 3D uses MapLibre GL JS, OpenStreetMap raster tiles and Mapterhorn elevation
  tiles from `https://tiles.mapterhorn.com/tilejson.json`. The 512-pixel DEM
  tiles use Terrarium encoding. Terrain exaggeration is 1, with a separate
  DEM source for hillshading, following the MapLibre terrain example.
- No API key, MapTiler account, database change or migration is needed for this
  embedded terrain view. The flyover still uses its existing MapTiler setup.
- The terrain map and its network requests are created only after selecting
  3D. The dashboard already loads MapLibre 4.7.1 for the flyover; that shared
  dependency remains unchanged. This version does not expose `supported()`;
  map construction failures are caught instead.
- Public endpoints currently require no paid subscription. This is not a
  promise of unlimited access or availability. Follow the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  and [Mapterhorn attribution requirements](https://mapterhorn.com/attribution).
  Preserve the visible map attribution. Browsers contact both providers directly;
  providers receive the requesting IP and tile areas, not uploaded workout files.
- Terrain only affects visualization. Stored GPS positions, recorded altitude,
  ascent/descent and workout analysis are not changed.

## Interaction and Failure Handling

`MapView` owns the shared workout, GPS sample indexing, segment visibility,
selection and chart-position state. `WorkoutTerrainView` renders those values
without connecting to workout APIs itself. GPS gaps remain separate lines.
Segment colors, hover, selection and the chart-position marker work in both
views. Selected 3D segment popups use visible track points to avoid clipping
outside the map on narrow viewports.

Chart segment-header hover now updates both the workout segment list and the
map's route highlight, matching the existing list-hover behavior in Leaflet and
MapLibre. Mouseout removes only the temporary hover; an existing segment
selection remains highlighted. The map hover methods do not emit another chart
hover callback, avoiding feedback loops.

Both renderers share short segment labels (`S-42`, `CP4`), type colors, CP color
markers, optional names, minimum projected path length and overlap suppression.
`MapView.getVisibleSegmentLabels` selects candidates using each renderer's own
screen projection. Leaflet still uses its existing noninteractive label markers;
MapLibre uses noninteractive DOM markers that follow the terrain. Labels are
recomputed on render, camera move end and resize. Existing MapLibre label markers
are reused, and stale labels are removed after visibility/workout changes or
terrain failure. Labels themselves do not intercept route clicks or GPS editing.

Switching keeps the center and approximately equivalent zoom (Leaflet and
MapLibre use different base tile sizes). The 3D camera starts at a 60-degree
pitch and can be rotated or tilted with MapLibre navigation. Map style choices
are available only in 2D. The renderer selection is not persisted across page reloads.

## GPS Editing in Both Views

The existing GPS menu is available under the same ownership/data restrictions:
the current user must own the workout, and it must either lack valid GPS or use
the `manual_lookup` GPS source. Imported valid GPS tracks are not made editable.
The menu's GPX import (direct or routed) and copy-from-workout actions still use
their existing handlers and APIs, independently of the active map renderer.

Manual GPS editing now stays in the selected renderer. In MapLibre, clicks on
the terrain append lookup points to the same `MapView.manualGpsPoints` draft
used by Leaflet. A dashed line joins them; first, intermediate and last points
are green, blue and red. This is a draft connecting lookup points, not a live
routing preview. Existing routing/persistence remains in the shared save path;
MapLibre does not introduce another routing service or elevation write path.

The existing clear, cancel and save controls work in either view. Switching
between 2D and 3D preserves the draft. Clear removes the draft points but keeps
editing active; cancel discards the draft, and successful save ends editing.
Failed saves keep the draft. Selecting another workout discards the previous
unsaved draft. Moving or individually deleting points is not added here; this
change reproduces the existing click-to-append and clear-all behavior.

3D is also available for owned workouts without GPS so a new track can be drawn
there. Workouts without valid GPS and without edit permission still cannot use
3D. While editing in MapLibre, clicks take priority over segment selection,
the cursor is a crosshair and double-click zoom is temporarily disabled. The
previous double-click zoom state is restored when editing ends. A terrain
failure can still fall back to Leaflet without discarding the active draft.

Startup errors, source errors, WebGL context loss or a 20-second initial load
timeout return to Leaflet and show a localized status message. 3D can be retried.
Returning to 2D retains the existing terrain instance for reuse; shared data and
fit updates are skipped while it is inactive, but already-started tile requests
may finish.

## Verification

- Focused tests in `tests/map-segment-label.test.js` cover existing Leaflet labels,
  GPS gaps, coordinate order, shared route/segment/focus/marker state, WebGL
  fallback, in-place switching, edit permissions, inactive rendering,
  terrain configuration and compatibility with the current MapLibre version.
- Additional editing tests cover terrain click forwarding, draft geometry and
  colors, navigation restoration, common save/GPX handlers, failed-save draft
  preservation, clear/cancel behavior and workout-switch draft cleanup.
- Hover/label regressions in the existing map-label and segment-visibility tests
  cover the actual chart callback's enter/leave behavior, restoring selection,
  shared overlap/short-path/offscreen filtering, terrain-projected CP labels and
  marker reuse/removal. Existing CP chart-header tests remain unchanged.
- An isolated local browser preview with the real map modules, public tile
  services and a synthetic Innsbruck track verified desktop/mobile rendering,
  screenshots, nonblank canvas pixels, terrain activation, position markers,
  segment selection, center-preserving switching and workout/no-GPS changes.
- This preview is not an authenticated end-to-end dashboard test. The complete
  dashboard layout, real workout data and real chart pointer interaction still
  need a user check in the running application.
- The editing preview also verified simulated mouse events through the real
  MapLibre canvas handlers, draft preservation across renderers, a simulated
  save handler, and desktop/mobile screenshots and nonblank canvas pixels.
  The shared browser tab was hidden; a preview-only timer-based animation-frame
  shim allowed rendering during this check. Application code was not changed
  for that workaround. No live routing, GPX upload or database save was run.
- The hover/label preview verified `S-1` and `CP4`, camera changes, desktop/mobile
  screenshots, nonblank canvas pixels and nonoverlapping labels in the checked
  viewport. Invoking the actual chart callback body against the real map modules
  highlighted the route in both renderers and preserved selection after mouseout.
  This is not a full authenticated ECharts/list/map pointer round-trip test.