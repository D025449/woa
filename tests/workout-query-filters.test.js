import assert from "node:assert/strict";
import test from "node:test";

import { FileDBService } from "../src/services/fileDBService.js";

test("workout query supports both valid and invalid GPS filters", () => {
  const valid = FileDBService.buildQueryParts(
    FileDBService.allowedColumns,
    FileDBService.numericFields,
    [],
    [{ field: "validgps", type: "=", value: true }]
  );
  const invalid = FileDBService.buildQueryParts(
    FileDBService.allowedColumns,
    FileDBService.numericFields,
    [],
    [{ field: "validgps", type: "=", value: false }]
  );

  assert.equal(valid.whereSQL, "WHERE validgps = $1");
  assert.deepEqual(valid.params, [true]);
  assert.equal(invalid.whereSQL, "WHERE validgps = $1");
  assert.deepEqual(invalid.params, [false]);
});

test("workout query supports terrain profile filters", () => {
  const query = FileDBService.buildQueryParts(
    FileDBService.allowedColumns,
    FileDBService.numericFields,
    [],
    [{ field: "terrain_profile", type: "=", value: "altitude_invalid" }]
  );

  assert.equal(query.whereSQL, "WHERE terrain_profile = $1");
  assert.deepEqual(query.params, ["altitude_invalid"]);
});

test("workout query supports intensity tag filters", () => {
  const query = FileDBService.buildQueryParts(
    FileDBService.allowedColumns,
    FileDBService.numericFields,
    [],
    [{ field: "intensity_tags", type: "bit_any", value: 16 }]
  );

  assert.equal(query.whereSQL, "WHERE (intensity_tags & $1::smallint) <> 0");
  assert.deepEqual(query.params, [16]);
});
