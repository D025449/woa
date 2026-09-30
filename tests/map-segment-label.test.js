import assert from "node:assert/strict";
import test from "node:test";
import MapView from "../src/public/js/map-view.js";
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
