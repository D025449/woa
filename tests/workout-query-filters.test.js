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

test("workout type groups use a parameterized list alongside existing filters", () => {
  const query = FileDBService.buildQueryParts(
    FileDBService.allowedColumns, FileDBService.numericFields, [],
    [{ field: "validgps", type: "=", value: true },
      { field: "workout_type", type: "in", value: ["road", "mountain", "indoor"] }]
  );
  assert.equal(query.whereSQL, "WHERE validgps = $1 AND workout_type = ANY($2::text[])");
  assert.deepEqual(query.params, [true, ["road", "mountain", "indoor"]]);
  for (const value of [[], ["road", "invalid"], "road", ["road'); DROP TABLE workouts; --"]]) {
    const invalid = FileDBService.buildQueryParts(FileDBService.allowedColumns, FileDBService.numericFields, [],
      [{ field: "workout_type", type: "in", value }]);
    assert.deepEqual(invalid.params, []);
    assert.doesNotMatch(invalid.whereSQL, /DROP|ANY/);
  }
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
