import assert from "node:assert/strict";
import test from "node:test";

import SegmentDBService from "../src/services/segmentDBService.js";
import WorkoutDBService from "../src/services/workoutDBService.js";
import {
  addGpsSegmentBestEffortsBatchSummary,
  assertGpsSegmentBestEffortsWriteTarget,
  createGpsSegmentBestEffortsRebuildSummary,
  getGpsSegmentBestEffortsRebuildUsage,
  groupEligibleWorkoutsByOwner,
  parseGpsSegmentBestEffortsRebuildArgs
} from "../src/scripts/gps-segment-best-efforts-rebuild-helpers.js";

function createClient({ eligibleIds = null, existingRows = [], failInsert = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      const normalizedSql = String(sql).trim();
      queries.push({ sql: normalizedSql, params });
      if (normalizedSql.startsWith("SELECT id") && normalizedSql.includes("FROM workouts")) {
        const ids = eligibleIds ?? params[1];
        return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
      }
      if (normalizedSql.startsWith("SELECT")
        && normalizedSql.includes("FROM gps_segment_best_efforts effort")) {
        return { rowCount: existingRows.length, rows: existingRows };
      }
      if (failInsert && normalizedSql.startsWith("INSERT INTO gps_segment_best_efforts")) {
        throw new Error("insert failed");
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

async function withStubbedBatchRescan(results, callback) {
  const original = SegmentDBService.rescanSegmentBestEffortsForWorkoutsBatch;
  let received = null;
  SegmentDBService.rescanSegmentBestEffortsForWorkoutsBatch = async (uid, workoutIds, options) => {
    received = { uid, workoutIds, options };
    return results;
  };
  try {
    return await callback(() => received);
  } finally {
    SegmentDBService.rescanSegmentBestEffortsForWorkoutsBatch = original;
  }
}

test("normal bulk rescans stay missing-only and use the shared compact matcher", async () => {
  const originals = {
    loadTracks: WorkoutDBService.loadSimilarityTrackRowsBulk,
    loadCandidates: SegmentDBService.getMatchingSegmentCandidateIdsForWorkoutsBulk,
    loadDefinitions: SegmentDBService.loadSegmentMatchDefinitionsBulk
  };
  let candidateOptions = null;
  WorkoutDBService.loadSimilarityTrackRowsBulk = async () => new Map();
  SegmentDBService.getMatchingSegmentCandidateIdsForWorkoutsBulk = async (_uid, workoutIds, options) => {
    candidateOptions = options;
    return {
      candidatesByWorkoutId: new Map(workoutIds.map((workoutId) => [workoutId, []])),
      segmentIds: []
    };
  };
  SegmentDBService.loadSegmentMatchDefinitionsBulk = async () => new Map();

  try {
    const [result] = await SegmentDBService.rescanSegmentBestEffortsForWorkoutsBatch(49, [101]);
    assert.deepEqual(candidateOptions, { includeExistingBestEfforts: false });
    assert.equal(result.profile.matcherMode, "compact-e5");
    assert.deepEqual(result.matches, []);
  } finally {
    WorkoutDBService.loadSimilarityTrackRowsBulk = originals.loadTracks;
    SegmentDBService.getMatchingSegmentCandidateIdsForWorkoutsBulk = originals.loadCandidates;
    SegmentDBService.loadSegmentMatchDefinitionsBulk = originals.loadDefinitions;
  }
});

test("migration rebuild replaces all prior batch rows in one transaction", async () => {
  const preparedBestEffort = {
    sid: 30,
    wid: 101,
    start_offset: 20,
    end_offset: 50,
    duration: 30,
    avg_power: 250,
    avg_heart_rate: 155,
    avg_cadence: 91,
    avg_speed: 32.4
  };
  const client = createClient({
    existingRows: [
      { sid: 20, wid: 101, start_offset: 10, end_offset: 40 },
      { sid: 21, wid: 102, start_offset: 15, end_offset: 45 }
    ]
  });

  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [preparedBestEffort],
      profile: { gpsPointCount: 100 }
    },
    {
      workoutId: 102,
      matches: [],
      preparedBestEfforts: [],
      profile: { gpsPointCount: 100 }
    }
  ], async (getReceived) => {
    const result = await SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
      49,
      [101, 102],
      {
        apply: true,
        client,
        beforeCommit: async (_summary, transactionClient) => {
          await transactionClient.query("CHECKPOINT TEST");
        }
      }
    );

    assert.deepEqual(getReceived(), {
      uid: 49,
      workoutIds: [101, 102],
      options: {
        includeExistingBestEfforts: true,
        includePreparedBestEfforts: true,
        persistBestEfforts: false,
        compactMatcher: true
      }
    });
    assert.deepEqual(
      client.queries.map(({ sql }) => sql.split(/\s+/u).slice(0, 2).join(" ")),
      [
        "BEGIN",
        "LOCK TABLE",
        "SELECT id",
        "SELECT effort.sid,",
        "DELETE FROM",
        "INSERT INTO",
        "CHECKPOINT TEST",
        "COMMIT"
      ]
    );
    assert.deepEqual(client.queries[4].params, [49, [101, 102]]);
    assert.deepEqual(client.queries[5].params[0], [30]);
    assert.deepEqual(result, {
      workoutCount: 2,
      oldRowCount: 2,
      newRowCount: 1,
      addedMatchKeyCount: 1,
      removedMatchKeyCount: 2,
      changedRowCount: 0,
      results: [
        {
          workoutId: 101,
          matches: [],
          preparedBestEfforts: [preparedBestEffort],
          profile: { gpsPointCount: 100 }
        },
        {
          workoutId: 102,
          matches: [],
          preparedBestEfforts: [],
          profile: { gpsPointCount: 100 }
        }
      ]
    });
  });
});

