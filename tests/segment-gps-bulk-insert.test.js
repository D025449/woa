import assert from "node:assert/strict";
import test from "node:test";

import SegmentDBService from "../src/services/segmentDBService.js";
import pool from "../src/services/database.js";

test("GPS segment bulk insert sends bounds as text array and casts each value to box", async () => {
  const originalQuery = pool.query;
  let capturedQuery = "";
  let capturedValues = [];
  pool.query = async (query, values) => {
    capturedQuery = query;
    capturedValues = values;
    return { rows: [] };
  };

  try {
    await SegmentDBService.insertGpsSegmentsBulk(49, [
      {
        distance: 100,
        track: [{ lat: 49.5, lng: 8.67 }, { lat: 49.51, lng: 8.72 }],
        start: { lat: 49.5, lng: 8.67 },
        end: { lat: 49.51, lng: 8.72 }
      },
      {
        distance: 200,
        track: [{ lat: 49.39, lng: 8.7 }, { lat: 49.41, lng: 8.73 }],
        start: { lat: 49.39, lng: 8.7 },
        end: { lat: 49.41, lng: 8.73 }
      }
    ]);
  } finally {
    pool.query = originalQuery;
  }

  assert.match(capturedQuery, /u\.gps_bounds::box/);
  assert.match(capturedQuery, /\$16::text\[\]/);
  assert.deepEqual(capturedValues[15], [
    "(8.72,49.51),(8.67,49.5)",
    "(8.73,49.41),(8.7,49.39)"
  ]);
});
