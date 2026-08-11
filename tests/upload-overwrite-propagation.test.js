import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FileDBService } from "../src/services/fileDBService.js";

const uploadSource = fs.readFileSync(new URL("../src/public/js/upload-new.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../src/public/js/upload-new-worker.js", import.meta.url), "utf8");
const uploadViewSource = fs.readFileSync(new URL("../src/views/fileUploadNew.ejs", import.meta.url), "utf8");

test("upload keeps the submitted overwrite choice through conversion and backend upload", () => {
  assert.match(uploadSource, /\{ browserPostprocessBlob, browserGpsBestEffortsBlob, overwriteExisting \}/u);
  assert.match(uploadSource, /artifact\.overwriteExisting === true/u);
  assert.match(workerSource, /existingStartTimes: overwriteExisting \? \[\] : existingStartTimes/u);
  assert.match(uploadSource, /upload-new-worker\.js\?v=overwrite-propagation-1/u);
  assert.match(uploadViewSource, /upload-new\.js\?v=overwrite-propagation-1/u);
});

test("bulk workout inserts reserve parameters for terrain and intensity classification", () => {
  const prepared = {
    fileRow: {
      uid: 1,
      validGps: false,
      workout_type: "road",
      terrain_profile: "mountainous",
      intensity_profile: "vo2max",
      intensity_tags: 20,
      intensity_structure: "intervals",
      intensity_dose: "high",
      intensity_classifier_version: 3
    },
    gps_track: null,
    compressedBuffer: Buffer.from([1]),
    compressedGpsTrackBlob: null,
    streamCodec: "gzip",
    gpsTrackBlobCodec: "identity"
  };

  const params = FileDBService.buildPreparedInsertParams(prepared);
  assert.equal(params.length, 48);
  assert.equal(params[40], "mountainous");
  assert.deepEqual(params.slice(41, 46), ["vo2max", 20, "intervals", "high", 3]);
  assert.equal(params[46], null);
  assert.match(FileDBService.buildWorkoutInsertValuesClause(1), /\$96::jsonb/u);
});
