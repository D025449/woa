import test from "node:test";
import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";

const messages = JSON.parse(fs.readFileSync(new URL("../src/public/i18n/de.json", import.meta.url), "utf8"));
function render(name, extra = {}) {
  return ejs.renderFile(new URL("../src/views/" + name + ".ejs", import.meta.url).pathname, {
    i18n: { locale: "de", messages },
    t: key => key.split(".").reduce((value, part) => value?.[part], messages) ?? key,
    userInfo: { id: 1 },
    isAuthenticated: true,
    ...extra
  });
}

test("local import has its own controls and progress without Garmin or workflow guidance", async () => {
  const html = await render("fileUploadNew");
  assert.match(html, /id="uploadForm"/);
  assert.match(html, /id="submitButton"[^>]*>\s*Importieren\s*</);
  assert.match(html, /id="statusArea"/);
  assert.match(html, /id="overwriteExistingWorkouts"/);
  assert.doesNotMatch(html, /id="garmin-load"|garmin-import-messages|upload-guidance-panel/);
});

test("Garmin import shows connection setup without import controls when no key is saved", async () => {
  const html = await render("garminImport", { garminConfigured: false });
  assert.match(html, /Garmin verbinden/);
  assert.match(html, /href="\/profile#garmin-settings-title"/);
  assert.doesNotMatch(html, /id="garmin-load"|id="garmin-import-selected"|src="\/js\/garmin-import-page/);
});

test("configured Garmin import provides selection, overwrite, pagination and shared progress", async () => {
  const html = await render("garminImport", { garminConfigured: true });
  for (const id of ["garmin-load", "garmin-load-more", "garmin-import-selected", "overwriteExistingWorkouts", "statusArea", "response"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(html, /garmin-import-page\.js\?v=/);
  assert.match(html, /API-Schlüssel hinterlegt/);
  assert.match(html, /während des Imports geöffnet/);
  assert.doesNotMatch(html, /id="uploadForm"|type="file"|upload-guidance-panel/);
});
