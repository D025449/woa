import assert from "node:assert/strict";
import test from "node:test";

import { decodeWoa1BufferLight } from "../src/services/woa1Service.js";
import { writeWorkoutIntensityHeader } from "../src/shared/WorkoutIntensityHeader.js";
import { encodeWorkoutIntensityModelFeatures } from "../src/shared/WorkoutIntensityModelCodec.js";
import { INTENSITY_TAG_BITS } from "../src/shared/WorkoutIntensityTags.js";

function buildContainer({ majorVersion, meta = {}, session = [], workout = [], gps = [], trailer = [] }) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const sessionBytes = Uint8Array.from(session);
  const workoutBytes = Uint8Array.from(workout);
  const gpsBytes = Uint8Array.from(gps);
  const trailerBytes = Uint8Array.from(trailer);
  const bytes = new Uint8Array(
    24 + metaBytes.length + sessionBytes.length + workoutBytes.length + gpsBytes.length + trailerBytes.length
  );
  const view = new DataView(bytes.buffer);

  bytes.set(new TextEncoder().encode("WOA1"), 0);
  view.setUint8(4, majorVersion);
  view.setUint32(8, metaBytes.length, true);
  view.setUint32(12, sessionBytes.length, true);
  view.setUint32(16, workoutBytes.length, true);
  view.setUint32(20, gpsBytes.length, true);

  let offset = 24;
  bytes.set(metaBytes, offset);
  offset += metaBytes.length;
  bytes.set(sessionBytes, offset);
  offset += sessionBytes.length;
  bytes.set(workoutBytes, offset);
  offset += workoutBytes.length;
  bytes.set(gpsBytes, offset);
  offset += gpsBytes.length;
  bytes.set(trailerBytes, offset);
  return bytes;
}

test("rejects legacy WOA version 1 containers", () => {
  const bytes = buildContainer({ majorVersion: 1 });

  assert.throws(
    () => decodeWoa1BufferLight(bytes),
    /Unsupported WOA version 1; version 2 or newer is required/
  );
});

test("reads intensity classification and model features without decoding workout data", () => {
  const trailer = encodeWorkoutIntensityModelFeatures({
    bestEfforts: { 480: [{ avgPower: 315 }], 1200: [{ avgPower: 275 }] }
  });
  const bytes = buildContainer({
    majorVersion: 2,
    meta: { persistedRow: {} },
    trailer
  });
  writeWorkoutIntensityHeader(bytes, {
    profile: "vo2max",
    tags: INTENSITY_TAG_BITS.vo2max | INTENSITY_TAG_BITS.tempo,
    structure: "intervals",
    dose: "high",
    classifierVersion: 2
  });

  const decoded = decodeWoa1BufferLight(bytes);
  assert.equal(decoded.meta.persistedRow.intensity_profile, "vo2max");
  assert.equal(
    decoded.meta.persistedRow.intensity_tags,
    INTENSITY_TAG_BITS.vo2max | INTENSITY_TAG_BITS.tempo
  );
  assert.equal(decoded.meta.persistedRow.intensity_structure, "intervals");
  assert.equal(decoded.meta.persistedRow.intensity_dose, "high");
  assert.equal(decoded.meta.persistedRow.intensity_classifier_version, 2);
  assert.deepEqual([...decoded.meta.persistedRow.intensity_model_features], [...trailer]);
});

test("slices current WOA blocks without decoding workout data", () => {
  const bytes = buildContainer({
    majorVersion: 2,
    meta: { persistedRow: { avg_speed: 29.5 } },
    session: [9, 9],
    workout: [1, 2, 3],
    gps: [4, 5]
  });

  const decoded = decodeWoa1BufferLight(bytes);

  assert.equal(decoded.majorVersion, 2);
  assert.equal(decoded.meta.persistedRow.avg_speed, 29.5);
  assert.deepEqual([...decoded.workoutStreamStoredBytes], [1, 2, 3]);
  assert.deepEqual([...decoded.gpsTrackStoredBytes], [4, 5]);
  assert.equal("sessions" in decoded, false);
});
