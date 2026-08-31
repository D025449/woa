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
  assert.match(chartSource, /name: 'FTP'/u);
  assert.match(chartSource, /formatCPDuration/u);
  assert.match(chartSource, /`CP\$\{durationSeconds\}S`/u);
  assert.match(chartSource, /`CP\$\{durationSeconds \/ 60\}`/u);
  assert.doesNotMatch(chartSource, /`CP \$\{durationSeconds\} s`/u);
  assert.match(chartSource, /showSymbol: false/u);
  assert.match(chartSource, /sampling: 'lttb'/u);
  assert.match(chartSource, /animation: false/u);
});

test("critical-power colors follow one semantic short-to-long intensity scale", async () => {
  const chartSource = await readFile(
    new URL("src/public/js/cp-chart-view.js", projectRoot),
    "utf8"
  );

  const expectedColors = [
    "#6D28D9", "#9333EA", "#C026D3", "#DB2777", "#E11D48", "#EA580C",
    "#F59E0B", "#84A11D", "#16A34A", "#0D9488", "#0284C7", "#334155"
  ];
  for (const color of expectedColors) assert.match(chartSource, new RegExp(color, "u"));
  assert.match(chartSource, /lineStyle: \{ color, width: 2 \}/u);
  assert.match(chartSource, /itemStyle: \{ color \}/u);
  assert.match(chartSource, /color: getCPSeriesColor\(Number\(key\.slice\(2\)\)\)/u);
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
  assert.match(controller, /rememberSelectedWorkout\(workoutId, cpRow\)/u);
  assert.match(controller, /openWorkoutDetail\(selectedWorkout\.id, selectedWorkout\)/u);
  assert.match(controller, /markSelectedPowerMetric\(workoutId, cpRow\)/u);
  assert.match(controller, /selectedWorkout:\s*null/u);
  assert.match(controller, /pagehide[\s\S]*persistAnalyticsPreferences\(\{ keepalive: true \}\)/u);
  assert.match(controller, /snapAnalyticsRangeToGrouping/u);
  assert.match(controller, /getSharedDisplayBounds/u);
  assert.match(loadChart, /onTimeRangeChange/u);
  assert.match(powerChart, /onTimeRangeChange/u);
  assert.match(powerChart, /text: this\.t\("powerCurveEyebrow"\),[\s\S]*top: 12,/u);
  assert.match(powerChart, /id: 'critical-power-legend',[\s\S]*top: 10,/u);
  assert.match(powerChart, /grid: \{[\s\S]*top: 66,/u);
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
  const [markup, controller, powerChart] = await Promise.all([
    readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8"),
    readFile(new URL("src/public/js/analytics-controller.js", projectRoot), "utf8"),
    readFile(new URL("src/public/js/cp-chart-view.js", projectRoot), "utf8")
  ]);

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
  assert.match(controller, /if \(isSelectedPeriod && !hasWorkoutTarget\) return;/u);
  assert.match(controller, /preserveSnapshot: preserveHoveredSnapshot/u);
  assert.match(controller, /if \(!preserveSnapshot\) this\.renderPeriodHeaderDetails\(\);/u);
  assert.match(controller, /PERIOD_HOVER_WORKOUT_DELAY_MS = 180/u);
  assert.match(controller, /this\.schedulePeriodWorkoutPreview\(period\)/u);
  assert.match(controller, /this\.periodWorkoutCache\.size > PERIOD_WORKOUT_CACHE_LIMIT/u);
  assert.match(controller, /loadNextPeriodWorkoutPage/u);
  assert.match(controller, /size: "20"/u);
  assert.match(controller, /analytics-period-card__identity/u);
  assert.match(controller, /card\.append\(header, metrics\)/u);
  assert.match(controller, /getPeriodWorkoutHighlights/u);
  assert.match(controller, /analytics-period-card__cp-markers/u);
  assert.match(powerChart, /getPeriodWorkoutHighlights\(period\)/u);
  assert.match(powerChart, /metric\?\.fileId/u);
  assert.match(powerChart, /color: getCPSeriesColor\(Number\(key\.slice\(2\)\)\)/u);
  assert.match(controller, /createPeriodPowerMetric\(label, value, target\)/u);
  assert.match(controller, /this\.openWorkoutDetail\(workoutId, target, label\)/u);
  assert.match(controller, /endOffset > startOffset/u);
  assert.match(powerChart, /\[label, Number\(metric\.power\), metric\]/u);
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
  assert.doesNotMatch(chartSource, /id: 'distribution-legend'/u);
  assert.doesNotMatch(preferenceSource, /"intensityDistribution"/u);
  assert.match(chartSource, /setSelectedPeriod\(period\)/u);
  assert.match(chartSource, /getPeriodPixelBounds/u);
  assert.match(chartSource, /getPeriodMidpoint/u);
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
  assert.match(powerChart, /getZr\(\)\.on\('click'/u);
  assert.match(powerChart, /preferHoveredPeriod: true/u);
  assert.match(loadChart, /preferHoveredPeriod: true/u);
  assert.match(controller, /selection\?\.preferHoveredPeriod && this\.hoveredPeriod/u);
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

test("analytics fills its stable desktop client area without a page scrollbar", async () => {
  const [markup, css] = await Promise.all([
    readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8"),
    readFile(new URL("src/public/css/analytics.css", projectRoot), "utf8")
  ]);

  assert.match(markup, /class="analytics-app-viewport container-fluid/u);
  assert.match(
    css,
    /body\.analytics-page\.has-fixed-app-topbar\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/su
  );
  assert.match(
    css,
    /> \.analytics-app-viewport\s*\{[^}]*height:\s*calc\(100dvh[^}]*overflow:\s*hidden;/su
  );
  assert.match(
    css,
    /has-fixed-app-topbar \.analytics-shell\s*\{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/su
  );
  assert.match(
    css,
    /has-fixed-app-topbar \.analytics-period-inspector\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none;/su
  );
  assert.match(
    css,
    /\.analytics-period-workouts\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable;/su
  );
  assert.match(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/u);
  assert.match(css, /\.analytics-combined-chart-panel\s*\{[^}]*grid-template-rows:/su);
  assert.match(css, /#ctl-chart,[^}]*#cp-chart\s*\{[^}]*height:\s*100% !important;/su);
  assert.doesNotMatch(markup, /id="analytics-detail-close"/u);
  assert.doesNotMatch(markup, /class="analytics-detail-toolbar"/u);
  assert.doesNotMatch(markup, /analyticsPage\.(?:workoutContextCopy|spatialCopy)/u);
  assert.match(css, /analytics-period-power__metric--action\.is-selected/u);
  assert.match(
    css,
    /@media \(max-width:\s*991\.98px\)[\s\S]*?\.analytics-period-inspector\s*\{[^}]*height:\s*auto;[^}]*max-height:\s*none;/u
  );
});
