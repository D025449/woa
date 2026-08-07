import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  SEGMENT_COLORS,
  getSegmentColor,
  getSegmentVisibilityKey,
  isSegmentVisible
} from "../src/public/js/segment-visibility.js";
import { buildMarkAreas } from "../src/public/js/chart-helpers.js";

test("maps every workout segment representation to its UI visibility key", () => {
  assert.equal(getSegmentVisibilityKey({ segmenttype: "crit" }), "criticalPower");
  assert.equal(getSegmentVisibilityKey({ segmenttype: "auto" }), "auto");
  assert.equal(getSegmentVisibilityKey({ segmenttype: "manual" }), "manual");
  assert.equal(getSegmentVisibilityKey({ segmenttype: "gps" }), "gps");
  assert.equal(getSegmentVisibilityKey({ isGPSSegment: true, segmenttype: "manual" }), "gps");
});

test("provides distinct and consistent colors for every segment type", () => {
  assert.equal(getSegmentColor({ segmenttype: "crit" }), SEGMENT_COLORS.criticalPower.solid);
  assert.equal(getSegmentColor({ segmenttype: "auto" }), SEGMENT_COLORS.auto.solid);
  assert.equal(getSegmentColor({ segmenttype: "manual" }), SEGMENT_COLORS.manual.solid);
  assert.equal(getSegmentColor({ isGPSSegment: true }), SEGMENT_COLORS.gps.solid);
  assert.equal(SEGMENT_COLORS.gps.solid, "#22a957");
  assert.equal(new Set(Object.values(SEGMENT_COLORS).map(({ solid }) => solid)).size, 4);
});

test("uses the same visibility decision for chart and map segments", () => {
  const visibility = {
    criticalPower: false,
    auto: true,
    manual: false,
    gps: true
  };

  assert.equal(isSegmentVisible({ segmenttype: "crit" }, visibility), false);
  assert.equal(isSegmentVisible({ segmenttype: "auto" }, visibility), true);
  assert.equal(isSegmentVisible({ segmenttype: "manual" }, visibility), false);
  assert.equal(isSegmentVisible({ isGPSSegment: true }, visibility), true);
  assert.equal(isSegmentVisible(null, visibility), false);
});

test("filters GPS chart areas before relying on segment ids", () => {
  const visibility = {
    criticalPower: true,
    auto: true,
    manual: true,
    gps: false
  };
  const workout = {
    segments: [
      {
        id: 12,
        rowstate: "DB",
        segmenttype: "crit",
        start_offset: 10,
        end_offset: 30
      },
      {
        id: null,
        sid: 91,
        rowstate: "DB",
        isGPSSegment: true,
        segmenttype: "gps",
        start_offset: 40,
        end_offset: 80
      }
    ]
  };

  const areas = buildMarkAreas(workout, {
    isVisible: (segment) => isSegmentVisible(segment, visibility)
  });

  assert.equal(areas.length, 1);
  assert.equal(areas[0][0].segmentId, 12);
});

test("focused map segments use a fixed high-contrast casing instead of their type color", async () => {
  const source = await fs.readFile(
    new URL("../src/public/js/map-view.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /SEGMENT_FOCUS_COLOR = "#2563eb"/u);
  assert.match(source, /segmentHighlightPane/u);
  assert.match(source, /color: "#ffffff"[\s\S]*?weight: casingWeight/u);
  assert.match(source, /focusSegmentOverlay\(segment/u);
  assert.match(source, /const lineWeight = isHover \? 5 : 7/u);
});

test("chart and map segment hover mark the matching workout segment card", async () => {
  const [chartSource, controllerSource, cssSource] = await Promise.all([
    fs.readFile(new URL("../src/public/js/chart-view.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/js/dashboard-new-controller.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/css/dashboard-new.css", import.meta.url), "utf8")
  ]);

  assert.match(chartSource, /onSegmentHoverChange\?\.\(segment\)/u);
  assert.match(chartSource, /onSegmentHoverChange\?\.\(null\)/u);
  assert.match(controllerSource, /setHoveredWorkoutSegment\(segment\)/u);
  assert.match(controllerSource, /is-segment-hovered/u);
  assert.match(cssSource, /\.dashboard-workout-segment\.is-segment-hovered/u);
});

test("Leaflet segment interactions synchronize hover and selection with chart and cards", async () => {
  const [mapSource, controllerSource] = await Promise.all([
    fs.readFile(new URL("../src/public/js/map-view.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/js/dashboard-new-controller.js", import.meta.url), "utf8")
  ]);

  assert.match(mapSource, /hitLine\.on\("mouseover"[\s\S]*?onSegmentHoverChange\?\.\(entry\.segment\)/u);
  assert.match(mapSource, /hitLine\.on\("mouseout"[\s\S]*?onSegmentHoverChange\?\.\(null\)/u);
  assert.match(mapSource, /onSegmentSelectionChange\?\.\(selectedSegment\)/u);
  assert.match(controllerSource, /onSegmentSelectionChange: \(segment\)/u);
  assert.match(controllerSource, /this\.chartView\.focusSegment\(segment\)/u);
  assert.match(controllerSource, /this\.chartView\.clearSegmentFocus\(\{ resetZoom: true \}\)/u);
});
