import assert from "node:assert/strict";
import test from "node:test";
import ChartView from "../src/public/js/chart-view.js";
import { getCPSeriesColor } from "../src/shared/CriticalPowerAppearance.js";
import { getSegmentColor } from "../src/shared/SegmentAppearance.js";

function renderHeader(segment, width = 100) {
  const view = Object.create(ChartView.prototype);
  view.currentWorkout = { id: 1, segments: [segment] };
  view.getXAxisPixelExtent = () => ({ left: 0, right: 1000 });
  view.chart = { convertToPixel: (_axis, value) => value === 0 ? 0 : width };
  view.xAxisMode = "time";
  return view.buildSegmentHeaderGraphics()[0];
}

test("shared CP headers use the curve color only for the marker and retain the type color", () => {
  for (const duration of [5, 15, 60, 120, 240, 360, 480, 720, 900, 960, 1800]) {
    const segment = { id: 42, segmenttype: "crit", duration, start_offset: 0, end_offset: duration - 1 };
    const header = renderHeader(segment);
    const [background, dot, label] = header.children;
    assert.equal(background.style.fill, getSegmentColor(segment));
    assert.equal(background.style.stroke, getSegmentColor(segment));
    assert.equal(dot.type, "circle");
    assert.equal(dot.style.fill, getCPSeriesColor(duration));
    assert.equal(label.style.text, duration < 60 ? `CP${duration}S` : `CP${duration / 60}`);
    assert.equal(label.style.fill, "#ffffff");
    assert.equal(label.style.font, "800 8px sans-serif");
    assert.match(header.id, /crit-42/);
    assert.equal(typeof background.onclick, "function");
  }
});

test("other segment types retain their IDs and have no CP color marker", () => {
  for (const segmenttype of ["manual", "auto", "gps"]) {
    const segment = { id: 42, segmenttype, start_offset: 0, end_offset: 60 };
    const [background, label] = renderHeader(segment).children;
    assert.equal(background.style.fill, getSegmentColor(segment));
    assert.equal(label.type, "text");
    assert.equal(label.style.text, "S-42");
    assert.equal(label.style.fill, "#ffffff");
    assert.equal(label.style.font, "700 8px sans-serif");
  }
});

test("narrow CP headers omit the text without changing segment bounds", () => {
  const segment = { id: 42, segmenttype: "crit", duration: 5, start_offset: 0, end_offset: 4 };
  const header = renderHeader(segment, 20);
  assert.deepEqual(header.children.map((child) => child.type), ["rect", "circle"]);
  assert.equal(header.children[0].shape.width, 20);
});

test("every visible chart header primitive is above data lines with only its background translucent", () => {
  for (const segmenttype of ["crit", "manual", "auto", "gps"]) {
    const header = renderHeader({ id: 42, segmenttype, duration: 240, start_offset: 0, end_offset: 239 });
    assert.ok(header.children.every((child) => child.z === header.z && child.z > 4));
    assert.equal(header.children[0].style.opacity, 0.52);
    assert.ok(header.children.slice(1).every((child) => child.style.opacity === undefined));
  }
});

test("chart header hover and mouseout keep the translucent states consistent", () => {
  const view = Object.create(ChartView.prototype);
  const segment = { id: 42 };
  const target = { style: {}, attr(value) { this.style = value.style; } };
  view.chart = { dispatchAction() {} };
  view.showSegmentHoverTooltip = () => {};
  view.hideSegmentHoverTooltip = () => {};
  view.handleSegmentHeaderMouseOver(segment, { target });
  assert.equal(target.style.opacity, 0.84);
  view.handleSegmentHeaderMouseOut(segment, { target });
  assert.equal(target.style.opacity, 0.52);
  view.focusedSegment = segment;
  view.handleSegmentHeaderMouseOut(segment, { target });
  assert.equal(target.style.opacity, 0.78);
});
