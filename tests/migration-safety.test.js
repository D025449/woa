import assert from "node:assert/strict";
import test from "node:test";

import { assertLegacyMigrationTargetIsEmpty } from "../src/migrate-internal.js";

test("legacy migrations are allowed for an empty schema", async () => {
  const pool = {
    async query() {
      return { rows: [{ users: null, workouts: null }] };
    }
  };

  await assert.doesNotReject(
    assertLegacyMigrationTargetIsEmpty(pool)
  );
});

test("legacy migrations are rejected before touching an existing app schema", async () => {
  const pool = {
    async query() {
      return { rows: [{ users: "users", workouts: "workouts" }] };
    }
  };

  await assert.rejects(
    assertLegacyMigrationTargetIsEmpty(pool),
    /Refusing to replay the legacy migration set/
  );
});

test("an explicitly confirmed rebuild may replay the legacy migrations", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [{ users: "users", workouts: "workouts" }] };
    }
  };

  await assert.doesNotReject(
    assertLegacyMigrationTargetIsEmpty(pool, { allowExistingSchema: true })
  );
  assert.equal(queried, false);
});
