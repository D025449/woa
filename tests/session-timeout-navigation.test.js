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

test("idle timeout logs out and logout redirects to the login page", () => {
  assert.match(topbarSource, /logoutTimer[\s\S]*window\.location\.href = "\/logout"/u);
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
