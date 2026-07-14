import assert from "node:assert/strict";
import test from "node:test";

import Workout from "../src/shared/Workout.js";

test("decodes mode 3 distance values in 0.5 meter units", () => {
  const payload = new Uint8Array(13);
  const view = new DataView(payload.buffer);
  payload[0] = 3;
  view.setUint16(1, 3, true);
  view.setUint32(3, 20, true);
  payload[7] = 2;
  payload[8] = 255;
  view.setUint32(9, 30, true);

  assert.deepEqual(
    Array.from(Workout.decodeWoaDistancePayload(payload, 3)),
    [10, 11, 15]
  );
});
