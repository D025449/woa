import "./config/env.js";

import { createApp } from "./migrate-internal.js";

async function start() {
  console.log("Migration runner start");
  await createApp();
}

start().catch(() => {
  process.exitCode = 1;
});
