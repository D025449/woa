import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pool from "../src/services/database.js";
import Connection from "../src/services/wahooConnectionService.js";
import ImportService from "../src/services/wahooImportService.js";
import router from "../src/routes/wahooWebhookRoutes.js";
import { validWebhookToken, receiveWahooWebhook } from "../src/services/wahooWebhookService.js";
import { convertWahooFit, importWahooEvent, processNextWahooImport } from "../src/services/wahooWebhookImportService.js";
import FitExport from "../src/shared/FitExportService.js";
import { decodeWoa1BufferLight } from "../src/services/woa1Service.js";

const token = "test-webhook-token-".repeat(3);
const payload = { event_type: "workout_summary", webhook_token: token, user: { id: 123 }, workout_summary: { id: 456, workout: { id: 789 }, file: { url: "https://evil.example/private" } } };
const event = { id: "1", user_id: "42", wahoo_user_id: "123", workout_id: "789", workout_summary_id: "456", attempts: 1 };
function configure(t) {
  const old = process.env.WAHOO_WEBHOOK_TOKEN;
  process.env.WAHOO_WEBHOOK_TOKEN = token;
  t.after(() => { if (old === undefined) delete process.env.WAHOO_WEBHOOK_TOKEN; else process.env.WAHOO_WEBHOOK_TOKEN = old; });
}
function fit(length = 310) {
  return FitExport.buildFitFromWorkout({ length, getStartTime: () => Date.UTC(2026, 10, 1),
    hasDistanceSeries: () => true, getDistanceAt: i => i * 5, getSpeedAt: () => 18,
    getPowerAt: () => 200, getHrAt: () => 140, getCadenceAt: () => 85, getAltitudeAt: () => 100
  }, { includeGps: false });
}

test("Wahoo token check rejects missing, incorrect and unconfigured tokens", t => {
  configure(t);
  assert.equal(validWebhookToken(token), true);
  for (const value of [null, {}, token + "x", "x".repeat(token.length)]) assert.equal(validWebhookToken(value), false);
  process.env.WAHOO_WEBHOOK_TOKEN = "short";
  assert.equal(validWebhookToken("short"), false);
});

test("Wahoo inbox inserts identifiers only for enabled active connections and deduplicates", async t => {
  const calls = [];
  t.mock.method(pool, "query", async (...args) => { calls.push(args); return { rows: [] }; });
  await receiveWahooWebhook(payload);
  assert.deepEqual(calls[0][1], ["123", "456", "789"]);
  assert.match(calls[0][0], /auto_import_enabled = TRUE/);
  assert.match(calls[0][0], /offline_data_granted = TRUE/);
  assert.match(calls[0][0], /account_status = 'active'/);
  assert.match(calls[0][0], /ON CONFLICT.*DO NOTHING/);
  assert.ok(!JSON.stringify(calls).includes(token));
  assert.ok(!JSON.stringify(calls).includes("evil.example"));
  await receiveWahooWebhook({ event_type: "other" });
  assert.equal(calls.length, 1);
});

