import "./config/env.js";

import { createApp } from "./app.js";
import { startAccountDeletionScheduler } from "./services/accountDeletionScheduler.js";
import { startImportJobCleanupScheduler } from "./services/importJobCleanupScheduler.js";

async function start() {
    console.log("Server debug start");
    const app = await createApp();

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });

    startAccountDeletionScheduler();
    startImportJobCleanupScheduler();

}

start();
