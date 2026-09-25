import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import SegmentBestEffortsCardView, {
  normalizeSegmentBestEffortsPageSize,
  normalizeSegmentBestEffortsPeriod,
  resolveSegmentBestEffortsScanState
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

test("segment best-effort period is restricted to supported calendar ranges", () => {
  assert.equal(normalizeSegmentBestEffortsPeriod("all"), "all");
  assert.equal(normalizeSegmentBestEffortsPeriod("CURRENT_MONTH"), "current_month");
  assert.equal(normalizeSegmentBestEffortsPeriod("previous_month"), "previous_month");
  assert.equal(normalizeSegmentBestEffortsPeriod("current_quarter"), "current_quarter");
  assert.equal(normalizeSegmentBestEffortsPeriod("current_year"), "current_year");
  assert.equal(normalizeSegmentBestEffortsPeriod("month"), "all");
  assert.equal(normalizeSegmentBestEffortsPeriod("week"), "all");
});

test("segment best-effort controls report persistable preference changes", async () => {
  const originalDocument = globalThis.document;
  const listeners = new Map();
  const periodSelect = {
    value: "all",
    addEventListener(type, listener) {
      listeners.set(`period:${type}`, listener);
    }
  };
  const pageSizeSelect = {
    value: "25",
    addEventListener(type, listener) {
      listeners.set(`size:${type}`, listener);
    }
  };
  const changes = [];

  globalThis.document = {
    querySelector: () => null,
    getElementById(id) {
      if (id === "segment-best-efforts-period") return periodSelect;
      if (id === "segment-best-efforts-page-size") return pageSizeSelect;
      return null;
    }
  };

  try {
    const view = new SegmentBestEffortsCardView("#segment-best-efforts-cards", {
      period: "previous_month",
      pageSize: 10,
      onPreferenceChange: (state) => changes.push(state)
    });
    assert.equal(periodSelect.value, "previous_month");
    assert.equal(pageSizeSelect.value, "10");

    periodSelect.value = "current_year";
    await listeners.get("period:change")();
    pageSizeSelect.value = "50";
    await listeners.get("size:change")();

    assert.deepEqual(changes, [
      { period: "current_year", pageSize: 10 },
      { period: "current_year", pageSize: 50 }
    ]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("segment scan states distinguish progress, completion, and failures", () => {
  assert.deepEqual(resolveSegmentBestEffortsScanState("queued"), {
    key: "bestEffortsScanQueued",
    values: {},
    kind: "scanning"
  });
  assert.deepEqual(resolveSegmentBestEffortsScanState("completed", null, 42), {
    key: "bestEffortsScanCompletedCount",
    values: { count: 42 },
    kind: "completed"
  });
  assert.deepEqual(resolveSegmentBestEffortsScanState("completed", null, null), {
    key: "bestEffortsScanCompleted",
    values: {},
    kind: "completed"
  });
  assert.deepEqual(resolveSegmentBestEffortsScanState("failed", "boom"), {
    key: "bestEffortsScanFailedDetail",
    values: { error: "boom" },
    kind: "failed"
  });
});

test("completed segment polling stops before forcing a fresh result load", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let scheduledTick = null;
  const events = [];

  try {
    globalThis.window = {
      setTimeout(callback) {
        scheduledTick = callback;
        return 1;
      },
      clearTimeout() {}
    };
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.cache, "no-store");
      return {
        ok: true,
        json: async () => ({ status: "completed", error: null })
      };
    };

    const view = createHeadlessView();
    const originalStop = view.stopBestEffortsPolling.bind(view);
    view.currentSegment = { id: 42, bestEffortsStatus: "processing" };
    view.renderScanStatus = (segment) => events.push(`status:${segment.bestEffortsStatus}`);
    view.stopBestEffortsPolling = () => {
      events.push("stop");
      originalStop();
    };
    view.loadSegmentBestEfforts = async (_segment, options) => {
      events.push(`load:${options?.forceRefresh === true}`);
    };

    view.startBestEffortsPolling(42);
    events.length = 0;
    assert.equal(typeof scheduledTick, "function");
    await scheduledTick();

    assert.deepEqual(events, ["stop", "load:true"]);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
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
  view.period = "current_quarter";
  const url = view.buildRequestUrl(42);
  assert.match(url, /page=3/u);
  assert.match(url, /size=50/u);
  assert.match(url, /period=current_quarter/u);
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
  assert.match(source, /id="segment-best-efforts-period"/u);
  assert.match(source, /id="segment-best-efforts-scan-status"/u);
  assert.doesNotMatch(source, /id="segment-best-efforts-load-more"/u);
  assert.match(source, /id="segment-elevation-reference-automatic"/u);
  assert.match(source, /id="segment-elevation-source"/u);
});

test("owned eligible best efforts expose the manual elevation-reference action", () => {
  const view = createHeadlessView();
  view.handlers.canSetElevationReference = () => true;
  view.currentSegment = { id: 42, elevationProfile: { manual: false, sourceWorkoutId: null } };
  const row = {
    wid: 90384,
    start_offset: 10,
    end_offset: 80,
    duration: 70,
    rn: 1,
    elevation_reference_eligible: true
  };

  const action = view.renderRow(row);
  assert.match(action, /data-segment-elevation-reference="90384:10:80"/u);

  view.currentSegment.elevationProfile = {
    source: "workout",
    status: "confirmed",
    manual: true,
    sourceWorkoutId: 90384
  };
  const selected = view.renderRow(row);
  assert.doesNotMatch(selected, /data-segment-elevation-reference=/u);
  assert.match(selected, /elevationReferenceCurrent/u);

  view.currentSegment.elevationProfile.manual = false;
  const automatic = view.renderRow(row);
  assert.doesNotMatch(automatic, /data-segment-elevation-reference=/u);
  assert.match(automatic, /elevationReferenceAutomaticBadge/u);
});

test("best-effort endpoint always uses persisted rows with bounded page sizes", async () => {
  const source = await readFile(segmentRoutesUrl, "utf8");
  const routeStart = source.indexOf('router.get("/bestefforts/:id/data"');
  const routeEnd = source.indexOf("router.get(", routeStart + 1);
  const route = source.slice(routeStart, routeEnd);

  assert.match(route, /\[10, 25, 50\]\.includes\(requestedSize\)/u);
  assert.match(route, /\["all", "current_month", "previous_month", "current_quarter", "current_year"\]\.includes\(requestedPeriod\)/u);
  assert.match(route, /SegmentDBService\.getBestEffortsBySegment/u);
  assert.match(route, /bestEffortsStatus === "completed"/u);
  assert.match(route, /"private, no-store"/u);
  assert.doesNotMatch(route, /materializeOnDemandSegmentBestEfforts/u);
});

test("manual elevation references use an owner-scoped write endpoint", async () => {
  const source = await readFile(segmentRoutesUrl, "utf8");
  const routeStart = source.indexOf('router.put("/:id/elevation-profile/reference"');
  const routeEnd = source.indexOf("router.get(\"/:id\"", routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.match(route, /requireActiveAccountWrite/u);
  assert.match(route, /SegmentElevationProfileService\.setManualReference/u);
  assert.match(route, /SegmentDBService\.getSegmentById/u);
});

test("persisted paging exposes stable ranks and the leader on every page", async () => {
  const source = await readFile(segmentServiceUrl, "utf8");
  const methodStart = source.indexOf("static async getBestEffortsBySegment");
  const methodEnd = source.indexOf("static async getBestEffortsStatus", methodStart);
  const method = source.slice(methodStart, methodEnd);

  assert.match(method, /ORDER BY base\.duration ASC, base\.wid ASC, base\.start_offset ASC, base\.end_offset ASC/u);
  assert.match(method, /MIN\(base\.duration\) OVER \(PARTITION BY base\.sid\) AS leader_duration/u);
  assert.match(method, /v\.start_time >= DATE_TRUNC\('month', CURRENT_TIMESTAMP\)/u);
  assert.match(method, /v\.start_time >= DATE_TRUNC\('month', CURRENT_TIMESTAMP\) - INTERVAL '1 month'/u);
  assert.match(method, /v\.start_time >= DATE_TRUNC\('quarter', CURRENT_TIMESTAMP\)/u);
  assert.match(method, /v\.start_time >= DATE_TRUNC\('year', CURRENT_TIMESTAMP\)/u);
  assert.match(method, /current_page: page/u);
});
