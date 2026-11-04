import assert from "node:assert/strict";
import test from "node:test";
import MapView from "../src/public/js/map-view.js";
import WorkoutTerrainView from "../src/public/js/workout-terrain-view.js";
import SegmentTerrainView from "../src/public/js/segment-terrain-view.js";
import SegmentMapView from "../src/public/js/segment-map-view.js";
import { getCPSeriesColor } from "../src/shared/CriticalPowerAppearance.js";

function createView(pathLength = 100) {
  const view = Object.create(MapView.prototype);
  view.measureCoordinatePath = () => ({
    length: pathLength,
    point: { x: 100, y: 100 },
    latlng: [48, 9]
  });
  return view;
}

test("segment terrain renders filtered tracks, selection and endpoint actions in longitude-latitude order", () => {
  const segment = { id: 42, start: { lat: 48, lng: 9 }, end: { lat: 49, lng: 10 } };
  const actions = [];
  const owner = {
    renderer: "3d", selectedSegmentId: 42,
    controller: { getRenderableSegments: () => [segment] },
    getSegmentRenderTrack: () => [segment.start, segment.end],
    onSegmentStartClick: (value) => actions.push(["start", value.id]),
    onSegmentEndClick: (value) => actions.push(["end", value.id]),
    selectSegment: (value) => actions.push(["select", value.id]),
    handlers: { onSegmentOpen: (event) => actions.push([event.type]) },
    handleMapClick: (event) => actions.push(["draft", event.latlng])
  };
  const view = new SegmentTerrainView({}, owner);
  const data = new Map();
  view.ready = true;
  let endpoint = "start";
  view.map = {
    getSource: (key) => ({ setData(value) { data.set(key, value); } }),
    queryRenderedFeatures: () => [{ properties: { key: "42", endpoint } }]
  };
  view.moveMarker = () => {};
  view.updateSegmentLabels = () => {};
  view.showTooltip = () => {};
  view.render();
  assert.deepEqual(data.get("workout").features.map((item) => item.properties.kind), ["segment", "focus"]);
  assert.deepEqual(data.get("workout").features[0].geometry.coordinates, [[9, 48], [10, 49]]);
  assert.deepEqual(data.get("segment-endpoints").features.map((item) => item.properties.endpoint), ["start", "end"]);
  view.handleClick({});
  endpoint = "end";
  view.handleClick({});
  endpoint = undefined;
  view.handleClick({});
  owner.isSelecting = true;
  view.handleClick({ lngLat: segment.start });
  assert.deepEqual(actions, [["start", 42], ["end", 42], ["select", 42], ["line"], ["draft", segment.start]]);
  owner.lookupPoints = [segment.start, segment.end];
  assert.deepEqual(view.getDraftSelection(), { editing: true, points: owner.lookupPoints });
  owner.renderer = "2d";
  view.map = {};
  assert.doesNotThrow(() => view.render());
});

test("segment terrain labels prefer selection and reject short, overlapping and offscreen paths", () => {
  const owner = {
    selectedSegmentId: 2,
    controller: { getRenderableSegments: () => [1, 2, 3, 4].map((id) => ({ id })) },
    getSegmentRenderTrack: (segment) => segment.id
  };
  const view = new SegmentTerrainView({}, owner);
  view.map = { getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }) };
  view.measureCoordinatePath = (id) => ({ length: id === 3 ? 10 : 120, point: { x: id === 4 ? -20 : 100, y: 100 }, latlng: [9, 48] });
  assert.deepEqual(view.getLabelCandidates().map((candidate) => candidate.text), ["S-2"]);
});

