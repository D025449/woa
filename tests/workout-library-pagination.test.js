import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import WorkoutLibraryView, {
  normalizeWorkoutLibraryPageSize
} from "../src/public/js/workout-library-view.js";

const dashboardViewUrl = new URL("../src/views/dashboard-new.ejs", import.meta.url);
const libraryViewUrl = new URL("../src/public/js/workout-library-view.js", import.meta.url);

function createHeadlessView(handlers = {}) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  try {
    return new WorkoutLibraryView("#workout-library", handlers);
  } finally {
    globalThis.document = originalDocument;
  }
}

test("workout library page size is constrained to the supported options", () => {
  assert.equal(normalizeWorkoutLibraryPageSize(12), 12);
  assert.equal(normalizeWorkoutLibraryPageSize("48"), 48);
  assert.equal(normalizeWorkoutLibraryPageSize(500), 24);
  assert.equal(normalizeWorkoutLibraryPageSize(undefined), 24);
});

test("workout library navigates by replacing the current page", async () => {
  const view = createHeadlessView({ initialPageSize: 48 });
  const requests = [];
  view.lastPage = 4;
  view.fetchPage = async (options) => requests.push(options);

  assert.match(view.buildUrl(), /page=1/u);
  assert.match(view.buildUrl(), /size=48/u);

  await view.goToPage(2);
  assert.equal(view.page, 2);
  assert.deepEqual(requests, [{ append: false }]);

  await view.goToPage(8);
  assert.equal(view.page, 4);
  assert.deepEqual(requests, [{ append: false }, { append: false }]);

  await view.goToPage(4);
  assert.equal(requests.length, 2);
});

test("workout card row numbers continue across pages and render for both card types", async () => {
  const view = createHeadlessView({ initialPageSize: 24 });

  assert.equal(view.getRowNumber(0), 1);
  assert.equal(view.getRowNumber(23), 24);

  view.page = 3;
  assert.equal(view.getRowNumber(0), 49);
  assert.equal(view.getRowNumber(7), 56);

  const source = await readFile(libraryViewUrl, "utf8");
  const positionChips = source.match(/workout-library-card__context-position/g) || [];
  assert.equal(positionChips.length, 2);
});

test("dashboard renders workout page navigation and page-size controls", async () => {
  const source = await readFile(dashboardViewUrl, "utf8");

  assert.match(source, /id="workout-library-pagination"/u);
  assert.match(source, /id="workout-library-page-size"/u);
  assert.match(source, /id="workout-library-page-previous"/u);
  assert.match(source, /id="workout-library-page-next"/u);
});