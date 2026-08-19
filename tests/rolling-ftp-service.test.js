import assert from "node:assert/strict";
import test from "node:test";

import pool from "../src/services/database.js";
import { FileDBService } from "../src/services/fileDBService.js";

test("coalesces concurrent rolling FTP snapshot calculations per user", async () => {
  const originalLoader = FileDBService.getRollingFtpEffortRows;
  let loadCount = 0;
  let releaseRows;
  const rowsReady = new Promise(resolve => {
    releaseRows = resolve;
  });

  FileDBService.getRollingFtpEffortRows = async () => {
    loadCount += 1;
    return rowsReady;
  };

  try {
    const first = FileDBService.getRollingFtpSnapshots(77);
    const second = FileDBService.getRollingFtpSnapshots(77);
    releaseRows([]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(loadCount, 1);
    assert.strictEqual(firstResult, secondResult);

    await FileDBService.getRollingFtpSnapshots(77);
    assert.equal(loadCount, 2);
  } finally {
    FileDBService.getRollingFtpEffortRows = originalLoader;
  }
});

test("loads one pivoted rolling FTP effort row per workout", async () => {
  const originalQuery = pool.query;
  let captured;
  pool.query = async (sql, values) => {
    captured = { sql, values };
    return { rows: [{ workout_id: 1, power_360: 300 }] };
  };

  try {
    const rows = await FileDBService.getRollingFtpEffortRows(77);
    assert.deepEqual(rows, [{ workout_id: 1, power_360: 300 }]);
    assert.match(captured.sql, /MAX\(s\.avg_power\) FILTER \(WHERE s\.duration = 360\) AS power_360/u);
    assert.match(captured.sql, /GROUP BY w\.id/u);
    assert.deepEqual(captured.values, [77, [360, 480, 720, 900, 960]]);
  } finally {
    pool.query = originalQuery;
  }
});
