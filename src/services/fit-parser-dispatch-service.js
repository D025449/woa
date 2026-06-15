import { parseFitBufferFast } from "./fit-parser-fast-service.js";
import { parseFitBufferTyped } from "./fit-import-typed-service.js";
import { parseFitBufferStandard } from "./fit-parser-service.js";

export function getFitParserVariant() {
  const configured = String(process.env.FIT_PARSER_VARIANT || "fast").trim().toLowerCase();
  if (configured === "standard") {
    return "standard";
  }
  if (configured === "typed") {
    return "typed";
  }
  return "fast";
}

export function parseFitBuffer(buffer) {
  const variant = getFitParserVariant();
  if (variant === "standard") {
    return parseFitBufferStandard(buffer);
  }
  if (variant === "typed") {
    return Promise.resolve(parseFitBufferTyped(buffer));
  }
  return parseFitBufferFast(buffer);
}
