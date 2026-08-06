import assert from "node:assert/strict";
import test from "node:test";

import deleteLogicalBackupObjects from "../src/services/logicalBackupDelete.js";

test("logical backup deletion batches data objects and removes the manifest last", async () => {
  const root = "backups/logical/production/cwa24/2026/08/06/example";
  const objects = Array.from({ length: 1001 }, (_, index) => ({
    Key: `${root}/workouts/chunk-${index}.zip`,
    Size: 10
  }));
  objects.splice(500, 0, { Key: `${root}/manifest.json`, Size: 20 });
  const calls = [];
  const progress = [];
  const s3 = {
    async send(command) {
      calls.push(command.input.Delete.Objects.map((object) => object.Key));
      return {};
    }
  };

  const result = await deleteLogicalBackupObjects({
    s3,
    bucket: "backup-bucket",
    root,
    objects,
    progress: async (percent, phase, details) => progress.push({ percent, phase, details })
  });

  assert.deepEqual(calls.map((keys) => keys.length), [1000, 1, 1]);
  assert.equal(calls.at(-1)[0], `${root}/manifest.json`);
  assert.equal(calls.slice(0, -1).flat().includes(`${root}/manifest.json`), false);
  assert.deepEqual(result, { deletedObjects: 1002, deletedBytes: 10030 });
  assert.equal(progress.at(-1).percent, 100);
});

test("logical backup deletion keeps the manifest when a data batch fails", async () => {
  const root = "backups/logical/production/cwa24/2026/08/06/example";
  const calls = [];
  const s3 = {
    async send(command) {
      calls.push(command.input.Delete.Objects.map((object) => object.Key));
      return { Errors: [{ Key: `${root}/workouts/chunk.zip`, Code: "AccessDenied" }] };
    }
  };

  await assert.rejects(
    deleteLogicalBackupObjects({
      s3,
      bucket: "backup-bucket",
      root,
      objects: [
        { Key: `${root}/workouts/chunk.zip`, Size: 10 },
        { Key: `${root}/manifest.json`, Size: 20 }
      ]
    }),
    /could not delete 1 logical backup object/u
  );
  assert.deepEqual(calls, [[`${root}/workouts/chunk.zip`]]);
});
