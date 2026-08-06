import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPasswordResetSecretHash,
  confirmPasswordReset,
  requestPasswordReset
} from "../src/services/passwordResetService.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");

test("password reset secret hash follows the Cognito app-client contract", () => {
  const expected = crypto
    .createHmac("sha256", "client-secret")
    .update("rainer@example.comclient-id")
    .digest("base64");

  assert.equal(
    buildPasswordResetSecretHash("rainer@example.com", "client-id", "client-secret"),
    expected
  );
  assert.equal(buildPasswordResetSecretHash("rainer@example.com", "client-id", ""), undefined);
});

test("password reset service sends the minimal Cognito commands", async () => {
  const previousClientId = process.env.COGNITO_CLIENT_ID;
  const previousClientSecret = process.env.COGNITO_CLIENT_SECRET;
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      return {};
    }
  };

  process.env.COGNITO_CLIENT_ID = "client-id";
  process.env.COGNITO_CLIENT_SECRET = "client-secret";

  try {
    await requestPasswordReset("rainer@example.com", client);
    await confirmPasswordReset({
      username: "rainer@example.com",
      confirmationCode: "123456",
      password: "A-new-password-123!"
    }, client);
  } finally {
    if (previousClientId === undefined) delete process.env.COGNITO_CLIENT_ID;
    else process.env.COGNITO_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.COGNITO_CLIENT_SECRET;
    else process.env.COGNITO_CLIENT_SECRET = previousClientSecret;
  }

  assert.equal(commands[0].constructor.name, "ForgotPasswordCommand");
  assert.deepEqual(Object.keys(commands[0].input).sort(), ["ClientId", "SecretHash", "Username"]);
  assert.equal(commands[0].input.Username, "rainer@example.com");

  assert.equal(commands[1].constructor.name, "ConfirmForgotPasswordCommand");
  assert.equal(commands[1].input.ConfirmationCode, "123456");
  assert.equal(commands[1].input.Password, "A-new-password-123!");
});

test("password reset routes keep account identity in the server-side session", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "src/app.js"), "utf8");
  const loginTemplate = fs.readFileSync(path.join(projectRoot, "src/views/login.ejs"), "utf8");
  const requestTemplate = fs.readFileSync(path.join(projectRoot, "src/views/forgot-password.ejs"), "utf8");
  const confirmTemplate = fs.readFileSync(path.join(projectRoot, "src/views/reset-password.ejs"), "utf8");

  assert.match(appSource, /app\.post\("\/forgot-password"/);
  assert.match(appSource, /req\.session\.passwordResetUsername = username/);
  assert.match(appSource, /res\.redirect\("\/reset-password"\)/);
  assert.doesNotMatch(appSource, /reset-password\?username=/);
  assert.match(appSource, /app\.post\("\/reset-password"/);
  assert.match(loginTemplate, /href="\/forgot-password"/);
  assert.match(requestTemplate, /action="\/forgot-password"/);
  assert.match(confirmTemplate, /action="\/reset-password"/);
  assert.match(confirmTemplate, /autocomplete="one-time-code"/);
  assert.match(confirmTemplate, /autocomplete="new-password"/);
});

test("every locale contains the complete password reset copy", () => {
  const locales = ["de", "en", "es", "fr", "it", "pt"];

  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(
      path.join(projectRoot, `src/public/i18n/${locale}.json`),
      "utf8"
    ));
    assert.equal(typeof messages.login.forgotPassword, "string", locale);
    assert.equal(typeof messages.passwordReset.request.neutralHint, "string", locale);
    assert.equal(typeof messages.passwordReset.confirm.newPassword, "string", locale);
    assert.equal(typeof messages.passwordReset.errors.codeExpired, "string", locale);
  }
});
