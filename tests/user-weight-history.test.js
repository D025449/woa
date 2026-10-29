import test from "node:test";
import assert from "node:assert/strict";
import pool from "../src/services/database.js";
import Service, { validateWeightDate, validateWeightEntry } from "../src/services/userWeightHistoryService.js";

test("weight history validates calendar dates and exact weight limits", () => {
  assert.equal(validateWeightDate("2024-02-29"), "2024-02-29");
  for (const value of ["2025-02-29", "2026-04-31", "0000-01-01", "2026-1-01", null, [], "infinity"]) {
    assert.throws(() => validateWeightDate(value), { statusCode: 400 });
  }
  for (const weightKg of [null, true, [], "", " ", "bad", Infinity, 0, -1, 500.01, 70.001]) {
    assert.throws(() => validateWeightEntry({ validFrom: "2026-01-01", weightKg }), { statusCode: 400 });
  }
  assert.equal(validateWeightEntry({ validFrom: "2026-01-01", weightKg: "500.00" }).weightKg, 500);
  assert.equal(validateWeightEntry({ validFrom: "2026-01-01", weightKg: "0.01" }).weightKg, 0.01);
});

test("history service scopes mutations, handles conflicts and resolves nullable weights", async t => {
  const calls = [];
  let result = { rows: [], rowCount: 0 };
  t.mock.method(pool, "query", async (sql, params) => {
    calls.push({ sql, params });
    if (result instanceof Error) throw result;
    return result;
  });
  result = { rows: [{ id: "9007199254740993", valid_from: "2026-03-01", weight_kg: "75.25" }] };
  assert.deepEqual(await Service.save(42, { validFrom: "2026-03-01", weightKg: 75.25 }, "7"),
    { id: "9007199254740993", validFrom: "2026-03-01", weightKg: 75.25 });
  assert.deepEqual(calls.at(-1).params, [42, "7", "2026-03-01", 75.25]);
  assert.match(calls.at(-1).sql, /WHERE user_id = \$1 AND id = \$2/);
  result = Object.assign(new Error("duplicate"), { code: "23505" });
  await assert.rejects(Service.save(42, { validFrom: "2026-03-01", weightKg: 75 }), { statusCode: 409 });
  result = { rows: [], rowCount: 0 };
  await assert.rejects(Service.remove(42, "7"), { statusCode: 404 });
  assert.deepEqual(calls.at(-1).params, [42, "7"]);
  await assert.rejects(Service.remove(42, "7 OR TRUE"), { statusCode: 400 });
  for (const [weight, source, validFrom] of [["75.25", "history", "2026-03-01"], ["80.00", "profile", null], [null, null, null]]) {
    result = { rows: [{ weight_kg: weight, source, valid_from: validFrom }] };
    assert.deepEqual(await Service.resolve(42, "2026-03-15"), {
      date: "2026-03-15", weightKg: weight == null ? null : Number(weight), source, validFrom
    });
    assert.deepEqual(calls.at(-1).params, [42, "2026-03-15"]);
    assert.match(calls.at(-1).sql, /valid_from <= \$2::date/);
    assert.match(calls.at(-1).sql, /ORDER BY valid_from DESC LIMIT 1/);
  }
});
