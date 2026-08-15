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
});
