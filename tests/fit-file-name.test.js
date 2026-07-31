import assert from "node:assert/strict";
import test from "node:test";

import { formatFitExportFileName } from "../src/shared/FitFileName.js";

test("FIT export filename uses the requested timezone during summer time", () => {
  assert.equal(
    formatFitExportFileName("2026-07-31T06:56:53.000Z", { timeZone: "Europe/Berlin" }),
    "2026-07-31-08-56-53.fit"
  );
});
test("FIT export filename observes winter time in the requested timezone", () => {
  assert.equal(
    formatFitExportFileName("2026-01-31T06:56:53.000Z", { timeZone: "Europe/Berlin" }),
    "2026-01-31-07-56-53.fit"
  );
});

test("FIT export filename falls back to UTC for invalid timezone input", () => {
  assert.equal(
    formatFitExportFileName("2026-07-31T06:56:53.000Z", { timeZone: "not/a-zone" }),
    "2026-07-31-06-56-53.fit"
  );
});
