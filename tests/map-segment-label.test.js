import assert from "node:assert/strict";
import test from "node:test";
import MapView from "../src/public/js/map-view.js";
import WorkoutTerrainView from "../src/public/js/workout-terrain-view.js";
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
  const owner = { renderer: "3d", currentTrackSegments: [], segmentOverlayEntries: [] };
  const view = new WorkoutTerrainView({}, owner);
  const events = new Map();
  globalThis.maplibregl = {
    Map: class {
      constructor(value) { options = value; }
      addControl() {}
      on(name, ...args) { events.set(name, args.at(-1)); }
      getCanvas() { return { addEventListener() {} }; }
      addSource() {}
      addLayer() {}
      getSource() { return { setData() {} }; }
    },
    NavigationControl: class {}
  };
  try {
    view.open({ lat: 48, lng: 9 }, 12);
    assert.equal(view.failed, undefined);
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
