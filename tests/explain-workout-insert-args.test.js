import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

test("explain-workout-insert rejects unsupported variant", () => {
  const result = spawnSync(
    process.execPath,
    ["src/scripts/explain-workout-insert.js", "--variant", "bogus"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test"
      },
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported variant 'bogus'/);
});
