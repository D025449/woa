import Workout from "/shared/Workout.js";
import GpsTrackBlobCodec from "/shared/GpsTrackBlobCodec.js";
import WorkoutOpenV2 from "/shared/WorkoutOpenV2.js";
import FitExportService from "/shared/FitExportService.js";
import { formatFitExportFileName, getBrowserTimeZone } from "/shared/FitFileName.js";

self.addEventListener("message", async (event) => {
  const { jobId, payloadBytes } = event.data || {};
  try {
    const payload = WorkoutOpenV2.parsePayload(payloadBytes);
    const meta = payload.meta || {};
    const rawWorkout = await Workout.decompress(
      payload.workoutStream,
      meta.streamCodec || "gzip"
    );
    const workout = Workout.fromBuffer(rawWorkout);
    const decodedTrack = await GpsTrackBlobCodec.decodeCompressed(payload.gpsTrackBlob, {
      includeGeoJson: false,
      codec: meta.gpsTrackCodec || "identity"
    });
    const gpsCoordinates = Array.isArray(decodedTrack?.track)
      ? decodedTrack.track
        .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
        .map((point) => [Number(point.lat), Number(point.lng)])
      : [];
    const workoutId = Number(meta.workoutId);
    const fitBytes = FitExportService.buildFitFromWorkout(workout, {
      serialNumber: workoutId,
      sampleRateGps: meta.sampleRateGps,
      gpsCoordinates,
      includeGps: !!meta.validGps,
      gpsSource: meta.gpsSource || null,
      fitDeviceMetadata: workout.fitDeviceMetadata || meta.fitDeviceMetadata || null,
      normalizedPower: meta.normalizedPower,
      totalCalories: meta.totalCalories,
      workoutType: meta.workoutType,
      segments: Array.isArray(payload.segments) ? payload.segments : []
    });

    self.postMessage({
      type: "result",
      jobId,
      fileName: formatFitExportFileName(meta.startTime, {
        timeZone: getBrowserTimeZone(),
        fallbackName: `W-${workoutId}.fit`,
        suffix: `-W-${workoutId}`
      }),
      fitBytes
    }, [fitBytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId,
      message: error?.message || String(error)
    });
  }
});