test("segment map restores renderer, active bounds and camera without persisting automatic fallback", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  const saved = [];
  let center = { lat: 48, lng: 9 };
  let zoom = 12;
  const leafletContainer = { hidden: false };
  const view = Object.assign(Object.create(SegmentMapView.prototype), {
    renderer: "2d", terrainContainer: { hidden: true }, rendererButtons: [],
    handlers: { onRendererChange: (mode) => saved.push(mode) },
    scheduleViewportLoad() {},
    map: {
      getZoom: () => zoom, getCenter: () => center, getBounds: () => "leaflet",
      getContainer: () => leafletContainer, invalidateSize() {},
      setView(coords, nextZoom) { center = { lat: coords[0], lng: coords[1] }; zoom = nextZoom; }
    },
    terrainView: {
      open() {}, showTooltip() {},
      map: { getCenter: () => ({ lat: 49, lng: 10 }), getZoom: () => 10, getBounds: () => "terrain" }
    },
    lookupPoints: [{ lat: 48, lng: 9 }]
  });
  try {
    view.applyRendererPreference("3d");
    assert.equal(view.renderer, "3d");
    assert.equal(view.getBounds(), "terrain");
    assert.equal(leafletContainer.hidden, true);
    assert.deepEqual(saved, []);
    view.setRenderer("2d", { persist: false });
    assert.equal(view.preferredRenderer, "3d");
    assert.equal(view.getBounds(), "leaflet");
    assert.deepEqual(center, { lat: 49, lng: 10 });
    assert.equal(zoom, 11);
    assert.equal(view.lookupPoints.length, 1);
    view.setRenderer("2d");
    assert.equal(view.preferredRenderer, "2d");
    assert.deepEqual(saved, ["2d"]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("workout map defers restored terrain until eligible data and never saves automatic fallback", () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { getElementById: () => null };
  globalThis.window = {};
  const saves = [];
  let opened = 0;
  const view = Object.assign(Object.create(MapView.prototype), {
    renderer: "2d", terrainContainer: {}, rendererButtons: [], handlers: {},
    currentWorkout: null, manualGpsPoints: [], gpxImportButtons: [],
    clearSegmentHover() {}, onRendererChange: (mode) => saves.push(mode),
    map: {
      getContainer: () => ({}), getCenter: () => ({ lat: 48, lng: 9 }), getZoom: () => 12,
      setView() {}, invalidateSize() {}
    },
    terrainView: {
      open() { opened += 1; },
      map: { getCenter: () => ({ lat: 48, lng: 9 }), getZoom: () => 11 }
    }
  });
  try {
    view.applyRendererPreference("3d");
    assert.equal(view.renderer, "2d");
    assert.equal(view.preferredRenderer, "3d");
    view.currentWorkout = { validGps: true };
    view.syncManualGpsUi();
    assert.equal(view.renderer, "3d");
    assert.equal(opened, 1);
    view.currentWorkout = { validGps: false };
    view.syncManualGpsUi();
    assert.equal(view.renderer, "2d");
    assert.equal(view.preferredRenderer, "3d");
    view.currentWorkout = { validGps: true };
    view.syncManualGpsUi();
    assert.equal(opened, 2);
    view.terrainView.failed = true;
    view.setRenderer("2d", { persist: false });
    view.syncManualGpsUi();
    assert.equal(view.renderer, "2d");
    assert.equal(view.preferredRenderer, "3d");
    assert.deepEqual(saves, []);
    view.setRenderer("2d");
    assert.deepEqual(saves, ["2d"]);
    assert.equal(view.preferredRenderer, "2d");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shared segment tooltips escape location names before Leaflet or MapLibre HTML rendering", () => {
  const view = Object.assign(Object.create(SegmentMapView.prototype), { t: (key) => key });
  const point = { name: '<img src=x onerror="alert(1)">', altitude: 500 };
  const tooltip = view.buildSegmentTooltip({ id: 42, start: point, end: point, distance: 1000, ascent: 20 });
  assert.doesNotMatch(tooltip, /<img/);
  assert.match(tooltip, /&lt;img/);
  assert.doesNotMatch(view.buildEndpointTooltip("start", point), /<img/);
});

test("Leaflet CP segment labels use the shared duration notation and curve color", () => {
  const segment = {
    id: 812,
    segmenttype: "crit",
    duration: 240,
    start_offset: 10,
    end_offset: 249
  };
  const candidate = createView().getSegmentLabelCandidate({
    segment,
    coordinateSegments: [[]],
    color: "#f59e0b"
  });

  assert.equal(candidate.text, "CP4");
  assert.equal(candidate.markerColor, getCPSeriesColor(240));
  assert.ok(candidate.width >= 38);
});

test("short Leaflet CP labels omit the color marker when space is tight", () => {
  const segment = { id: 812, segmenttype: "crit", duration: 15 };
  const candidate = createView(68).getSegmentLabelCandidate({
    segment,
    coordinateSegments: [[]],
    color: "#f59e0b"
  });

  assert.equal(candidate.text, "CP15S");
  assert.equal(candidate.markerColor, null);
});

test("Leaflet labels for other segment types keep their segment IDs", () => {
  for (const segment of [
    { id: 42, segmenttype: "manual" },
    { id: 43, segmenttype: "auto" },
    { id: 900, sid: 91, segmenttype: "gps", isGPSSegment: true }
  ]) {
    const candidate = createView().getSegmentLabelCandidate({
      segment,
      coordinateSegments: [[]],
      color: "#ef4444"
    });
    const expectedId = segment.isGPSSegment ? segment.sid : segment.id;
    assert.equal(candidate.text, `S-${expectedId}`);
    assert.equal(candidate.markerColor, null);
  }
});

test("Leaflet CP tooltips lead with the duration notation instead of the internal ID", () => {
  const view = createView();
  const tooltip = view.buildSegmentTooltipContent({
    id: 812,
    segmenttype: "crit",
    duration: 60,
    avg_power: 340
  });

  assert.match(tooltip, /<strong>CP1<\/strong>/);
  assert.doesNotMatch(tooltip, /S-812/);
});

test("terrain route features preserve GPS gaps and longitude-latitude order", () => {
  const view = new WorkoutTerrainView({}, {});
  const points = [{ lat: 48, lng: 9 }, { lat: 49, lng: 10 }];
  const features = view.lineFeatures([points, [], [points[0]], points], { kind: "route" });
  assert.equal(features.length, 2);
  assert.deepEqual(features[0].geometry.coordinates, [[9, 48], [10, 49]]);
  assert.deepEqual(features[0].properties, { kind: "route" });
});

test("terrain renders route, colored segments, focus and chart position from the shared state", () => {
  const points = [{ lat: 48, lng: 9 }, { lat: 49, lng: 10 }];
  const entry = { key: "manual:1", coordinateSegments: [points], color: "#123456" };
  const owner = {
    currentTrackSegments: [points], segmentOverlayEntries: [entry],
    hoveredSegmentOverlay: entry, markerPosition: [9, 48]
  };
  const view = new WorkoutTerrainView({}, owner);
  let data;
  let position;
  view.ready = true;
  view.map = { getSource: () => ({ setData(value) { data = value; } }) };
  view.moveMarker = (value) => { position = value; };
  view.render();
  assert.deepEqual(data.features.map((feature) => feature.properties.kind), ["route", "segment", "focus"]);
  assert.equal(data.features[1].properties.color, "#123456");
  assert.equal(data.features[1].properties.key, "manual:1");
  assert.deepEqual(position, [9, 48]);
  owner.currentTrackSegments = [];
  owner.segmentOverlayEntries = [];
  owner.hoveredSegmentOverlay = null;
  owner.markerPosition = null;
  view.render();
  assert.deepEqual(data.features, []);
  assert.equal(position, null);
});

test("terrain startup without WebGL falls back once without throwing", () => {
  const actions = [];
  const owner = {
    setRenderer: (mode) => actions.push(mode),
    showTerrainError: () => actions.push("error")
  };
  const view = new WorkoutTerrainView({}, owner);
  view.open({ lat: 48, lng: 9 }, 10);
  view.fail();
  assert.deepEqual(actions, ["2d", "error"]);
  assert.equal(view.ready, false);
});

test("inplace switch preserves the center and toggles only the embedded map containers", () => {
  const previousDocument = globalThis.document;
  const leafletContainer = { hidden: false };
  const terrainContainer = { hidden: true };
  let center = { lat: 48, lng: 9 };
  let zoom = 12;
  let opened;
  const buttons = ["2d", "3d"].map((mode) => ({
    dataset: { workoutMapRenderer: mode },
    classList: { toggle() {} }, setAttribute(name, value) { this[name] = value; }
  }));
  const view = Object.assign(Object.create(MapView.prototype), {
    renderer: "2d", rendererButtons: buttons, terrainContainer,
    currentWorkout: { validGps: true },
    handlers: {},
    clearSegmentHover() {},
    map: {
      getContainer: () => leafletContainer, getCenter: () => center, getZoom: () => zoom,
      invalidateSize() {},
      setView(coords, nextZoom) { center = { lat: coords[0], lng: coords[1] }; zoom = nextZoom; }
    },
    terrainView: {
      open(nextCenter, nextZoom) { opened = [nextCenter, nextZoom]; },
      map: { getCenter: () => ({ lat: 49, lng: 10 }), getZoom: () => 10 }
    }
  });
  globalThis.document = { getElementById: () => null };
  try {
    view.setRenderer("3d");
    assert.deepEqual(opened, [{ lat: 48, lng: 9 }, 12]);
    assert.equal(leafletContainer.hidden, true);
    assert.equal(terrainContainer.hidden, false);
    assert.equal(buttons[1]["aria-pressed"], "true");
    view.setRenderer("2d");
    assert.deepEqual(center, { lat: 49, lng: 10 });
    assert.equal(zoom, 11);
    assert.equal(terrainContainer.hidden, true);
    assert.equal(leafletContainer.hidden, false);
    view.manualGpsMode = true;
    view.setRenderer("3d");
    assert.equal(view.renderer, "3d");
    view.setRenderer("2d");
    view.manualGpsMode = false;
    view.currentWorkout.validGps = false;
    view.setRenderer("3d");
    assert.equal(view.renderer, "2d");
    view.currentWorkout.access = { isOwner: true };
    view.setRenderer("3d");
    assert.equal(view.renderer, "3d");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("inactive terrain does not update data or move its viewport", () => {
  const view = new WorkoutTerrainView({}, { renderer: "2d" });
  view.ready = true;
  view.map = {};
  assert.doesNotThrow(() => view.render());
  assert.doesNotThrow(() => view.fit([{ lat: 48, lng: 9 }]));
});

test("terrain uses Terrarium height tiles and starts with MapLibre 4 without supported()", () => {
  const previousLibrary = globalThis.maplibregl;
  let options;
  const controlPositions = [];
  const owner = {
    renderer: "3d", currentTrackSegments: [], segmentOverlayEntries: [],
    getVisibleSegmentLabels: () => []
  };
  const view = new WorkoutTerrainView({}, owner);
  const events = new Map();
  globalThis.maplibregl = {
    Map: class {
      constructor(value) { options = value; }
      addControl(_control, position) { controlPositions.push(position); }
      on(name, ...args) { events.set(name, args.at(-1)); }
      getCanvas() { return { addEventListener() {} }; }
      addSource() {}
      addLayer() {}
      getSource() { return { setData() {} }; }
    },
    NavigationControl: class {},
    AttributionControl: class {}
  };
  try {
    view.open({ lat: 48, lng: 9 }, 12);
    assert.equal(view.failed, undefined);
    assert.equal(options.attributionControl, false);
    assert.deepEqual(controlPositions, ["top-right", "bottom-right"]);
    const segmentTerrain = new SegmentTerrainView({}, owner);
    assert.equal(segmentTerrain.navigationControlPosition, "top-left");
    assert.equal(segmentTerrain.attributionControlPosition, "bottom-left");
    assert.deepEqual(options.terrain, undefined);
    assert.deepEqual(options.style.terrain, { source: "terrain", exaggeration: 1 });
    assert.equal(options.style.sources.terrain.encoding, "terrarium");
    assert.equal(options.style.sources.terrain.tileSize, 512);
    assert.equal(options.style.sources.terrain.url, "https://tiles.mapterhorn.com/tilejson.json");
    assert.ok(options.style.layers.some((layer) => layer.type === "hillshade"));
    events.get("load")();
    assert.equal(view.ready, true);
    let clicked;
    owner.manualGpsMode = true;
    owner.handleMapClick = (event) => { clicked = event.latlng; };
    events.get("click")({ lngLat: { lat: 48, lng: 9 } });
    assert.deepEqual(clicked, { lat: 48, lng: 9 });
  } finally {
    clearTimeout(view.timeout);
    if (previousLibrary === undefined) delete globalThis.maplibregl;
    else globalThis.maplibregl = previousLibrary;
  }
});

test("terrain draft uses shared GPS points and restores navigation when editing ends", () => {
  const points = [{ lat: 48, lng: 9 }, { lat: 49, lng: 10 }, { lat: 50, lng: 11 }];
  const owner = { manualGpsMode: true, manualGpsPoints: points };
  const view = new WorkoutTerrainView({}, owner);
  let data;
  let doubleClickEnabled = true;
  const canvas = { style: {} };
  view.ready = true;
  view.map = {
    getCanvas: () => canvas,
    getSource: () => ({ setData(value) { data = value; } }),
    doubleClickZoom: {
      isEnabled: () => doubleClickEnabled,
      disable() { doubleClickEnabled = false; },
      enable() { doubleClickEnabled = true; }
    }
  };
  view.renderManualGpsSelection();
  assert.equal(canvas.style.cursor, "crosshair");
  assert.equal(doubleClickEnabled, false);
  assert.equal(data.features.length, 4);
  assert.deepEqual(data.features[0].geometry.coordinates, [[9, 48], [10, 49], [11, 50]]);
  assert.deepEqual(data.features.slice(1).map((feature) => feature.properties.color), ["#16a34a", "#2563eb", "#dc2626"]);
  owner.manualGpsPoints = [];
  view.renderManualGpsSelection();
  assert.deepEqual(data.features, []);
  assert.equal(doubleClickEnabled, false);
  owner.manualGpsMode = false;
  view.renderManualGpsSelection();
  assert.equal(canvas.style.cursor, "");
  assert.equal(doubleClickEnabled, true);
  assert.deepEqual(points, [{ lat: 48, lng: 9 }, { lat: 49, lng: 10 }, { lat: 50, lng: 11 }]);
});

test("shared manual GPS clicks update both map renderers and reject invalid positions", () => {
  let renders = 0;
  let uiUpdates = 0;
  const view = Object.assign(Object.create(MapView.prototype), {
    manualGpsMode: true, manualGpsPoints: [],
    renderManualGpsSelection() { renders += 1; },
    syncManualGpsUi() { uiUpdates += 1; }
  });
  view.handleMapClick({ latlng: { lat: 48, lng: 9 } });
  view.handleMapClick({ latlng: { lat: NaN, lng: 10 } });
  assert.deepEqual(view.manualGpsPoints, [{ lat: 48, lng: 9 }]);
  assert.equal(renders, 1);
  assert.equal(uiUpdates, 1);
});

test("shared GPS controls preserve failed saves and use the same save and GPX handlers in 3D", async () => {
  const callbacks = {};
  const controls = {};
  for (const name of ["manualGpsSaveButton", "manualGpsCancelButton", "manualGpsClearButton", "gpxFileInput"]) {
    controls[name] = { addEventListener(_type, callback) { callbacks[name] = callback; } };
  }
  const points = [{ lat: 48, lng: 9 }, { lat: 49, lng: 10 }];
  let saved;
  let imported;
  let rejectSave = true;
  let terrainUpdates = 0;
  const view = Object.assign(Object.create(MapView.prototype), controls, {
    renderer: "3d", manualGpsMode: true, manualGpsPoints: points,
    gpxImportButtons: [], pendingGpxImportMode: "routed",
    map: { getContainer: () => ({ style: {} }) },
    manualGpsLayer: { clearLayers() {} },
    terrainView: { renderManualGpsSelection() { terrainUpdates += 1; } },
    syncManualGpsUi() {},
    handlers: {
      async onManualGpsSave(value) {
        if (rejectSave) throw new Error("save failed");
        saved = value;
      },
      async onGpxImport(file, mode) { imported = { file, mode }; }
    }
  });
  view.registerManualGpsControls();
  await assert.rejects(callbacks.manualGpsSaveButton, /save failed/);
  assert.equal(view.manualGpsMode, true);
  assert.equal(view.manualGpsPoints, points);
  rejectSave = false;
  await callbacks.manualGpsSaveButton();
  assert.equal(saved, points);
  assert.equal(view.renderer, "3d");
  assert.equal(view.manualGpsMode, false);
  assert.deepEqual(view.manualGpsPoints, []);
  const file = { name: "route.gpx" };
  view.gpxFileInput.files = [file];
  await callbacks.gpxFileInput();
  assert.deepEqual(imported, { file, mode: "routed" });
  assert.equal(view.gpxImportBusy, false);
  assert.equal(view.gpxFileInput.value, "");
  view.manualGpsMode = true;
  view.manualGpsPoints = [...points];
  callbacks.manualGpsClearButton();
  assert.deepEqual(view.manualGpsPoints, []);
  assert.equal(view.manualGpsMode, true);
  view.manualGpsPoints = [...points];
  callbacks.manualGpsCancelButton();
  assert.deepEqual(view.manualGpsPoints, []);
  assert.equal(view.manualGpsMode, false);
  assert.equal(terrainUpdates, 3);
});

test("switching workouts discards manual GPS drafts before rendering the next workout", () => {
  let discarded = false;
  const view = Object.assign(Object.create(MapView.prototype), {
    currentWorkout: { id: 1 }, manualGpsMode: true,
    disableManualGpsMode() { discarded = true; },
    trackLayer: { clearLayers() { throw new Error("render boundary"); } }
  });
  assert.throws(() => view.renderTrack({ id: 2 }), /render boundary/);
  assert.equal(discarded, true);
  discarded = false;
  assert.throws(() => view.renderTrack({ id: 2 }), /render boundary/);
  assert.equal(discarded, false);
});

test("shared map labels reject short, overlapping and offscreen segment paths", () => {
  const view = Object.assign(createView(), {
    segmentOverlayEntries: [
      { key: "short", segment: { id: 1 }, coordinateSegments: [[{ length: 20, x: 100 }]] },
      { key: "long", segment: { id: 2 }, coordinateSegments: [[{ length: 180, x: 100 }]] },
      { key: "overlap", segment: { id: 3 }, coordinateSegments: [[{ length: 100, x: 105 }]] },
      { key: "outside", segment: { id: 4 }, coordinateSegments: [[{ length: 120, x: 600 }]] }
    ]
  });
  const labels = view.getVisibleSegmentLabels({ x: 400, y: 300 }, (points) => ({
    length: points[0].length, point: { x: points[0].x, y: 100 }, latlng: [9, 48]
  }));
  assert.deepEqual(labels.map((label) => label.entry.key), ["long"]);
  assert.equal(labels[0].text, "S-2");
});

test("terrain label placement measures its own projection and keeps shared CP text and color", () => {
  const points = [{ lng: 9, lat: 48 }, { lng: 10, lat: 48 }, { lng: 11, lat: 48 }];
  const entry = {
    key: "criticalPower:17", segment: { id: 17, segmenttype: "crit", duration: 240 },
    color: "#f59e0b", coordinateSegments: [points]
  };
  const owner = Object.assign(createView(), { segmentOverlayEntries: [entry] });
  const view = new WorkoutTerrainView({}, owner);
  view.map = { project: ([lng]) => ({ x: (lng - 9) * 100, y: 100 }) };
  const measurement = view.measureCoordinatePath(points);
  assert.equal(measurement.length, 200);
  assert.deepEqual(measurement.latlng, [10, 48]);
  const labels = owner.getVisibleSegmentLabels({ x: 400, y: 300 }, (path) => view.measureCoordinatePath(path));
  assert.equal(labels[0].text, "CP4");
  assert.equal(labels[0].markerColor, getCPSeriesColor(240));
  assert.match(owner.getSegmentLabelHtml(labels[0]), /CP4/);
  assert.equal(view.measureCoordinatePath([]), null);
  assert.equal(view.measureCoordinatePath([points[0], points[0]]), null);
});

test("terrain labels reuse markers and remove stale labels after visibility or workout changes", () => {
  const previousDocument = globalThis.document;
  const previousLibrary = globalThis.maplibregl;
  let candidates = [{
    entry: { key: "manual:1" }, latlng: [9, 48], width: 42, height: 24
  }];
  let created = 0;
  let removed = 0;
  globalThis.document = { createElement: () => ({ style: {} }) };
  globalThis.maplibregl = {
    Marker: class {
      constructor({ element }) { this.element = element; created += 1; }
      getElement() { return this.element; }
      setLngLat(position) { this.position = position; return this; }
      addTo() { return this; }
      remove() { removed += 1; }
    }
  };
  const owner = { renderer: "3d", getVisibleSegmentLabels: () => candidates, getSegmentLabelHtml: () => "S-1" };
  const view = new WorkoutTerrainView({}, owner);
  view.ready = true;
  view.map = { getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }) };
  try {
    view.updateSegmentLabels();
    const marker = view.labels.get("manual:1");
    assert.equal(marker.getElement().innerHTML, "S-1");
    assert.equal(marker.getElement().style.width, "42px");
    candidates[0].latlng = [10, 49];
    view.updateSegmentLabels();
    assert.equal(created, 1);
    assert.deepEqual(marker.position, [10, 49]);
    candidates = [];
    view.updateSegmentLabels();
    assert.equal(view.labels.size, 0);
    assert.equal(removed, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLibrary === undefined) delete globalThis.maplibregl;
    else globalThis.maplibregl = previousLibrary;
  }
});

test("ending map hover restores the selected segment without clearing its selection", () => {
  const selected = { key: "manual:1", coordinateSegments: [] };
  const hovered = { key: "manual:2", coordinateSegments: [] };
  const highlights = [];
  const view = Object.assign(Object.create(MapView.prototype), {
    selectedSegmentOverlay: selected,
    hoveredSegmentOverlay: hovered,
    segmentHighlightLayer: { clearLayers() {} },
    terrainView: { render: () => highlights.push(view.hoveredSegmentOverlay || view.selectedSegmentOverlay) }
  });
  view.clearSegmentHover();
  assert.equal(view.hoveredSegmentOverlay, null);
  assert.equal(view.selectedSegmentOverlay, selected);
  assert.deepEqual(highlights, [selected]);
});
