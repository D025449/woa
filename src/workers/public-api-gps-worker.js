import { parentPort, workerData } from "node:worker_threads";
import { decodePublicGps } from "../services/publicApiGpsService.js";

try {
  parentPort.postMessage({ json: decodePublicGps(workerData.blob, workerData.codec, workerData.id) });
} catch (error) {
  parentPort.postMessage({ statusCode: error.statusCode === 422 ? 422 : 503 });
}