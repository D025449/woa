import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import pool from "../src/services/database.js";
import Service, { encryptGarminKey, decryptGarminKey } from "../src/services/garminConnectionService.js";
import profileRoutes from "../src/routes/profileRoutes.js";

function configure(t) {
  const previous = process.env.GARMIN_API_ENCRYPTION_KEY;
  process.env.GARMIN_API_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  t.after(() => {
    if (previous === undefined) delete process.env.GARMIN_API_ENCRYPTION_KEY;
    else process.env.GARMIN_API_ENCRYPTION_KEY = previous;
  });
}

test("Garmin encryption authenticates user, ciphertext and key; uses fresh nonces", t => {
  configure(t);
  const one = encryptGarminKey(42, "private-example-key");
  const two = encryptGarminKey(42, "private-example-key");
  assert.notEqual(one, two);
  assert.ok(!one.includes("private-example-key"));
  assert.equal(decryptGarminKey(42, one), "private-example-key");
  assert.throws(() => decryptGarminKey(43, one));
  const parts = one.split(":");
  const bytes = Buffer.from(parts[3], "base64");
  bytes[0] ^= 1;
  parts[3] = bytes.toString("base64");
  assert.throws(() => decryptGarminKey(42, parts.join(":")));
  process.env.GARMIN_API_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.throws(() => decryptGarminKey(42, one));
  delete process.env.GARMIN_API_ENCRYPTION_KEY;
  assert.throws(() => encryptGarminKey(42, "example"), { statusCode: 503 });
});

test("Garmin persistence stores ciphertext only, returns status only and scopes to user", async t => {
  configure(t);
  const calls = [];
  t.mock.method(pool, "query", async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ updated_at: "2026-10-30T12:00:00Z" }] };
  });
  const result = await Service.save(42, "  private-example-key  ");
  assert.deepEqual(result, { configured: true, updatedAt: "2026-10-30T12:00:00Z" });
  assert.equal(calls[0].params[0], 42);
  assert.equal(decryptGarminKey(42, calls[0].params[1]), "private-example-key");
  assert.ok(!JSON.stringify(calls).includes("private-example-key"));
  assert.deepEqual(await Service.status(43), result);
  assert.match(calls.at(-1).sql, /SELECT updated_at .* WHERE user_id = \$1/);
  assert.deepEqual(calls.at(-1).params, [43]);
  await Service.remove(43);
  assert.match(calls.at(-1).sql, /DELETE .* WHERE user_id = \$1/);
  assert.deepEqual(calls.at(-1).params, [43]);
  const before = calls.length;
  for (const value of [undefined, null, {}, 123, "", "   ", "a\nb", "a".repeat(8193)]) {
    await assert.rejects(Service.save(42, value), { statusCode: 400 });
  }
  assert.equal(calls.length, before);
});

test("Garmin routes reject anonymous and inactive writes and never return the key", async t => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.cookies = {};
    if (req.headers["x-test-user"]) req.user = { id: 42, account_status: req.headers["x-test-status"] || "active" };
    next();
  });
  app.use("/api/profile", profileRoutes);
  const calls = [];
  for (const method of ["status", "save", "remove"]) {
    t.mock.method(Service, method, async (...args) => {
      calls.push({ method, args });
      return { configured: true, updatedAt: null };
    });
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/profile/garmin`;
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await fetch(base, { method });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
  for (const method of ["PUT", "DELETE"]) {
    const response = await fetch(base, { method, headers: { "x-test-user": "1", "x-test-status": "pending_deletion" } });
    assert.equal(response.status, 423);
  }
  assert.equal(calls.length, 0);
  const saved = await fetch(base, { method: "PUT", headers: { "x-test-user": "1", "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "example-key", userId: 99 }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), { data: { configured: true, updatedAt: null } });
  assert.deepEqual(calls.at(-1), { method: "save", args: [42, "example-key"] });
  assert.equal((await fetch(base, { method: "DELETE", headers: { "x-test-user": "1" } })).status, 204);
});
