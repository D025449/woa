import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENSITY_MODEL_FEATURE_BYTES,
  decodeWorkoutIntensityModelFeatures,
  encodeWorkoutIntensityModelFeatures
} from "../src/shared/WorkoutIntensityModelCodec.js";

test("stores the historical power-duration model in 18 bytes", () => {
  const encoded = encodeWorkoutIntensityModelFeatures({
    bestEfforts: {
      30: [{ avgPower: 510 }],
      60: [{ avgPower: 450 }],
      120: [{ avgPower: 390 }],
      240: [{ avgPower: 340 }],
      480: [{ avgPower: 300 }],
      900: [{ avgPower: 280 }],
      1200: [{ avgPower: 270 }]
    }
  });

  assert.equal(encoded.byteLength, INTENSITY_MODEL_FEATURE_BYTES);
  const decoded = decodeWorkoutIntensityModelFeatures(encoded);
  assert.equal(decoded.bestEfforts[30][0].avgPower, 510);
  assert.equal(decoded.bestEfforts[1200][0].avgPower, 270);
});

test("rejects malformed historical intensity features", () => {
  assert.equal(decodeWorkoutIntensityModelFeatures(new Uint8Array(18)), null);
});
