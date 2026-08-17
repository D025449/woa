import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/public/js/workout-library-view.js", import.meta.url);

test("workout cards render TSS as TS in the fourth primary metric slot", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const powerIndex = source.indexOf('workout-library-stat__label">PW');
  const normalizedPowerIndex = source.indexOf('workout-library-stat__label">NP');
  const heartRateIndex = source.indexOf("${heartRateStat ?");
  const trainingStressIndex = source.indexOf("${trainingStressStat ?");
  const secondaryGroupIndex = source.indexOf('<div class="workout-library-card__body-copy-group">', powerIndex + 1);

  assert.match(source, /const trainingStressScore = Number\(workout\.TSS \?\? workout\.estimated_tss\)/u);
  assert.match(source, /label: "TS"/u);
  assert.ok(powerIndex >= 0);
  assert.ok(powerIndex < normalizedPowerIndex);
  assert.ok(normalizedPowerIndex < heartRateIndex);
  assert.ok(heartRateIndex < trainingStressIndex);
  assert.ok(trainingStressIndex < secondaryGroupIndex);
});

test("workout metric values use the context-row font size", async () => {
  const css = await readFile(new URL("../src/public/css/dashboard-new.css", import.meta.url), "utf8");
  const contextRule = css.match(/\.workout-library-card__context-chip\s*\{([\s\S]*?)\}/u)?.[1] || "";
  const valueRules = [...css.matchAll(/\.workout-library-stat__value\s*\{([\s\S]*?)\}/gu)];

  assert.match(contextRule, /font-size:\s*0\.74rem/u);
  assert.ok(valueRules.length >= 1);
  valueRules.forEach((rule) => assert.match(rule[1], /font-size:\s*0\.74rem/u));
});
