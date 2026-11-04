# Workout and Segment Map Views

The workout detail map and the separate segment page have an in-place
**2D / 3D** switch. Leaflet is the default when no server preference exists.
Each page restores its own saved renderer choice. The existing MapTiler-powered
flyover modals are unchanged.

## Rendering and Data Sources

- 2D keeps the existing OpenStreetMap, OpenTopoMap and CyclOSM choices.
- 3D uses MapLibre GL JS, OpenStreetMap raster tiles and Mapterhorn elevation
  tiles from `https://tiles.mapterhorn.com/tilejson.json`. The 512-pixel DEM
  tiles use Terrarium encoding. Terrain exaggeration is 1, with a separate
  DEM source for hillshading, following the MapLibre terrain example.
- No API key, MapTiler account, database change or migration is needed for this
  embedded terrain view. The flyover still uses its existing MapTiler setup.
- The terrain map and its network requests are created only after selecting
  or restoring 3D. Both pages already load MapLibre 4.7.1 for the flyover; that shared
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

Leaflet labels use a dedicated noninteractive `segmentLabelPane` at z-index 575,
above the route (400), segments (500) and temporary/selected highlights (550).
This prevents highlight strokes from painting over labels. Shared Leaflet and
MapLibre label backgrounds have 78% white opacity and 2px background blur;
text and CP markers retain full opacity.

ECharts segment-header background rectangles, CP dots and text each carry an
explicit `z` of 120 plus their lane. A `z` on the graphic group alone does not
raise its children in the checked ECharts renderer. Background opacity is 52%
normally, 78% when highlighted/selected and 84% under the pointer. Text and CP
dots remain fully opaque; interaction and route-highlight behavior are unchanged.

Switching keeps the center and approximately equivalent zoom (Leaflet and
MapLibre use different base tile sizes). The 3D camera starts at a 60-degree
pitch and can be rotated or tilted with MapLibre navigation. Map style choices
are available only in 2D.

## Server-Side Renderer Preference

Both pages use the existing authenticated `/api/view-preferences/:viewKey`
GET/PUT path. The optional `mapRenderer` field accepts only `2d` or `3d` and is
stored in the existing JSON preference state in `user_view_preferences`:

- Workout detail: `workout-library` view key.
- Segment page: `segments` view key.

The choices are independent per user and per view. Existing filter/chart state,
debounced saves and page-leave flushing remain in use. No schema change or
migration is required. Missing or unsupported server choices default to 2D;
existing browser state remains only the fallback when preferences cannot load.
Map center, zoom and 2D base style keep their existing local persistence.

Only explicit renderer choices schedule a preference save. Restore, unsupported
workout GPS/permissions and terrain/WebGL failures do not replace the preferred
renderer. A restored workout preference waits for eligible workout data. Moving
to an ineligible workout temporarily shows 2D; a subsequent eligible workout
reactivates 3D. A failed terrain instance is not automatically retried; the user
can retry 3D or explicitly choose 2D to change the preference.

## Shared Terrain Hit Testing

Both terrain views now use the same projection and line-distance implementation
in `WorkoutTerrainView`. Instead of asking MapLibre which rendered feature lies
under the mouse, the application projects the current segment paths into CSS
pixel coordinates with `map.project`. It finds the nearest line portion within
9 pixels of the pointer. This covers the existing 18-pixel hit-line width and
stays constant on screen when zoom, pitch or bearing changes. GPS gaps and
invalid points are never joined for hit testing. Cached projections invalidate
on camera movement, terrain/map rendering, resize and segment-data rendering.

Workout hover listens to map-wide mouse movement rather than native layer-hover
events. Hover and click use the same hit result, keeping the cursor, route
highlight and existing chart/list callbacks consistent even if native terrain
picking misses. Leaving a segment/map clears only temporary hover; the selected
segment remains. Clicking a selected segment still toggles it off, and a
background click uses the existing clear-selection path. Manual GPS drawing
takes priority and keeps its crosshair/click-to-append behavior. The segment
page additionally retains its endpoint-marker priority.

Workout regressions cover nearest overlapping paths, GPS gaps, invalid points,
cache reuse/invalidation, hover/selection callbacks and GPS drawing priority.
The isolated preview verified real canvas events at zoom 14/pitch 75 and zoom
15/pitch 80/bearing 40, plus normal-angle recovery, hover-end selection retention,
second-click deselection, background clicks, GPS draft points and nonblank
canvas pixels. This confirms callback forwarding, not an authenticated complete
dashboard/chart pointer round trip. No routing or database writes were run.

