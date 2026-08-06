import assert from "node:assert/strict";
import test from "node:test";

import AdminUserRoleService, {
  AdminUserRoleError
} from "../src/services/adminUserRoleService.js";

function createRoleDatabase({
  admins = [1],
  users = [
    { id: 1, account_status: "active" },
    { id: 2, account_status: "active" }
  ]
} = {}) {
  const adminIds = new Set(admins.map(String));
  const usersById = new Map(users.map((user) => [String(user.id), user]));
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)
          || normalized.startsWith("LOCK TABLE")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("SELECT id, account_status FROM users")) {
        const user = usersById.get(String(values[0]));
        return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      }
      if (normalized.includes("SELECT COUNT(*)::integer AS admin_count")) {
        return { rows: [{ admin_count: adminIds.size }], rowCount: 1 };
      }
      if (normalized.includes("SELECT 1 FROM user_roles")) {
        const isAdmin = adminIds.has(String(values[0]));
        return { rows: isAdmin ? [{ "?column?": 1 }] : [], rowCount: isAdmin ? 1 : 0 };
      }
      if (normalized.startsWith("INSERT INTO user_roles")) {
        const userId = String(values[0]);
        const changed = !adminIds.has(userId);
        adminIds.add(userId);
        return { rows: changed ? [{ uid: userId }] : [], rowCount: changed ? 1 : 0 };
      }
      if (normalized.startsWith("DELETE FROM user_roles")) {
        const changed = adminIds.delete(String(values[0]));
        return { rows: [], rowCount: changed ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release() {
      calls.push({ sql: "RELEASE", values: [] });
    }
  };

  return {
    adminIds,
    calls,
    database: { async connect() { return client; } }
  };
}

test("granting an admin role is transactional and records the grantor", async () => {
  const { database, adminIds, calls } = createRoleDatabase();

  const result = await AdminUserRoleService.grantAdmin("1", "2", database);

  assert.deepEqual(result, { changed: true, userId: "2", isAdmin: true });
  assert.equal(adminIds.has("2"), true);
  assert.deepEqual(
    calls.filter((call) => ["BEGIN", "COMMIT", "RELEASE"].includes(call.sql)).map((call) => call.sql),
    ["BEGIN", "COMMIT", "RELEASE"]
  );
  assert.ok(calls.some((call) => call.sql.startsWith("LOCK TABLE user_roles")));
  assert.deepEqual(
    calls.find((call) => call.sql.startsWith("INSERT INTO user_roles")).values,
    ["2", "1"]
  );
});

test("granting an existing admin role is idempotent", async () => {
  const { database } = createRoleDatabase({ admins: [1, 2] });

  const result = await AdminUserRoleService.grantAdmin("1", "2", database);

  assert.equal(result.changed, false);
});

test("an administrator cannot revoke their own role", async () => {
  const { database, adminIds, calls } = createRoleDatabase({ admins: [1, 2] });

  await assert.rejects(
    AdminUserRoleService.revokeAdmin("1", "1", database),
    (error) => error instanceof AdminUserRoleError
      && error.code === "SELF_REVOKE_FORBIDDEN"
      && error.status === 409
  );

  assert.equal(adminIds.has("1"), true);
  assert.ok(calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("one administrator can revoke another while at least one remains", async () => {
  const { database, adminIds } = createRoleDatabase({ admins: [1, 2] });

  const result = await AdminUserRoleService.revokeAdmin("1", "2", database);

  assert.deepEqual(result, { changed: true, userId: "2", isAdmin: false });
  assert.deepEqual([...adminIds], ["1"]);
});

test("the acting administrator role is rechecked inside the transaction", async () => {
  const { database } = createRoleDatabase({ admins: [] });

  await assert.rejects(
    AdminUserRoleService.grantAdmin("1", "2", database),
    (error) => error instanceof AdminUserRoleError
      && error.code === "ACTOR_NOT_ADMIN"
      && error.status === 403
  );
});

test("inactive users cannot be promoted", async () => {
  const { database } = createRoleDatabase({
    users: [
      { id: 1, account_status: "active" },
      { id: 2, account_status: "pending_deletion" }
    ]
  });

  await assert.rejects(
    AdminUserRoleService.grantAdmin("1", "2", database),
    (error) => error instanceof AdminUserRoleError
      && error.code === "TARGET_NOT_ACTIVE"
      && error.status === 409
  );
});
