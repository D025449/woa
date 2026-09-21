import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  default as SegmentElevationProfileService,
  buildSegmentTrackSampleDistances,
  normalizeWorkoutAltitudeProfile,
  profileRmse,
  selectDominantWorkoutAltitudeCluster
} from "../src/services/segmentElevationProfileService.js";
import { resolveActiveSegmentAltitudeProfile } from "../src/services/segmentDBService.js";
import {
  addGpsSegmentElevationProfileBatch,
  assertGpsSegmentElevationProfileWriteTarget,
  createGpsSegmentElevationProfileSummary,
  getGpsSegmentElevationProfileRebuildUsage,
  parseGpsSegmentElevationProfileRebuildArgs
} from "../src/scripts/gps-segment-elevation-profile-rebuild-helpers.js";

const baseSegmentSchemaUrl = new URL("../src/migrations/007_gps_segments.sql", import.meta.url);
const manualReferenceMigrationUrl = new URL(
  "../src/migrations/086_gps_segment_manual_altitude_reference.sql",
  import.meta.url
);

test("normalizes a workout altitude profile to the segment point count", () => {
  const altitudes = normalizeWorkoutAltitudeProfile({
    points: [
      { distanceKm: 0, altitude: 200 },
      { distanceKm: 0.5, altitude: 250 },
      { distanceKm: 1, altitude: 300 }
    ]
  }, 5, 1000);

  assert.deepEqual(altitudes, [200, 225, 250, 275, 300]);
});

test("normalizes workout altitude at the actual segment track distances", () => {
  const altitudes = normalizeWorkoutAltitudeProfile({
    points: [
      { distanceKm: 0, altitude: 200 },
      { distanceKm: 0.5, altitude: 250 },
      { distanceKm: 1, altitude: 300 }
    ]
  }, 5, 1000, [0, 100, 400, 700, 1000]);

  assert.deepEqual(altitudes, [200, 210, 240, 270, 300]);
});

test("builds segment sample distances from its non-uniform track geometry", () => {
  const distances = buildSegmentTrackSampleDistances([
    { lat: 49, lng: 8 },
    { lat: 49.001, lng: 8 },
    { lat: 49.004, lng: 8 }
  ], 800);

  assert.ok(distances);
  assert.equal(distances[0], 0);
  assert.ok(Math.abs(distances[1] - 200) < 0.01);
  assert.ok(Math.abs(distances[2] - 800) < 0.01);
});