## Segment Page

`SegmentTerrainView` reuses the terrain sources, camera switching, draft drawing,
position markers, label markers and failure handling of `WorkoutTerrainView`.
Its segment-specific interactions preserve the existing controller callbacks:
line clicks select/open the segment, and start/end markers retain their distinct
actions. Tracks use the same cached smoothing as Leaflet. Selected routes are
highlighted, tooltips escape location names, and short `S-42` labels suppress
short, overlapping and offscreen candidates, prioritizing the selected segment.

Segment hover and clicks share screen-space hit testing using `map.project`
on the same smoothed track used for rendering. In the MapLibre 4.7.1 preview,
`queryRenderedFeatures` missed visible, pixel-confirmed route positions at zoom
14/pitch 75 and zoom 15/pitch 80, and also reported a false hit away from the
route. Its results are therefore not authoritative for segment selection.
The nearest projected line within 9 CSS pixels is selectable, matching half
the existing 18-pixel hit-line width. Start/end markers take priority within
their visible radius plus stroke (8 pixels normally, 10 when selected).
Outside those distances there is no selection or pointer cursor. Invalid track
positions are skipped without connecting across the invalid entry. Projection
geometry is cached and invalidated on camera movement, map render/resize and
segment-data rendering, including updates after terrain tiles load.

Focused regression tests cover missed and false native hits, endpoint priority,
distance limits, filtered/invalid tracks, shared cursor/click handlers and cache
invalidation. The isolated browser preview verified actual canvas mouse events
at zoom 14/pitch 75, zoom 15/pitch 80/bearing 40 and zoom 13/pitch 60, as well as
start/end actions and an outside-route click. This was synthetic preview data,
not an authenticated production segment-page test. The segment-specific endpoint
logic uses the shared terrain projection/line-distance core described above.

Viewport queries, including filter/favorite reloads, use bounds from the active
renderer. Terrain camera changes also update the existing local camera state
using the Leaflet-equivalent zoom. The elevation-profile position marker is
shared. Navigation and attribution appear on the left in this view so the
existing right-hand detail overlay cannot hide them.

The 2D/3D switch stays accessible during routing-point selection. Terrain clicks
append to the same `lookupPoints` array as Leaflet, and both views keep the draft
when switching. MapLibre shows a dashed connecting line and green/blue/red draft
points; this is not live routing. Lookup still uses `/segments/track-lookup` with
the existing start/waypoints/end/points payload and success/failure behavior.
Double-click zoom is temporarily disabled while selecting. Clearing or cancelling
selection updates both maps; a terrain failure retains the active draft.

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

- The combined focused map, view-preference, hover/header, track-rendering,
  best-effort-paging and UI-state checks pass 84 tests. New coverage includes
  per-user/per-view storage, invalid/legacy values, both controller restore/save
  paths, delayed workout availability, non-persisting fallbacks, segment endpoint
  actions, labels, active bounds/camera switching and tooltip escaping.
- The segment preview used the actual EJS template/CSS, real map libraries and
  synthetic segments with simulated query/routing responses. It verified canvas
  line/start/end clicks, profile-position markers, camera rotation, desktop
  screenshot and nonblank pixels, left-side controls/attribution, three routing
  points with one waypoint, draft preservation across switches, successful draft
  cleanup and non-persisting failure fallback. Mobile DOM/canvas checks at
  390 x 844 confirmed nonblank pixels, labels/marker and no horizontal overflow.
  Mobile screenshots were attempted, but the integrated browser clipped their
  raster output even in an isolated tab; full mobile visual inspection remains
  a user check. The hidden-tab animation-frame workaround was preview-only.
- No authenticated end-to-end preference save/reload, real routing or database
  write was performed. The full suite was not run. Syntax and targeted ESLint
  pass (seven existing warnings); type checking remains blocked by three known
  nullability errors in unchanged `MicroIntervalDetector.js:141`.
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
- Layering checks also cover explicit ECharts child z-order and hover opacity,
  plus Leaflet label-pane ordering and background-only translucency. An isolated
  ECharts browser render confirmed that a crossing line at z=4 is drawn before
  header rectangle/dot/text at z=120. Leaflet computed pane order and screenshots,
  plus MapLibre computed alpha, mobile screenshot and canvas pixels, were checked.