test("Wahoo public webhook authenticates without session and sanitizes parser/database errors", async t => {
  configure(t);
  let calls = 0;
  let fail = false;
  t.mock.method(pool, "query", async () => { calls++; if (fail) throw new Error("private database token"); return { rows: [] }; });
  const app = express(); app.use("/webhooks/wahoo", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/webhooks/wahoo`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body)
  });
  assert.equal((await post({ ...payload, webhook_token: "wrong" })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await post({ ...payload, user: { id: 0 } })).status, 400);
  assert.equal((await post("{broken")).status, 400);
  assert.equal((await post(JSON.stringify({ padding: "x".repeat(65537) }))).status, 413);
  assert.equal(calls, 0);
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 200);
  assert.equal(calls, 2);
  fail = true;
  const response = await post(payload);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private"));
});

test("Wahoo FIT conversion uses the real parser, preserves metadata and skips short workouts", async () => {
  const converted = await convertWahooFit(fit());
  const decoded = decodeWoa1BufferLight(converted);
  assert.equal(new Date(decoded.meta.persistedRow.start_time).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.ok(decoded.workoutStreamStoredBytes.byteLength > 0);
  assert.equal(await convertWahooFit(fit(10)), null);
  await assert.rejects(convertWahooFit(Buffer.from("invalid")), /Wahoo conversion failed/);
});

test("Wahoo worker skips disconnected, inactive or disabled connections without downloading", async t => {
  t.mock.method(ImportService, "file", async () => assert.fail("No download"));
  assert.equal(await importWahooEvent({ query: async () => ({ rows: [] }) }, event), "skipped");
});

test("Wahoo worker rechecks the connection after download and locks it through persistence", async t => {
  t.mock.method(ImportService, "file", async (...args) => {
    assert.deepEqual(args, ["42", "789", "456"]); return Buffer.from("fit");
  });
  for (const enabled of [false, true]) {
    const calls = [];
    let allowed = 0;
    let saved = false;
    const client = { async query(sql, params) {
      calls.push([sql, params]);
      if (sql.includes("FROM user_wahoo_connections")) return { rows: ++allowed === 1 || enabled ? [{ user_id: "42" }] : [] };
      return { rows: [] };
    } };
    assert.equal(await importWahooEvent(client, { ...event, attempts: 2 }, {
      convert: async () => Buffer.from("woa"),
      persist: async (received, woa) => { saved = true; assert.equal(received.user_id, "42"); assert.equal(woa.toString(), "woa"); }
    }), enabled ? "completed" : "skipped");
    assert.equal(saved, enabled);
    assert.match(calls[2][0], /FOR SHARE OF c, u/);
    assert.equal(calls.at(-1)[0], "COMMIT");
  }
});

test("Wahoo worker skips existing start times without persisting or overwriting", async t => {
  const woa = await convertWahooFit(fit());
  t.mock.method(ImportService, "file", async () => fit());
  const client = { async query(sql, params) {
    if (sql.includes("FROM user_wahoo_connections")) return { rows: [{ user_id: "42" }] };
    if (sql.includes("FROM workouts")) { assert.equal(params[0], "42"); return { rows: [{ id: "existing" }] }; }
    return { rows: [] };
  } };
  assert.equal(await importWahooEvent(client, event, { convert: async () => woa, persist: async () => assert.fail("Duplicate must be skipped") }), "skipped");
});

test("Wahoo worker commits persistence-time overlap skips instead of retrying them", async t => {
  const calls = [];
  t.mock.method(ImportService, "file", async () => Buffer.from("fit"));
  const client = { async query(sql) {
    calls.push(sql);
    return { rows: sql.includes("FROM user_wahoo_connections") ? [{ user_id: "42" }] : [] };
  } };

  const result = await importWahooEvent(client, { ...event, attempts: 2 }, {
    convert: async () => Buffer.from("woa"),
    persist: async () => "skipped"
  });

  assert.equal(result, "skipped");
  assert.equal(calls.at(-1), "COMMIT");
  assert.equal(calls.includes("ROLLBACK"), false);
});

for (const fail of [false, true]) {
  test(`Wahoo durable worker ${fail ? "retries with bounded sanitized failures" : "completes claims and releases advisory locks"}`, async t => {
    const calls = [];
    const client = { async query(sql, params) {
      calls.push([sql, params]);
      if (sql.startsWith("SELECT id")) return { rows: [{ id: "1" }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("RETURNING *")) return { rows: [event] };
      return { rows: [] };
    }, release() { calls.push(["release"]); } };
    t.mock.method(pool, "connect", async () => client);
    assert.equal(await processNextWahooImport(async (receivedClient, received) => {
      assert.equal(receivedClient, client); assert.equal(received, event);
      if (fail) throw new Error("private provider response"); return "completed";
    }), true);
    const update = calls.at(-3);
    if (fail) {
      assert.match(update[0], /attempts >= 5 THEN 'failed'/);
      assert.deepEqual(update[1], ["1", 30]);
      assert.ok(!JSON.stringify(calls).includes("private"));
    } else assert.deepEqual(update[1], ["1", "completed"]);
    assert.match(calls.at(-2)[0], /pg_advisory_unlock/);
    assert.equal(calls.at(-1)[0], "release");
  });
}

test("Wahoo setting requires offline authorization and server configuration", async t => {
  configure(t);
  const calls = [];
  t.mock.method(pool, "query", async (...args) => { calls.push(args); return { rowCount: 1 }; });
  await Connection.setAutoImport(42, true);
  assert.deepEqual(calls[0][1], [42, true]);
  assert.match(calls[0][0], /offline_data_granted = TRUE AND wahoo_user_id IS NOT NULL/);
  await assert.rejects(Connection.setAutoImport(42, "true"));
  delete process.env.WAHOO_WEBHOOK_TOKEN;
  await assert.rejects(Connection.setAutoImport(42, true));
  await Connection.setAutoImport(42, false);
  t.mock.method(pool, "query", async () => ({ rowCount: 0 }));
  await assert.rejects(Connection.setAutoImport(42, false));
});
