import { parseFitBufferFast } from "./fit-parser-fast-service.js";
import { parseFitBufferStandard } from "./fit-parser-service.js";

export function getFitParserVariant() {
  const configured = String(process.env.FIT_PARSER_VARIANT || "fast").trim().toLowerCase();
  return configured === "standard" ? "standard" : "fast";
}

export function parseFitBuffer(buffer) {
  return getFitParserVariant() === "standard"
    ? parseFitBufferStandard(buffer)
    : parseFitBufferFast(buffer);
}
