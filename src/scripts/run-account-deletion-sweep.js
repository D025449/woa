import "../config/env.js";

import AccountDeletionService from "../services/accountDeletionService.js";

async function main() {
  const summary = await AccountDeletionService.runDueDeletionBatch();
  console.log("Account deletion sweep summary", summary);
}

main().catch((error) => {
  console.error("Account deletion sweep failed", error);
  process.exitCode = 1;
});

