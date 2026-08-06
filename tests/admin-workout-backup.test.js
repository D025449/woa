import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminWorkoutBackup,
  buildAdminWorkoutBackupFilename,
  decodeAdminWorkoutBackup,
  planAdminWorkoutMetadataImport,
  validateAdminWorkoutPreviewPayload
} from "../src/services/adminWorkoutBackupService.js";

function workout(id, uid, authSub, email, startTime) {
  return {
    id,
    uid,
    owner_auth_sub: authSub,
    owner_email: email,
    uploaded_at: "2026-08-05T10:00:00.000Z",
    start_time: startTime,
    end_time: "2026-08-05T11:00:00.000Z",
    total_timer_time: 3600,
    total_distance: 42000,
    stream: Buffer.from([1, 2, 3, 4]),
    stream_codec: "gzip",
    validgps: true,
    workout_type: "road",
    fit_device_metadata: { version: 1, devices: [{ product: 1 }] },
    segment_processing_status: "completed",
    segment_processing_updated_at: "2026-08-05T11:00:00.000Z",
    gps_track_blob: Buffer.from([5, 6, 7]),
    gps_track_blob_codec: "identity"
  };
}

test("admin workout backup preserves exact blobs, segments, favorites, and owner anchors", async () => {
  const archive = buildAdminWorkoutBackup({
    workouts: [
      workout(10, 7, "stable-a", "A@example.com", "2026-08-05T09:00:00.000Z"),
      workout(11, 8, "stable-b", "b@example.com", "2026-08-05T10:00:00.000Z")
    ],
    segments: [{
      wid: 10,
      segmenttype: "manual",
      segmentname: "Lap 1",
      start_offset: 10,
      end_offset: 70,
      duration: 60,
      avg_power: 250,
      created_at: "2026-08-05T10:00:00.000Z"
    }],
    favorites: [
      { uid: 8, workout_id: 10, owner_auth_sub: "stable-b", owner_email: "b@example.com" },
      { uid: 9, workout_id: 10, owner_auth_sub: "stable-c", owner_email: "c@example.com" }
    ]
  });

  const decoded = await decodeAdminWorkoutBackup(archive);
  assert.equal(decoded.owners.length, 3);
  assert.equal(decoded.owners[0].email, "a@example.com");
  assert.equal(decoded.workouts.length, 2);
  assert.deepEqual([...decoded.workouts[0].stream], [1, 2, 3, 4]);
  assert.deepEqual([...decoded.workouts[0].gpsTrackBlob], [5, 6, 7]);
  assert.equal(decoded.workouts[0].segments[0].segmentname, "Lap 1");
  assert.deepEqual(decoded.workouts[0].favoriteOwnerKeys, ["owner-2", "owner-3"]);
  assert.equal(decoded.manifest.segmentCount, 1);
  assert.equal(decoded.manifest.favoriteCount, 2);
});

test("admin workout backup rejects a missing workout stream", async () => {
  const archive = buildAdminWorkoutBackup({
    workouts: [workout(10, 7, "stable", "a@example.com", "2026-08-05T09:00:00.000Z")]
  });
  const { unzipSync, zipSync } = await import("fflate");
  const entries = unzipSync(archive);
  delete entries["workouts/owner-1/W-10.stream"];

  await assert.rejects(
    decodeAdminWorkoutBackup(Buffer.from(zipSync(entries, { level: 0 }))),
    /has no workout stream/u
  );
});

test("admin workout backup filename is stable and UTC based", () => {
  assert.equal(
    buildAdminWorkoutBackupFilename(new Date("2026-08-05T12:34:56.789Z")),
    "cwa24-admin-workouts-20260805T123456Z.zip"
  );
});

test("compact workout preview validates owner counts and null-start hashes", () => {
  const preview = validateAdminWorkoutPreviewPayload({
    format: "cwa24-admin-workouts",
    version: 1,
    createdAt: "2026-08-05T12:34:56.789Z",
    workoutCount: 2,
    owners: [{
      key: "owner-1",
      authSub: "stable-a",
      email: "A@example.com",
      sourceUid: "7",
      workoutCount: 2
    }],
    workouts: [
      [0, "2026-08-05T09:00:00.000Z", null],
      [0, null, "a".repeat(64)]
    ]
  });

  assert.equal(preview.owners[0].email, "a@example.com");
  assert.equal(preview.workouts[0].startTime, "2026-08-05T09:00:00.000Z");
  assert.equal(preview.workouts[1].streamHash, "a".repeat(64));
});

test("compact workout preview rejects missing null-start fingerprints", () => {
  assert.throws(() => validateAdminWorkoutPreviewPayload({
    format: "cwa24-admin-workouts",
    version: 1,
    createdAt: "2026-08-05T12:34:56.789Z",
    workoutCount: 1,
    owners: [{ key: "owner-1", authSub: "stable", workoutCount: 1 }],
    workouts: [[0, null, null]]
  }), /Missing stream hash/u);
});

test("compact workout plan returns concrete missing source and chunk references", async () => {
  const payload = {
    format: "cwa24-admin-workouts",
    version: 1,
    createdAt: "2026-08-05T12:34:56.789Z",
    workoutCount: 2,
    owners: [{
      key: "owner-1",
      authSub: "stable-a",
      email: "a@example.com",
      sourceUid: "7",
      workoutCount: 2
    }],
    workouts: [
      [0, "2026-08-05T09:00:00.000Z", null, "10", 0],
      [0, "2026-08-06T09:00:00.000Z", null, "11", 1]
    ]
  };
  const queryable = {
    async query(sql) {
      if (sql.includes("FROM users")) return { rows: [{ id: 70, auth_sub: "stable-a", email: "a@example.com" }] };
      if (sql.includes("start_time = ANY")) return { rows: [{ start_time: "2026-08-05T09:00:00.000Z" }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const plan = await planAdminWorkoutMetadataImport(payload, queryable);
  assert.equal(plan.preview.totals.importable, 1);
  assert.equal(plan.preview.totals.duplicates, 1);
  assert.deepEqual(plan.importableWorkouts.map(({ sourceId, chunkIndex }) => ({ sourceId, chunkIndex })), [
    { sourceId: "11", chunkIndex: 1 }
  ]);
});
