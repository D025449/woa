import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUserAccountBackupFilename,
  USER_ACCOUNT_BACKUP_FORMAT,
  USER_ACCOUNT_BACKUP_VERSION,
  validateUserAccountBackup
} from "../src/services/userAccountBackupService.js";

function validBackup() {
  return {
    format: USER_ACCOUNT_BACKUP_FORMAT,
    version: USER_ACCOUNT_BACKUP_VERSION,
    createdAt: "2026-08-05T09:15:30.000Z",
    users: [{
      authSub: "cognito-user-1",
      email: "user@example.com",
      profile: null,
      paymentOrders: [{
        planCode: "pro-yearly",
        providerOrderId: "PAYPAL-ORDER-1"
      }],
      membership: {
        planCode: "pro-yearly"
      },
      roles: [{ role: "admin" }]
    }]
  };
}

test("account backup filename uses a compact UTC timestamp", () => {
  assert.equal(
    buildUserAccountBackupFilename(new Date("2026-08-05T09:15:30.123Z")),
    "cwa24-user-accounts-20260805T091530Z.json"
  );
});

test("account backup accepts the supported format", () => {
  const backup = validBackup();
  assert.equal(validateUserAccountBackup(backup), backup);
});

test("account backup rejects duplicate users and payment orders", () => {
  const duplicateUser = validBackup();
  duplicateUser.users.push({
    authSub: "cognito-user-1",
    email: "another@example.com"
  });
  assert.throws(() => validateUserAccountBackup(duplicateUser), /Duplicate authSub/);

  const duplicateOrder = validBackup();
  duplicateOrder.users.push({
    authSub: "cognito-user-2",
    email: "second@example.com",
    paymentOrders: [{
      planCode: "plus-yearly",
      providerOrderId: "PAYPAL-ORDER-1"
    }]
  });
  assert.throws(() => validateUserAccountBackup(duplicateOrder), /Duplicate providerOrderId/);
});

test("account backup rejects unknown formats and roles", () => {
  const wrongFormat = validBackup();
  wrongFormat.format = "something-else";
  assert.throws(() => validateUserAccountBackup(wrongFormat), /Unsupported account backup format/);

  const wrongRole = validBackup();
  wrongRole.users[0].roles = [{ role: "super-admin" }];
  assert.throws(() => validateUserAccountBackup(wrongRole), /Unsupported account role/);
});
