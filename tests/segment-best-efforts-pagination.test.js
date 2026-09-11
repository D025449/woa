import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import SegmentBestEffortsCardView, {
  normalizeSegmentBestEffortsPageSize
} from "../src/public/js/segment-best-efforts-card-view.js";

const segmentViewUrl = new URL("../src/views/segments.ejs", import.meta.url);
const segmentRoutesUrl = new URL("../src/routes/segmentRoutes.js", import.meta.url);
const segmentServiceUrl = new URL("../src/services/segmentDBService.js", import.meta.url);

function createHeadlessView() {
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null
  };
  try {
    return new SegmentBestEffortsCardView("#segment-best-efforts-cards");
  } finally {
    globalThis.document = originalDocument;
  }
}

test("segment best-effort page size is restricted to 10, 25, and 50", () => {
  assert.equal(normalizeSegmentBestEffortsPageSize(10), 10);
  assert.equal(normalizeSegmentBestEffortsPageSize("25"), 25);
  assert.equal(normalizeSegmentBestEffortsPageSize(50), 50);
  assert.equal(normalizeSegmentBestEffortsPageSize(20), 25);
  assert.equal(normalizeSegmentBestEffortsPageSize(undefined), 25);
});

test("segment best efforts navigate by replacing the current page", async () => {
  const view = createHeadlessView();
  const requests = [];
  view.currentSegment = { id: 42 };
  view.lastPage = 4;
  view.loadSegmentBestEfforts = async (segment) => requests.push(segment.id);

  await view.goToPage(2);
  assert.equal(view.page, 2);
  assert.deepEqual(requests, [42]);

  await view.goToPage(8);
  assert.equal(view.page, 4);
  assert.deepEqual(requests, [42, 42]);

  await view.goToPage(4);
  assert.equal(requests.length, 2);
});

test("segment page requests use stable duration ordering", () => {
  const view = createHeadlessView();
  view.page = 3;
  view.pageSize = 50;
  const url = view.buildRequestUrl(42);
  assert.match(url, /page=3/u);
  assert.match(url, /size=50/u);
  assert.match(url, /sort%5B0%5D%5Bfield%5D=duration/u);
  assert.match(url, /sort%5B1%5D%5Bfield%5D=wid/u);
  assert.match(url, /sort%5B2%5D%5Bfield%5D=start_offset/u);
});

test("segment view renders page navigation and size controls", async () => {
  const source = await readFile(segmentViewUrl, "utf8");
  assert.match(source, /id="segment-best-efforts-pagination"/u);
  assert.match(source, /id="segment-best-efforts-page-size"/u);
  assert.match(source, /id="segment-best-efforts-page-previous"/u);
  assert.match(source, /id="segment-best-efforts-page-next"/u);
  assert.doesNotMatch(source, /id="segment-best-efforts-load-more"/u);
});

test("best-effort endpoint always uses persisted rows with bounded page sizes", async () => {
  const source = await readFile(segmentRoutesUrl, "utf8");
  const routeStart = source.indexOf('router.get("/bestefforts/:id/data"');
  const routeEnd = source.indexOf("router.get(", routeStart + 1);
  const route = source.slice(routeStart, routeEnd);

  assert.match(route, /\[10, 25, 50\]\.includes\(requestedSize\)/u);
  assert.match(route, /SegmentDBService\.getBestEffortsBySegment/u);
  assert.doesNotMatch(route, /materializeOnDemandSegmentBestEfforts/u);
});

test("persisted paging exposes stable ranks and the leader on every page", async () => {
  const source = await readFile(segmentServiceUrl, "utf8");
  const methodStart = source.indexOf("static async getBestEffortsBySegment");
  const methodEnd = source.indexOf("static async getBestEffortsStatus", methodStart);
  const method = source.slice(methodStart, methodEnd);

  assert.match(method, /ORDER BY base\.duration ASC, base\.wid ASC, base\.start_offset ASC, base\.end_offset ASC/u);
  assert.match(method, /MIN\(base\.duration\) OVER \(PARTITION BY base\.sid\) AS leader_duration/u);
  assert.match(method, /current_page: page/u);
});
