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
    assert.match(html, /\/js\/wahoo-settings-ui.js\?v=1/);
  }
});
