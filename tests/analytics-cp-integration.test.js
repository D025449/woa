import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("analytics hides only the legacy FTP panel", async () => {
  const markup = await readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8");
  const articles = [...markup.matchAll(/<article\b([^>]*)>[\s\S]*?<\/article>/gu)];
  const articleFor = (chartId) => articles.find((match) => match[0].includes(`id="${chartId}"`));

  assert.ok(articleFor("ctl-chart"));
  assert.ok(articleFor("ftp-chart"));
  assert.ok(articleFor("cp-chart"));
  assert.equal(articleFor("ctl-chart"), articleFor("cp-chart"));
  assert.match(markup, /analytics-body--load-model/u);
  assert.match(markup, /analytics-combined-chart-divider/u);
  assert.doesNotMatch(articleFor("ctl-chart")[1], /\bhidden\b/u);
  assert.match(articleFor("ftp-chart")[1], /\bhidden\b/u);
  assert.doesNotMatch(articleFor("cp-chart")[1], /\bhidden\b/u);
});

test("critical-power chart includes the new durations and rolling eFTP", async () => {
  const chartSource = await readFile(new URL("src/public/js/cp-chart-view.js", projectRoot), "utf8");
  const routeSource = await readFile(new URL("src/routes/fileRoutes.js", projectRoot), "utf8");

  assert.match(routeSource, /240, 360, 480, 720, 900, 960, 1800/u);
  assert.match(routeSource, /getRollingFTPValues/u);
  assert.match(chartSource, /name: 'eFTP'/u);
  assert.match(chartSource, /formatCPDuration/u);
  assert.match(chartSource, /`CP\$\{durationSeconds\}S`/u);
  assert.match(chartSource, /`CP\$\{durationSeconds \/ 60\}`/u);
  assert.doesNotMatch(chartSource, /`CP \$\{durationSeconds\} s`/u);
  assert.match(chartSource, /showSymbol: false/u);
  assert.match(chartSource, /sampling: 'lttb'/u);
  assert.match(chartSource, /animation: false/u);
});

test("analytics displays and persists one slider-controlled range for both charts", async () => {
  const markup = await readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8");
  const controller = await readFile(
    new URL("src/public/js/analytics-controller.js", projectRoot),
    "utf8"
  );
  const loadChart = await readFile(
    new URL("src/public/js/ctl-chart-view.js", projectRoot),
    "utf8"
  );
  const powerChart = await readFile(
    new URL("src/public/js/cp-chart-view.js", projectRoot),
    "utf8"
  );

  assert.match(markup, /id="analytics-time-range-summary"/u);
  assert.doesNotMatch(markup, /<span><%= t\("analyticsPage\.timeRangeLabel"\) %><\/span>/u);
  assert.doesNotMatch(markup, /<span><%= t\("analyticsPage\.groupingLabel"\) %><\/span>/u);
  assert.match(markup, /aria-label="<%= t\("analyticsPage\.timeRangeLabel"\) %>"/u);
  assert.doesNotMatch(markup, /data-range-mode/u);
  assert.doesNotMatch(markup, /type="date"/u);
  assert.match(controller, /timeRange/u);
  assert.match(controller, /scheduleAnalyticsPreferenceSave/u);
  assert.match(controller, /snapAnalyticsRangeToGrouping/u);
  assert.match(controller, /getSharedDisplayBounds/u);
  assert.match(loadChart, /onTimeRangeChange/u);
  assert.match(powerChart, /onTimeRangeChange/u);
  assert.match(controller, /echarts\.connect\(\[this\.ctlChartView\.chart, this\.cpChartView\.chart\]\)/u);
  assert.match(loadChart, /formatAnalysisPeriodValue/u);
  assert.match(powerChart, /formatAnalysisPeriodValue/u);
  assert.match(loadChart, /slider: \{ show: false \}/u);
  assert.match(loadChart, /show: false/u);
  assert.match(loadChart, /this\.hasDistributionGrid/u);
  assert.match(loadChart, /min: domain\.start, max: domain\.end/u);
  assert.match(powerChart, /xAxis: \{ min: domain\.start, max: domain\.end \}/u);
});

