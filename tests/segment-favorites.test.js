import assert from "node:assert/strict";
import test from "node:test";

import SegmentFavoriteService from "../src/services/segmentFavoriteService.js";

test("adding a segment favorite is idempotent", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{ segment_id: "42", created_at: new Date("2026-07-21T10:00:00Z") }]
      };
    }
  };

  const result = await SegmentFavoriteService.add(7, 42, db);

  assert.equal(result.segment_id, "42");
  assert.deepEqual(calls[0].params, [7, 42]);
  assert.match(calls[0].sql, /ON CONFLICT \(uid, segment_id\) DO NOTHING/);
});

test("removing a segment favorite is scoped to user and segment", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };

  const result = await SegmentFavoriteService.remove(7, 42, db);

  assert.equal(result, null);
  assert.deepEqual(calls[0].params, [7, 42]);
  assert.match(calls[0].sql, /WHERE uid = \$1\s+AND segment_id = \$2/);
});

test("listing segment favorites keeps database order and accessible filtering", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ segment_id: "17" }, { segment_id: "9" }] };
    }
  };

  const result = await SegmentFavoriteService.listAccessibleIds(7, db);

  assert.deepEqual(result, ["17", "9"]);
  assert.deepEqual(calls[0].params, [7]);
  assert.match(calls[0].sql, /ORDER BY sf\.created_at DESC/);
  assert.match(calls[0].sql, /gps_segment_group_shares/);
});
