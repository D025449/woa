import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const topbarSource = await readFile(
  new URL("../src/views/partials/app-topbar.ejs", import.meta.url),
  "utf8"
);
const workoutServiceSource = await readFile(
  new URL("../src/public/js/workout-service.js", import.meta.url),
  "utf8"
);
const protectedViewNames = [
  "admin-accounts",
  "analytics",
  "coaching",
  "dashboard-new",
  "fileUploadNew",
  "groups",
  "home",
  "profile",
  "segments",
  "sudoku"
];
const protectedViews = await Promise.all(protectedViewNames.map(async (name) => ({
  name,
  source: await readFile(new URL(`../src/views/${name}.ejs`, import.meta.url), "utf8")
})));

test("idle timeout logs out and logout redirects to the login page", () => {
  assert.match(topbarSource, /let lastActivityAt = Date\.now\(\)/u);
  assert.match(topbarSource, /logoutMs - elapsed/u);
  assert.match(topbarSource, /window\.location\.href = "\/logout"/u);
  assert.match(topbarSource, /visibilitychange/u);
  assert.match(topbarSource, /window\.addEventListener\("focus", scheduleIdleTimers\)/u);
  assert.match(
    appSource,
    /app\.get\("\/logout"[\s\S]*req\.session\.destroy\([\s\S]*res\.redirect\("\/login"\)/u
  );
});

test("workout API authentication failures never redirect to the public homepage", () => {
  assert.doesNotMatch(workoutServiceSource, /window\.location\.href = "\/";/u);
  assert.match(
    workoutServiceSource,
    /response\.status === 401[\s\S]*window\.location\.href = "\/login"/u
  );
});

test("every authenticated page template includes the shared session timer", () => {
  for (const view of protectedViews) {
    assert.match(
      view.source,
      /include\("partials\/app-topbar"/u,
      `${view.name}.ejs must include the authenticated app topbar`
    );
  }
});
