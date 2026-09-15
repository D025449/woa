import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFitExportArchivePath,
  formatFitExportFileName
} from "../src/shared/FitFileName.js";

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

test("FIT archive path groups files by local year and month", () => {
  assert.equal(
    formatFitExportArchivePath(
      "2026-08-31T22:30:00.000Z",
      "2026-09-01-00-30-00-W-42.fit",
      { timeZone: "Europe/Berlin" }
    ),
    "2026/09/2026-09-01-00-30-00-W-42.fit"
  );
});

test("FIT archive path groups missing timestamps separately", () => {
  assert.equal(
    formatFitExportArchivePath(null, "W-42.fit"),
    "_unknown/_unknown/W-42.fit"
  );
});
