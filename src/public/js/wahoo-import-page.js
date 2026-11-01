import { initializeGarminImport } from "./garmin-import-ui.js?v=wahoo-import-1";
import { externalWorkoutImport } from "./upload-new.js?v=separate-import-1";

initializeGarminImport(externalWorkoutImport, { provider: "wahoo", extension: "fit" });
