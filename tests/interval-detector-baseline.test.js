import assert from "node:assert/strict";
import test from "node:test";

import IntervalDetector from "../src/shared/IntervalDetector.js";

function sortedBaseline(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.3)];
}

test("quickselect baseline matches the previous full sort", () => {
  let state = 0x9e3779b9;
  const random = () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (const length of [1, 2, 3, 7, 32, 127, 1024, 7200]) {
    const values = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      values[index] = Math.round(random() * 500) / 7;
    }

    const original = values.slice();
    assert.equal(IntervalDetector.computeBaseline(values), sortedBaseline(values));
    assert.deepEqual(values, original);
  }
});

test("quickselect baseline handles repeated and ordered values", () => {
  const samples = [
    new Float32Array(1000).fill(0),
    Float32Array.from({ length: 1000 }, (_, index) => index),
    Float32Array.from({ length: 1000 }, (_, index) => 999 - index),
    Float32Array.from({ length: 1000 }, (_, index) => index % 5)
  ];

  for (const values of samples) {
    assert.equal(IntervalDetector.computeBaseline(values), sortedBaseline(values));
  }
});
