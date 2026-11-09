import { parentPort, workerData } from "node:worker_threads";
import { buildPublicFit } from "../services/publicApiFitService.js";

try {
  const result = buildPublicFit(workerData.row, workerData.segments);
  const bytes = new Uint8Array(result.bytes);
  parentPort.postMessage({ bytes, fileName: result.fileName }, [bytes.buffer]);
} catch (error) {
  parentPort.postMessage({ statusCode: error.statusCode === 422 ? 422 : 503 });
}
