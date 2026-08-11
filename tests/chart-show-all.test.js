import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("chart toolbar restores the complete workout zoom range", async () => {
  const [chartSource, template, css] = await Promise.all([
    fs.readFile(new URL("../src/public/js/chart-view.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/views/dashboard-new.ejs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/css/dashboard-new.css", import.meta.url), "utf8")
  ]);

  assert.match(template, /id="dashboard-chart-show-all"/u);
  assert.match(template, /dashboardNewPage\.showAll/u);
  assert.match(chartSource, /this\.showAllButton\?\.addEventListener\("click", \(\) => this\.showAll\(\)\)/u);
  assert.match(chartSource, /showAll\(\)[\s\S]*?type: "dataZoom",[\s\S]*?start: 0,[\s\S]*?end: 100/u);
  assert.match(chartSource, /this\.syncShowAllButton\(\)/u);
  assert.match(css, /\.dashboard-chart-show-all/u);
});

test("every locale contains the chart show-all tooltip", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(await fs.readFile(
      new URL(`../src/public/i18n/${locale}.json`, import.meta.url),
      "utf8"
    ));
    assert.equal(typeof messages.dashboardNewPage.showAll, "string", locale);
  }
});

test("workout chart keeps pointer-centered mouse-wheel zoom enabled", async () => {
  const chartSource = await fs.readFile(
    new URL("../src/public/js/chart-view.js", import.meta.url),
    "utf8"
  );

  assert.match(
    chartSource,
    /dataZoom:\s*\[[\s\S]*?type: "inside",[\s\S]*?disabled: false,[\s\S]*?zoomOnMouseWheel: true,[\s\S]*?moveOnMouseWheel: false/u
  );
  assert.match(
    chartSource,
    /setDrawingMode\(enabled\)[\s\S]*?zoomOnMouseWheel: true,[\s\S]*?moveOnMouseWheel: false/u
  );
});

test("opening a different workout resets the chart to its complete range", async () => {
  const chartSource = await fs.readFile(
    new URL("../src/public/js/chart-view.js", import.meta.url),
    "utf8"
  );

  assert.match(
    chartSource,
    /updateWorkout\(workout\)[\s\S]*?workoutChanged[\s\S]*?type: "dataZoom",[\s\S]*?start: 0,[\s\S]*?end: 100/u
  );
});