test("analytics uses one grouping control and a two-level workout drill-down", async () => {
  const markup = await readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8");
  const controller = await readFile(
    new URL("src/public/js/analytics-controller.js", projectRoot),
    "utf8"
  );

  assert.match(markup, /name="analytics-grouping"/u);
  assert.doesNotMatch(markup, /name="grouping1"/u);
  assert.match(markup, /id="analytics-workspace"/u);
  assert.match(markup, /id="analytics-period-inspector"/u);
  assert.match(markup, /id="analytics-period-load-more-button"/u);
  assert.match(markup, /id="analytics-period-kpis"/u);
  assert.match(markup, /id="analytics-period-power-values"/u);
  assert.doesNotMatch(controller, /ensureSelectedWorkoutCard/u);
  assert.match(markup, /id="analytics-detail-placeholder"/u);
  assert.match(markup, /id="analytics-detail"[^>]*hidden/u);
  assert.match(controller, /loadPeriodWorkouts/u);
  assert.match(controller, /loadNextPeriodWorkoutPage/u);
  assert.match(controller, /size: "20"/u);
  assert.match(controller, /openWorkoutDetail/u);
  assert.match(controller, /analytics-focus-grid--no-map/u);
  assert.doesNotMatch(controller, /ResizeObserver/u);
  assert.doesNotMatch(controller, /scheduleDesktopLayoutMeasure/u);
});

test("every locale contains the shared analytics time-range copy", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(await readFile(
      new URL(`src/public/i18n/${locale}.json`, projectRoot),
      "utf8"
    ));
    assert.equal(typeof messages.analyticsPage.timeRangeLabel, "string");
    assert.equal(typeof messages.analyticsPage.groupingLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodTitle, "string");
    assert.equal(typeof messages.analyticsPage.periodInitial, "string");
    assert.equal(typeof messages.analyticsPage.periodLoadedSummary, "string");
    assert.equal(typeof messages.analyticsPage.periodActivitiesLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodDurationLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodTssLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodDistanceLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodPowerProfileLabel, "string");
    assert.equal(typeof messages.analyticsPage.periodHoverHint, "string");
    assert.equal(typeof messages.analyticsPage.detailInitial, "string");
    assert.equal(typeof messages.analyticsPage.loadMore, "string");
    assert.equal(typeof messages.analyticsPage.distributionLegend, "string");
    assert.equal(typeof messages.analyticsPage.distributionAxis, "string");
    assert.equal(typeof messages.analyticsPage.distributionActive, "string");
    assert.equal(typeof messages.analyticsPage.distributionCoasting, "string");
    assert.equal(typeof messages.analyticsPage.distributionWithoutFtp, "string");
  }
});

