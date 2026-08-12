import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOCALES = ["de", "en", "es", "fr", "it", "pt"];
const REQUIRED_KEYS = [
  "trainingEffectLabel",
  "intensitySummaryPrimary",
  "intensitySummaryWithAdditional",
  "intensityStructureSteady",
  "intensityStructureVariable",
  "intensityStructureIntervals",
  "intensityDoseLow",
  "intensityDoseModerate",
  "intensityDoseHigh"
];

test("every locale contains the workout intensity presentation copy", async () => {
  for (const locale of LOCALES) {
    const messages = JSON.parse(await readFile(new URL(`../src/public/i18n/${locale}.json`, import.meta.url)));
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof messages.dashboardNewPage?.[key], "string", `${locale}: ${key}`);
      assert.notEqual(messages.dashboardNewPage[key].trim(), "", `${locale}: ${key}`);
    }
  }
});
