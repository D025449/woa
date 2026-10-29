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

test("analytics weights batch unique UTC dates and preserve separate CP/FTP reference dates", async t => {
  const cp = [
    { start_time: "2026-10-01T23:30:00Z", best_effort_avg_power: 300 },
    { start_time: "2026-10-01T12:00:00Z", best_effort_avg_power: 450 },
    { start_time: "2026-10-02T12:00:00Z", best_effort_avg_power: 320 },
    { start_time: "2026-10-03T12:00:00Z", best_effort_avg_power: 310 }
  ];
  const ftp = [{ startTime: "2026-10-02T10:00:00Z", ftp: 280 }];
  let calls = 0;
  t.mock.method(pool, "query", async (sql, params) => {
    calls++;
    assert.deepEqual(params, [42, ["2026-10-01", "2026-10-02", "2026-10-03"]]);
    assert.match(sql, /valid_from <= d.date/);
    assert.match(sql, /WHERE user_id = \$1/);
    return { rows: [
      { date: "2026-10-01", weight_kg: "75.00", source: "history" },
      { date: "2026-10-02", weight_kg: "80.00", source: "profile" },
      { date: "2026-10-03", weight_kg: null, source: null }
    ] };
  });
  await Service.enrichPowerRows(42, cp, ftp);
  assert.equal(calls, 1);
  assert.equal(cp[0].wattsPerKg, 4);
  assert.equal(cp[1].wattsPerKg, 6);
  assert.equal(cp[0].weightSource, "history");
  assert.equal(cp[2].weightSource, "profile");
  assert.equal(cp[3].wattsPerKg, null);
  assert.equal(ftp[0].weightDate, "2026-10-02");
  assert.equal(ftp[0].wattsPerKg, 3.5);
});
