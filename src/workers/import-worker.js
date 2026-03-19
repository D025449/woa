import "../config/env.js";

import { createApp } from "./import-worker-internal.js"

async function start() {
  console.log("Worker debug start");
  await createApp();


}

start();
