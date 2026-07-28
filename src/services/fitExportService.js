import SharedFitExportService, {
  fitTimestampFromMs,
  toSemicircles
} from "../shared/FitExportService.js";

export default class FitExportService {
  static buildFitFromWorkout(workout, options = {}) {
    const bytes = SharedFitExportService.buildFitFromWorkout(workout, options);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

export {
  fitTimestampFromMs,
  toSemicircles
};