test("migration rebuild deletes old rows when recomputation finds no matches", async () => {
  const client = createClient({
    existingRows: [{ sid: 20, wid: 101, start_offset: 10, end_offset: 40 }]
  });

  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [],
      profile: { gpsPointCount: 100 }
    }
  ], async () => {
    const result = await SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
      49,
      [101],
      { apply: true, client }
    );

    assert.equal(result.newRowCount, 0);
    assert.equal(result.removedMatchKeyCount, 1);
    assert.equal(
      client.queries.some(({ sql }) => sql.startsWith("DELETE FROM gps_segment_best_efforts")),
      true
    );
    assert.equal(
      client.queries.some(({ sql }) => sql.startsWith("INSERT INTO gps_segment_best_efforts")),
      false
    );
    assert.equal(client.queries.at(-1).sql, "COMMIT");
  });
});

test("migration rebuild dry-run reads counts without starting a transaction", async () => {
  const client = createClient({
    existingRows: [{ sid: 20, wid: 101, start_offset: 10, end_offset: 40 }]
  });

  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [],
      profile: { gpsPointCount: 100 }
    }
  ], async () => {
    await SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
      49,
      [101],
      { client }
    );
  });

  assert.deepEqual(
    client.queries.map(({ sql }) => sql.split(/\s+/u).slice(0, 2).join(" ")),
    ["SELECT id", "SELECT effort.sid,"]
  );
});

test("migration rebuild rolls back a failed replacement", async () => {
  const client = createClient({ failInsert: true });
  const row = {
    sid: 30,
    wid: 101,
    start_offset: 20,
    end_offset: 50,
    duration: 30,
    avg_power: 250,
    avg_heart_rate: 155,
    avg_cadence: 91,
    avg_speed: 32.4
  };

  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [row],
      profile: { gpsPointCount: 100 }
    }
  ], async () => {
    await assert.rejects(
      SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
        49,
        [101],
        { apply: true, client }
      ),
      /insert failed/u
    );
  });

  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
  assert.equal(client.queries.some(({ sql }) => sql === "COMMIT"), false);
});

