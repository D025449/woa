import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const browserSource = await fs.readFile(
  new URL("../src/public/js/admin-accounts.js", import.meta.url),
  "utf8"
);
const routeSource = await fs.readFile(
  new URL("../src/routes/adminAccountBackupRoutes.js", import.meta.url),
  "utf8"
);

test("workout preview sends compact JSON metadata instead of the ZIP archive", () => {
  assert.match(browserSource, /buildLocalWorkoutPreview\(archive\)/u);
  assert.match(browserSource, /body: JSON\.stringify\(metadata\)/u);
  assert.match(browserSource, /application\/vnd\.cwa24\.workout-preview\+json/u);
  assert.doesNotMatch(
    browserSource,
    /sendWorkoutArchive\("\/admin\/accounts\/workouts\/preview/u
  );
});

test("workout preview route accepts bounded raw metadata rather than multer", () => {
  assert.match(
    routeSource,
    /express\.raw\(\{ type: "application\/vnd\.cwa24\.workout-preview\+json", limit: "5mb" \}\)/u
  );
  assert.doesNotMatch(
    routeSource,
    /router\.post\("\/workouts\/preview", workoutUpload/u
  );
});
