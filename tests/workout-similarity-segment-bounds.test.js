import assert from "node:assert/strict";
import test from "node:test";

import WorkoutSimilarityService from "../src/services/workoutSimilarityService.js";

function ratio(sampledPoints, projectedPolyline, options = {}) {
  return WorkoutSimilarityService.computePointMatchRatioProjected(
    sampledPoints,
    projectedPolyline,
    20,
    options
  );
}

test("projected segment bounds preserve route match results", () => {
  let seed = 0x5f3759df;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let run = 0; run < 100; run += 1) {
    const xs = new Float32Array(120);
    const ys = new Float32Array(120);
    for (let index = 1; index < xs.length; index += 1) {
      xs[index] = xs[index - 1] + 5 + random() * 20;
      ys[index] = ys[index - 1] + (random() - 0.5) * 30;
    }

    const sampledXs = new Float64Array(30);
    const sampledYs = new Float64Array(30);
    for (let index = 0; index < sampledXs.length; index += 1) {
      const sourceIndex = Math.min(xs.length - 1, index * 4);
      sampledXs[index] = xs[sourceIndex] + (random() - 0.5) * 300;
      sampledYs[index] = ys[sourceIndex] + (random() - 0.5) * 300;
    }

    const sampled = { xs: sampledXs, ys: sampledYs };
    const plain = { xs, ys };
    const bounded = {
      xs,
      ys,
      segmentBounds: WorkoutSimilarityService.buildProjectedSegmentBounds(xs, ys)
    };
    const options = {
      minRequiredRatio: 0.8,
      hardAbortDistanceMeters: 140
    };

    assert.equal(ratio(sampled, bounded, options), ratio(sampled, plain, options));
    assert.equal(ratio(sampled, bounded), ratio(sampled, plain));
  }
});
