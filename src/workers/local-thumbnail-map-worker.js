import { parentPort, workerData } from "node:worker_threads";
import { LocalMapRenderer } from "../services/localThumbnailMapRenderer.js";

const renderer = new LocalMapRenderer(workerData);
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