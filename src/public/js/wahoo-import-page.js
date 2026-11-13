import { initializeGarminImport } from "./garmin-import-ui.js?v=wahoo-import-1";
import { externalWorkoutImport } from "./upload-new.js?v=fit-s3-3";

initializeGarminImport(externalWorkoutImport, { provider: "wahoo", extension: "fit" });
