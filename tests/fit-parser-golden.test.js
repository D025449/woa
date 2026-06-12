import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseFitBufferStandard } from "../src/services/fit-parser-service.js";
import { parseFitBufferFast } from "../src/services/fit-parser-fast-service.js";
import { normalizeFitPayload } from "../src/services/fit-parser-normalize.js";

const sampleFitPath = path.resolve("./sample.fit");
const goldenPath = path.resolve("./fixtures/fit-parser/sample.golden.json");

async function loadGoldenFixture() {
  const raw = await fs.readFile(goldenPath, "utf8");
  return JSON.parse(raw);
}

async function parseAndNormalize(parser) {
  const buffer = await fs.readFile(sampleFitPath);
  const parsed = await parser(buffer);
  return normalizeFitPayload(parsed);
}

test("standard parser matches golden fixture", async () => {
  const expected = await loadGoldenFixture();
  const actual = await parseAndNormalize(parseFitBufferStandard);
  assert.deepEqual(actual, expected);
});

test("fast parser matches golden fixture", async () => {
  const expected = await loadGoldenFixture();
  const actual = await parseAndNormalize(parseFitBufferFast);
  assert.deepEqual(actual, expected);
});
