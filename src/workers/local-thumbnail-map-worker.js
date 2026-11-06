import { parentPort, workerData } from "node:worker_threads";
import { LocalMapRenderer } from "../services/localThumbnailMapRenderer.js";
import { performance } from "node:perf_hooks";

const initializationStartedAt = performance.now();
const renderer = new LocalMapRenderer(workerData);
parentPort.postMessage({ ready: true, initializationMs: performance.now() - initializationStartedAt });
parentPort.on("message", async ({ id, example }) => {
  try { renderer.viewport(example); }
  catch {
    parentPort.postMessage({ id, error: "unsupported-route" });
    return;
  }
  try {
    const result = await renderer.render(example);
    parentPort.postMessage({ id, result: { svg: result.svg, stats: result.stats } });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message === "No local tiles for this route."
      ? "outside-coverage" : "local-map-render-error" });
  }
});