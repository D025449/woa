import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");

test("Google and Amazon use the shared Cognito social login flow", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "src/app.js"), "utf8");
  const loginTemplate = fs.readFileSync(path.join(projectRoot, "src/views/login.ejs"), "utf8");

  assert.match(appSource, /google:\s*{[\s\S]*?cognitoName:\s*"Google"/);
  assert.match(appSource, /amazon:\s*{[\s\S]*?cognitoName:\s*"LoginWithAmazon"/);
  assert.match(appSource, /app\.get\("\/auth\/google", startSocialLogin\("google"\)\)/);
  assert.match(appSource, /app\.get\("\/auth\/amazon", startSocialLogin\("amazon"\)\)/);
  assert.match(appSource, /req\.session\.oauthProvider = providerKey/);
  assert.match(loginTemplate, /href="\/auth\/google/);
  assert.match(loginTemplate, /href="\/auth\/amazon/);
});

test("every locale contains Amazon and shared social-login copy", () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(fs.readFileSync(
      path.join(projectRoot, `src/public/i18n/${locale}.json`),
      "utf8"
    ));

    assert.equal(typeof messages.login.continueWithAmazon, "string", locale);
    assert.equal(typeof messages.login.socialLoginFailed, "string", locale);
  }
});
