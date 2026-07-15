import assert from "node:assert/strict";
import test from "node:test";

import { buildImportScopedJobId } from "../src/services/import-scoped-job-id.js";

test("import-scoped BullMQ job IDs remain distinct without adding colon segments", () => {
  const baseJobId = "process-workout-segment-best-efforts:49:472543";
  const firstImport = buildImportScopedJobId(baseJobId, "371");
  const secondImport = buildImportScopedJobId(baseJobId, "372");

  assert.equal(firstImport, "process-workout-segment-best-efforts:49:472543-import-371");
  assert.equal(secondImport, "process-workout-segment-best-efforts:49:472543-import-372");
  assert.notEqual(firstImport, secondImport);
  assert.equal(firstImport.split(":").length, 3);
});

test("manual jobs retain their stable base ID", () => {
  const baseJobId = "persist-workout-segments:49:472543";
  assert.equal(buildImportScopedJobId(baseJobId, null), baseJobId);
});