test("migration rebuild refuses to delete rows for ineligible or undecodable workouts", async () => {
  const ineligibleClient = createClient({ eligibleIds: [] });
  await withStubbedBatchRescan([], async () => {
    await assert.rejects(
      SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
        49,
        [101],
        { apply: true, client: ineligibleClient }
      ),
      /ineligible workout IDs: 101/u
    );
  });
  assert.deepEqual(
    ineligibleClient.queries.map(({ sql }) => sql.split(/\s+/u).slice(0, 2).join(" ")),
    ["BEGIN", "LOCK TABLE", "SELECT id", "ROLLBACK"]
  );

  const undecodableClient = createClient();
  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [],
      profile: { gpsPointCount: 0 }
    }
  ], async () => {
    await assert.rejects(
      SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
        49,
        [101],
        { apply: true, client: undecodableClient }
      ),
      /empty decoded GPS tracks: 101/u
    );
  });
  assert.equal(undecodableClient.queries.at(-1).sql, "ROLLBACK");
});

test("migration rebuild reports metric changes for stable match keys", async () => {
  const row = {
    sid: 30,
    wid: 101,
    start_offset: 20,
    end_offset: 50,
    duration: 30,
    avg_power: 250,
    avg_heart_rate: 155,
    avg_cadence: 91,
    avg_speed: 32.4
  };
  const client = createClient({
    existingRows: [{ ...row, avg_power: 240 }]
  });

  await withStubbedBatchRescan([
    {
      workoutId: 101,
      matches: [],
      preparedBestEfforts: [row],
      profile: { gpsPointCount: 100 }
    }
  ], async () => {
    const result = await SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
      49,
      [101],
      { client }
    );
    assert.equal(result.addedMatchKeyCount, 0);
    assert.equal(result.removedMatchKeyCount, 0);
    assert.equal(result.changedRowCount, 1);
  });
});

test("CLI arguments default to dry-run and require explicit write confirmation", () => {
  assert.deepEqual(parseGpsSegmentBestEffortsRebuildArgs([]), {
    apply: false,
    batchSize: 100,
    confirmDatabase: null,
    help: false,
    limit: null,
    rerunCompleted: false
  });

  const applyOptions = parseGpsSegmentBestEffortsRebuildArgs([
    "--apply",
    "--confirm-db",
    "cwa24_dev",
    "--batch-size",
    "25",
    "--limit",
    "50"
  ]);
  assert.doesNotThrow(() => assertGpsSegmentBestEffortsWriteTarget(applyOptions, "cwa24_dev"));
  assert.throws(
    () => assertGpsSegmentBestEffortsWriteTarget(applyOptions, "cwa24_prod"),
    /confirmation mismatch/u
  );
  assert.throws(
    () => assertGpsSegmentBestEffortsWriteTarget({ apply: true }, "cwa24_dev"),
    /requires --confirm-db/u
  );
  assert.throws(
    () => parseGpsSegmentBestEffortsRebuildArgs(["--rerun-completed"]),
    /only valid together with --apply/u
  );
});

test("CLI helpers group owners and accumulate batch accounting", () => {
  assert.deepEqual(groupEligibleWorkoutsByOwner([
    { id: "10", uid: "49" },
    { id: "11", uid: "50" },
    { id: "12", uid: "49" }
  ]), [
    { uid: 49, workoutIds: [10, 12] },
    { uid: 50, workoutIds: [11] }
  ]);

  const summary = addGpsSegmentBestEffortsBatchSummary(
    createGpsSegmentBestEffortsRebuildSummary(),
    {
      workoutCount: 3,
      oldRowCount: 5,
      newRowCount: 4,
      addedMatchKeyCount: 2,
      removedMatchKeyCount: 3,
      changedRowCount: 1,
      elapsedMs: 125
    }
  );
  assert.deepEqual(summary, {
    processedWorkouts: 3,
    oldRows: 5,
    newRows: 4,
    addedMatchKeys: 2,
    removedMatchKeys: 3,
    changedRows: 1,
    elapsedMs: 125,
    batches: 1
  });
  assert.match(getGpsSegmentBestEffortsRebuildUsage(), /default is dry-run/u);
  assert.match(getGpsSegmentBestEffortsRebuildUsage(), /--apply --confirm-db cwa24_prod/u);
});