test("selects the measured dominant cluster and rejects a parallel-shifted outlier", () => {
  const candidates = [
    { workoutId: 1, altitudes: [215, 260, 320, 411] },
    { workoutId: 2, altitudes: [216, 261, 319, 410] },
    { workoutId: 3, altitudes: [214, 259, 321, 412] },
    { workoutId: 4, altitudes: [215, 260, 320, 410] },
    { workoutId: 5, altitudes: [217, 261, 322, 413] },
    { workoutId: 6, altitudes: [106, 151, 211, 298] }
  ];

  const result = selectDominantWorkoutAltitudeCluster(candidates, {
    radiusMeters: 15,
    minClusterSize: 5,
    minClusterFraction: 0.6
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.cluster.length, 5);
  assert.notEqual(result.medoid.workoutId, 6);
  assert.ok(result.dispersionMeters < 3);
  assert.ok(profileRmse(result.medoid.altitudes, candidates[5].altitudes) > 100);
});

test("keeps a small measured cluster in candidate state", () => {
  const result = selectDominantWorkoutAltitudeCluster([
    { workoutId: 1, altitudes: [215, 300, 411] },
    { workoutId: 2, altitudes: [216, 301, 410] }
  ], {
    radiusMeters: 15,
    minClusterSize: 5,
    minClusterFraction: 0.6
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.cluster.length, 2);
  assert.ok(result.medoid);
});

test("confirms a three-profile cluster with the default forty-percent rule", () => {
  const result = selectDominantWorkoutAltitudeCluster([
    { workoutId: 1, altitudes: [215, 300, 411] },
    { workoutId: 2, altitudes: [216, 301, 410] },
    { workoutId: 3, altitudes: [214, 299, 412] },
    { workoutId: 4, altitudes: [150, 235, 346] },
    { workoutId: 5, altitudes: [275, 360, 471] }
  ]);

  assert.equal(result.confirmed, true);
  assert.equal(result.cluster.length, 3);
});

test("does not confirm fewer than three matching profiles", () => {
  const result = selectDominantWorkoutAltitudeCluster([
    { workoutId: 1, altitudes: [215, 300, 411] },
    { workoutId: 2, altitudes: [216, 301, 410] }
  ]);

  assert.equal(result.confirmed, false);
  assert.equal(result.cluster.length, 2);
});

test("uses only complete confirmed or stale workout profiles as active elevation", () => {
  const base = {
    points_count: 3,
    altitudes: [230, 320, 420],
    start_altitude: 230,
    end_altitude: 420,
    ascent: 205,
    workout_altitudes: [215, 310, 411],
    workout_start_altitude: 215,
    workout_end_altitude: 411,
    workout_ascent: 196,
    workout_altitude_candidate_count: 20,
    workout_altitude_cluster_count: 18,
    workout_altitude_dispersion: 1.2,
    workout_altitude_algorithm_version: 1,
    workout_altitude_source_wid: 90384,
    workout_altitude_manual: true
  };

  const candidate = resolveActiveSegmentAltitudeProfile({
    ...base,
    workout_altitude_status: "candidate"
  });
  assert.equal(candidate.source, "external");
  assert.deepEqual(candidate.altitudes, base.altitudes);

  const confirmed = resolveActiveSegmentAltitudeProfile({
    ...base,
    workout_altitude_status: "confirmed"
  });
  assert.equal(confirmed.source, "workout");
  assert.deepEqual(confirmed.altitudes, base.workout_altitudes);
  assert.equal(confirmed.startAltitude, 215);
  assert.equal(confirmed.manual, true);
  assert.equal(confirmed.sourceWorkoutId, 90384);

  const stale = resolveActiveSegmentAltitudeProfile({
    ...base,
    workout_altitude_status: "stale"
  });
  assert.equal(stale.source, "workout");

  const incomplete = resolveActiveSegmentAltitudeProfile({
    ...base,
    workout_altitude_status: "confirmed",
    workout_altitudes: [215, 411]
  });
  assert.equal(incomplete.source, "external");
});

test("upload post-processing leaves manual altitude references untouched", async () => {
  const queryable = {
    async query(sql) {
      assert.match(sql, /workout_altitude_manual = false/u);
      return { rows: [] };
    }
  };

  assert.deepEqual(await SegmentElevationProfileService.markSegmentsStale([23], queryable), []);
});

test("base schema and additive migration define the manual reference flag", async () => {
  const [baseSchema, migration] = await Promise.all([
    readFile(baseSegmentSchemaUrl, "utf8"),
    readFile(manualReferenceMigrationUrl, "utf8")
  ]);

  for (const sql of [baseSchema, migration]) {
    assert.match(sql, /workout_altitude_manual BOOLEAN NOT NULL DEFAULT FALSE/u);
  }
});

test("retains only a complete previously confirmed profile during recalculation", () => {
  const complete = {
    points_count: 3,
    workout_altitudes: [215, 310, 411],
    workout_start_altitude: 215,
    workout_end_altitude: 411,
    workout_ascent: 196
  };

  assert.equal(SegmentElevationProfileService.hasConfirmedStoredProfile({
    ...complete,
    workout_altitude_status: "stale"
  }), true);
  assert.equal(SegmentElevationProfileService.hasConfirmedStoredProfile({
    ...complete,
    workout_altitude_status: "candidate"
  }), false);
  assert.equal(SegmentElevationProfileService.hasConfirmedStoredProfile({
    ...complete,
    workout_altitude_status: "confirmed",
    workout_altitudes: [215, 411]
  }), false);
});

test("elevation-profile migration defaults to a read-only dry run and guards writes", () => {
  assert.deepEqual(parseGpsSegmentElevationProfileRebuildArgs([]), {
    apply: false,
    batchSize: 32,
    confirmDatabase: null,
    help: false,
    limit: null,
    rerunCompleted: false
  });

  const apply = parseGpsSegmentElevationProfileRebuildArgs([
    "--apply",
    "--confirm-db",
    "cwa24_prod_restore_20260805_144216",
    "--batch-size",
    "16",
    "--limit",
    "40"
  ]);
  assert.doesNotThrow(() => assertGpsSegmentElevationProfileWriteTarget(
    apply,
    "cwa24_prod_restore_20260805_144216"
  ));
  assert.throws(
    () => assertGpsSegmentElevationProfileWriteTarget(apply, "cwa24_prod"),
    /confirmation mismatch/u
  );
  assert.throws(
    () => assertGpsSegmentElevationProfileWriteTarget({ apply: true }, "cwa24_prod"),
    /requires --confirm-db/u
  );
  assert.throws(
    () => parseGpsSegmentElevationProfileRebuildArgs(["--rerun-completed"]),
    /only valid together with --apply/u
  );
  assert.match(getGpsSegmentElevationProfileRebuildUsage(), /read-only dry run/u);
});

test("elevation-profile migration summarizes calculated segment states", () => {
  const summary = addGpsSegmentElevationProfileBatch(
    createGpsSegmentElevationProfileSummary(),
    [
      { workout_altitude_status: "confirmed" },
      { workout_altitude_status: "confirmed", retained: true },
      { workout_altitude_status: "candidate" },
      { workout_altitude_status: "unavailable" }
    ]
  );
  assert.deepEqual(summary, {
    processedSegments: 4,
    confirmedSegments: 2,
    candidateSegments: 1,
    unavailableSegments: 1,
    retainedSegments: 1,
    batches: 1
  });
});

test("dry-run elevation-profile rebuild calculates without persisting", async () => {
  const originalLoadSegments = SegmentElevationProfileService.loadSegmentsForRebuild;
  const originalLoadCandidates = SegmentElevationProfileService.loadCandidatesForSegments;
  const originalPersist = SegmentElevationProfileService.persistResult;
  const originalRetain = SegmentElevationProfileService.retainConfirmedResult;
  try {
    SegmentElevationProfileService.loadSegmentsForRebuild = async () => new Map([[42, {
      id: 42,
      uid: 7,
      distance: 1000,
      points_count: 3,
      workout_altitude_status: "unavailable"
    }]]);
    SegmentElevationProfileService.loadCandidatesForSegments = async () => new Map([[42, []]]);
    SegmentElevationProfileService.persistResult = async () => {
      throw new Error("dry run persisted a result");
    };
    SegmentElevationProfileService.retainConfirmedResult = async () => {
      throw new Error("dry run retained a result");
    };

    const results = await SegmentElevationProfileService.rebuildSegments([42], { persist: false });
    assert.deepEqual(results, [{
      id: 42,
      uid: 7,
      workout_altitude_status: "unavailable",
      candidate_count: 0,
      cluster_count: 0,
      dispersion_meters: null,
      source_workout_id: null,
      retained: false
    }]);
  } finally {
    SegmentElevationProfileService.loadSegmentsForRebuild = originalLoadSegments;
    SegmentElevationProfileService.loadCandidatesForSegments = originalLoadCandidates;
    SegmentElevationProfileService.persistResult = originalPersist;
    SegmentElevationProfileService.retainConfirmedResult = originalRetain;
  }
});
