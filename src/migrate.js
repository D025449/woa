import "./config/env.js";

import { createApp } from "./migrate-internal.js";

async function start() {
    console.log("Server debug start");
    const app = await createApp();
}

start();