import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import unzipper from "unzipper";

import StreamingZipFileWriter from "../src/services/streamingZipFileWriter.js";

test("logical backup ZIP writer persists entries without accumulating an archive buffer", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-logical-zip-test-"));
  const filePath = path.join(directory, "streamed.zip");
  try {
    const writer = new StreamingZipFileWriter(filePath);
    await writer.add("one.txt", new TextEncoder().encode("first"));
    await writer.add("nested/two.bin", new Uint8Array([1, 2, 3, 4]));
    const result = await writer.finish();

    assert.equal(result.filePath, filePath);
    assert.ok(result.sizeBytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);

    const archive = await unzipper.Open.file(filePath);
    const entries = new Map(archive.files.map((entry) => [entry.path, entry]));
    assert.equal((await entries.get("one.txt").buffer()).toString("utf8"), "first");
    assert.deepEqual([...await entries.get("nested/two.bin").buffer()], [1, 2, 3, 4]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
