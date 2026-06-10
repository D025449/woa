import "../config/env.js";

import { createApp } from "./import-worker-internal.js";

async function start() {
  console.log("Import batch worker bootstrap start");
  await createApp({
    enableImportWorker: false,
    enableImportBatchWorker: true,
    enableSegmentBestEffortsWorker: false,
    enableWorkoutSimilarityWorker: false
  });
}

start();
