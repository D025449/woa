import test from "node:test";
import assert from "node:assert/strict";

import Utils from "../src/shared/Utils.js";

test("CP short labels use minutes and an explicit seconds suffix below one minute", () => {
  for (const [duration, expected] of [[5, "CP5S"], [15, "CP15S"], [60, "CP1"],
    [120, "CP2"], [240, "CP4"], [480, "CP8"], [900, "CP15"], [1800, "CP30"]]) {
    assert.equal(Utils.getSegmentShortLabel({ id: 42, segmenttype: "crit", duration }), expected);
  }
  assert.equal(Utils.getSegmentShortLabel({ segmenttype: "crit", duration: "60" }), "CP1");
  for (const duration of [null, undefined, 0, -1, "invalid"]) {
    assert.equal(Utils.getSegmentShortLabel({ id: 42, segmenttype: "crit", duration }), "S-42");
  }
  assert.equal(Utils.getSegmentShortLabel({ id: 42, segmenttype: "manual", duration: 60 }), "S-42");
  assert.equal(Utils.getSegmentShortLabel({ id: 42, sid: 91, isGPSSegment: true, duration: 60 }), "S-91");
});

test("segment labels include the workout-local segment id", () => {
  const label = Utils.formatSegmentLabel({
    id: 42,
    segmenttype: "manual",
    segmentname: "Anstieg",
    duration: 95
  });

  assert.match(label, /^Anstieg · S-42\n/);
});

test("GPS segment labels and tooltips use sid instead of the effort row id", () => {
  const segment = {
    id: 9876,
    sid: 91,
    isGPSSegment: true,
    duration: 61,
    avg_power: 250
  };

  assert.match(Utils.formatSegmentLabel(segment), /^GPS Segment · S-91\n/);
  assert.match(Utils.formatSegmentTooltip(segment), /GPS Segment · S-91/);
  assert.doesNotMatch(Utils.formatSegmentTooltip(segment), /#9876/);
});

test("GPS segment headings use persisted start and end names", () => {
  const segment = {
    sid: 91,
    isGPSSegment: true,
    start_name: "Bad Urach",
    end_name: "Hohenwittlingen",
    duration: 480
  };

  assert.equal(
    Utils.getSegmentDisplayHeading(segment),
    "Bad Urach → Hohenwittlingen · S-91"
  );
});

test("segment headings remain unchanged when no persisted id exists", () => {
  assert.equal(
    Utils.formatSegmentLabel({ segmenttype: "manual", duration: null }),
    "manual Segment"
  );
});
