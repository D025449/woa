import assert from "node:assert/strict";
import test from "node:test";

import pool from "../src/services/database.js";
import { FileDBService } from "../src/services/fileDBService.js";

test("critical-power query uses bounded transaction-local sort memory", async () => {
  const originalConnect = pool.connect;
  const queries = [];
  let released = false;
  pool.connect = async () => ({
    async query(sql, values) {
      queries.push({ sql, values });
      return sql.includes("get_cp_best_efforts") ? { rows: [{ duration: 300 }] } : { rows: [] };
    },
    release() {
      released = true;
    }
  });

  try {
    const rows = await FileDBService.getCPBestEfforts("year_week", [300], 77);
    assert.deepEqual(rows, [{ duration: 300 }]);
    assert.deepEqual(queries.map(({ sql }) => sql.trim()), [
      "BEGIN READ ONLY",
      "SET LOCAL work_mem = '8MB'",
      "SELECT *\n    FROM get_cp_best_efforts($1, $2, $3)",
      "COMMIT"
    ]);
    assert.deepEqual(queries[2].values, ["year_week", [300], 77]);
    assert.equal(released, true);
  } finally {
    pool.connect = originalConnect;
  }
});
