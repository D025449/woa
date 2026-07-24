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
