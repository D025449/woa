import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferStandard } from "../services/fit-parser-service.js";
import { normalizeFitPayload } from "../services/fit-parser-normalize.js";

async function main() {
  const inputPath = process.argv[2] || "./sample.fit";
  const outputPath = process.argv[3] || "./fixtures/fit-parser/sample.golden.json";
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);

  const buffer = await fs.readFile(resolvedInputPath);
  const parsed = await parseFitBufferStandard(buffer);
  const normalized = normalizeFitPayload(parsed);

  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(
    resolvedOutputPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );

  console.log("[fit-golden] written", {
    input: resolvedInputPath,
    output: resolvedOutputPath
  });
}

main().catch((error) => {
  console.error("[fit-golden] failed", error);
  process.exit(1);
});
