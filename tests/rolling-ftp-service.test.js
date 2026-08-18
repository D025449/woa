import assert from "node:assert/strict";
import test from "node:test";

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
