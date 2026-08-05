import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAdminBootstrapRequest } from "../src/services/adminBootstrapService.js";

test("admin bootstrap accepts a confirmed Cognito subject", () => {
  assert.deepEqual(normalizeAdminBootstrapRequest({
    authSub: "cognito-sub-1",
    confirm: "cognito-sub-1"
  }), {
    type: "auth-sub",
    value: "cognito-sub-1"
  });
});

test("admin bootstrap normalizes and confirms an email", () => {
  assert.deepEqual(normalizeAdminBootstrapRequest({
    email: "Admin@Example.COM",
    confirm: "ADMIN@example.com"
  }), {
    type: "email",
    value: "admin@example.com"
  });
});

test("admin bootstrap requires one selector and exact confirmation", () => {
  assert.throws(() => normalizeAdminBootstrapRequest({}), /exactly one/);
  assert.throws(() => normalizeAdminBootstrapRequest({
    authSub: "sub",
    email: "admin@example.com",
    confirm: "sub"
  }), /exactly one/);
  assert.throws(() => normalizeAdminBootstrapRequest({
    authSub: "sub",
    confirm: "different"
  }), /requires --confirm sub/);
});