test("load model integrates the grouped power distribution on its shared time axis", async () => {
  const chartSource = await readFile(
    new URL("src/public/js/ctl-chart-view.js", projectRoot),
    "utf8"
  );
  const routeSource = await readFile(new URL("src/routes/fileRoutes.js", projectRoot), "utf8");
  const preferenceSource = await readFile(
    new URL("src/services/viewPreferenceService.js", projectRoot),
    "utf8"
  );

  assert.match(routeSource, /router\.get\("\/power-distribution"/u);
  assert.match(routeSource, /router\.get\("\/analytics-overview"/u);
  assert.match(chartSource, /loadAnalyticsOverview/u);
  assert.match(chartSource, /id: 'intensity-distribution'/u);
  assert.match(chartSource, /type: 'custom'/u);
  assert.match(chartSource, /echarts\.graphic\.clipRectByRect/u);
  assert.match(chartSource, /xAxisIndex: showDistribution \? \[0, 1\] : 0/u);
  assert.match(chartSource, /axisPointer: showDistribution/u);
  assert.match(chartSource, /id: 'load-model-legend'/u);
  assert.match(chartSource, /id: 'distribution-legend'/u);
  assert.match(preferenceSource, /"intensityDistribution"/u);
});

test("analytics charts share one bundled backend request", async () => {
  const clientSource = await readFile(
    new URL("src/public/js/analytics-overview-client.js", projectRoot),
    "utf8"
  );
  const loadChart = await readFile(
    new URL("src/public/js/ctl-chart-view.js", projectRoot),
    "utf8"
  );
  const powerChart = await readFile(
    new URL("src/public/js/cp-chart-view.js", projectRoot),
    "utf8"
  );

  assert.match(clientSource, /\/files\/analytics-overview\?grouping=/u);
  assert.match(clientSource, /overviewRequests/u);
  assert.match(clientSource, /response\.arrayBuffer\(\)/u);
  assert.match(clientSource, /decodeAnalyticsOverview/u);
  assert.match(loadChart, /await loadAnalyticsOverview\(this\.currentGrouping\)/u);
  assert.match(powerChart, /await loadAnalyticsOverview\(this\.currentGrouping\)/u);
});

test("analytics replaces floating tooltips with a persistent hover inspector", async () => {
  const [markup, controller, loadChart, powerChart] = await Promise.all([
    readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8"),
    readFile(new URL("src/public/js/analytics-controller.js", projectRoot), "utf8"),
    readFile(new URL("src/public/js/ctl-chart-view.js", projectRoot), "utf8"),
    readFile(new URL("src/public/js/cp-chart-view.js", projectRoot), "utf8")
  ]);

  assert.match(markup, /id="analytics-period-zone-bar"/u);
  assert.match(controller, /handleAnalysisPeriodHover/u);
  assert.match(controller, /renderPeriodSnapshot/u);
  assert.match(controller, /getVisiblePeriodMetrics/u);
  assert.match(loadChart, /showContent: false/u);
  assert.match(powerChart, /showContent: false/u);
});

test("load-model hover forwards its time to the power curve without a connect loop", async () => {
  const controllerSource = await readFile(
    new URL("src/public/js/analytics-controller.js", projectRoot),
    "utf8"
  );

  assert.match(controllerSource, /containPixel\(\{ gridIndex: 0 \}/u);
  assert.match(controllerSource, /convertFromPixel\(\{ xAxisIndex: 0 \}/u);
  assert.match(controllerSource, /type: 'updateAxisPointer'/u);
  assert.match(controllerSource, /escapeConnect: true/u);
});

test("power-curve hover forwards its time independently of visible power series", async () => {
  const controllerSource = await readFile(
    new URL("src/public/js/analytics-controller.js", projectRoot),
    "utf8"
  );

  assert.match(controllerSource, /connectPowerCurvePointerToLoadModel\(\)/u);
  assert.match(controllerSource, /const sourceChart = this\.cpChartView\.chart;/u);
  assert.match(controllerSource, /const targetChart = this\.ctlChartView\.chart;/u);
});

test("analytics time pointers do not depend on visible series samples", async () => {
  const [loadChartSource, powerChartSource] = await Promise.all([
    readFile(new URL("src/public/js/ctl-chart-view.js", projectRoot), "utf8"),
    readFile(new URL("src/public/js/cp-chart-view.js", projectRoot), "utf8")
  ]);

  assert.match(loadChartSource, /axisPointer: \{ show: true, snap: false \}/u);
  assert.match(powerChartSource, /axisPointer: \{ show: true, snap: false \}/u);
});

test("analytics overview permits a short private browser cache", async () => {
  const routeSource = await readFile(new URL("src/routes/fileRoutes.js", projectRoot), "utf8");
  assert.match(routeSource, /Cache-Control", "private, max-age=60"/u);
  assert.match(routeSource, /Vary", "Accept-Encoding, Cookie"/u);
});
