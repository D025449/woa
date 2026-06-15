import { parseFitBufferTyped } from "./fit-import-typed-service.js";

export function getFitParserVariant() {
  return "typed";
}

export function parseFitBuffer(buffer) {
  return Promise.resolve(parseFitBufferTyped(buffer));
}
