import assert from "node:assert/strict";
import test from "node:test";

import {
  readWorkoutIntensityHeader,
  writeWorkoutIntensityHeader
} from "../src/shared/WorkoutIntensityHeader.js";
import { INTENSITY_TAG_BITS } from "../src/shared/WorkoutIntensityTags.js";

test("packs workout intensity classification into reserved WOA header bytes", () => {
  const bytes = new Uint8Array(24);
  writeWorkoutIntensityHeader(bytes, {
    profile: "vo2max",
    tags: INTENSITY_TAG_BITS.vo2max | INTENSITY_TAG_BITS.tempo,
    structure: "intervals",
    dose: "high",
    classifierVersion: 2
  });

  assert.deepEqual(readWorkoutIntensityHeader(bytes), {
    profile: "vo2max",
    structure: "intervals",
    dose: "high",
    tags: INTENSITY_TAG_BITS.vo2max | INTENSITY_TAG_BITS.tempo,
    classifierVersion: 2
  });
  assert.equal(bytes.byteLength, 24);
});

test("reads untouched legacy WOA headers as unknown classification", () => {
  assert.deepEqual(readWorkoutIntensityHeader(new Uint8Array(24)), {
    profile: "unknown",
    structure: "unknown",
    dose: "unknown",
    tags: 0,
    classifierVersion: 0
  });
});

test("reads the primary profile as tag from the previous header encoding", () => {
  const bytes = new Uint8Array(24);
  bytes[6] = 5;
  bytes[7] = 2;

  assert.deepEqual(readWorkoutIntensityHeader(bytes), {
    profile: "vo2max",
    structure: "unknown",
    dose: "unknown",
    tags: INTENSITY_TAG_BITS.vo2max,
    classifierVersion: 2
  });
});
