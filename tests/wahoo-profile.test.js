import test from "node:test";
import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";

test("Wahoo profile renders localized controls and usable message data in every supported language", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(fs.readFileSync(new URL(`../src/public/i18n/${locale}.json`, import.meta.url), "utf8"));
    const html = await ejs.renderFile(new URL("../src/views/profile.ejs", import.meta.url).pathname, {
      i18n: { locale, messages }, locale, supportedLocales: ["de", "en", "es", "fr", "it", "pt"],
      t: key => key.split(".").reduce((value, part) => value?.[part], messages) ?? key,
      userInfo: { id: 42 }, isAuthenticated: true
    });
    assert.match(html, /id="wahoo-connect"[^>]*disabled/);
    assert.match(html, /id="wahoo-remove"[^>]*disabled/);
    assert.ok(html.includes(messages.profile.wahoo.connect));
    const data = JSON.parse(html.match(/id="wahoo-settings-messages"[^>]*>([^<]+)<\/script>/)[1]);
    assert.equal(data.connected, messages.profile.wahoo.connected);
    assert.equal(data.error, messages.profile.wahoo.error);
    assert.doesNotMatch(html, /profile\.wahoo\./);
    assert.match(html, /\/js\/wahoo-settings-ui.js\?v=2/);
  }
});

test("personal API key controls render in the account facet in all supported languages", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(fs.readFileSync(new URL(`../src/public/i18n/${locale}.json`, import.meta.url), "utf8"));
    const html = await ejs.renderFile(new URL("../src/views/profile.ejs", import.meta.url).pathname, {
      i18n: { locale, messages }, locale, supportedLocales: ["de", "en", "es", "fr", "it", "pt"],
      t: key => key.split(".").reduce((value, part) => value?.[part], messages) ?? key,
      userInfo: { id: 42 }, isAuthenticated: true
    });
    assert.match(html, /id="account"[\s\S]*id="api-keys"/);
    assert.match(html, /id="api-key-create"[^>]*disabled/);
    assert.match(html, /id="api-key-secret"[^>]*type="password"[^>]*readonly/);
    assert.match(html, /id="api-key-secret-panel"[^>]*hidden/);
    const data = JSON.parse(html.match(/id="api-keys-messages"[^>]*>([^<]+)<\/script>/)[1]);
    assert.equal(data.locale, locale);
    assert.equal(data.readScope, messages.profile.apiKeys.readScope);
    assert.equal(data.gpsScope, messages.profile.apiKeys.gpsScope);
    assert.equal(data.fitScope, messages.profile.apiKeys.fitScope);
    assert.equal(data.analyticsScope, messages.profile.apiKeys.analyticsScope);
    assert.ok(html.includes(messages.profile.apiKeys.fitHint));
    assert.match(html, /id="api-key-fit"[^>]*type="checkbox"/);
    assert.match(html, /id="api-key-analytics"[^>]*type="checkbox"/);
    assert.ok(html.includes(messages.profile.apiKeys.analyticsHint));
    assert.doesNotMatch(html, /profile\.apiKeys\./);
    assert.match(html, /\/js\/api-keys-ui\.js\?v=3/);
  }
});
