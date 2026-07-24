import test from "node:test";
import assert from "node:assert/strict";

import {
  SEGMENT_COLORS,
  getSegmentColor,
  getSegmentVisibilityKey,
  isSegmentVisible
} from "../src/public/js/segment-visibility.js";

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
