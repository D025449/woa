import assert from "node:assert/strict";
import test from "node:test";

import UserDBService from "../src/services/userDBService.js";

function createDatabase({ isFirstUser = true, existingUser = null, insertError = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes("SELECT NOT EXISTS")) {
        return { rows: [{ is_first_user: isFirstUser }], rowCount: 1 };
      }
      if (normalized.includes("INSERT INTO users")) {
        if (insertError) throw insertError;
        return {
          rows: [{ id: 17, auth_sub: values[0], email: values[1], display_name: values[3] }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: "RELEASE", values: [] });
    }
  };
  return {
    calls,
    database: {
      async query(sql, values = []) {
        const normalized = String(sql).replace(/\s+/gu, " ").trim();
        calls.push({ sql: normalized, values });
        return existingUser
          ? { rows: [existingUser], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
      async connect() { return client; }
    }
  };
}

test("an existing user uses the single-query fast path", async () => {
  const existingUser = { id: 9, auth_sub: "known", email: "known@example.com" };
  const { database, calls } = createDatabase({ existingUser });
  const user = await UserDBService.ensureUserExists({
    sub: "known",
    email: "known@example.com"
  }, database);

  assert.equal(user.id, 9);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sql.startsWith("UPDATE users"));
});

test("the first database user is atomically granted the admin role", async () => {
  const { database, calls } = createDatabase({ isFirstUser: true });
  const user = await UserDBService.ensureUserExists({
    sub: "google-sub",
    email: "rainersoltek@cwa24.de",
    email_verified: true,
    name: "Rainer"
  }, database);

  assert.equal(user.id, 17);
  assert.ok(calls.some((call) => call.sql.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO user_roles")));
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("later users are not granted an admin role", async () => {
  const { database, calls } = createDatabase({ isFirstUser: false });
  await UserDBService.ensureUserExists({
    sub: "later-sub",
    email: "later@example.com"
  }, database);

  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO user_roles")), false);
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
});

test("user provisioning rolls back when insertion fails", async () => {
  const { database, calls } = createDatabase({
    isFirstUser: true,
    insertError: new Error("insert failed")
  });

  await assert.rejects(
    UserDBService.ensureUserExists({ sub: "broken", email: "broken@example.com" }, database),
    /insert failed/
  );
  assert.ok(calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});
