
import TypedArrayHelpers from "/shared/TypedArrayHelpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Workout from "../../shared/Workout.js";
import confirmModal from "./confirm-modal.js";

export default class WorkoutService {

  // -----------------------------
  // PUBLIC API
  // -----------------------------
  static async deleteWorkoutByRow(row) {
    const data = row.getData();
    const workoutId = data.id;
    const filename = `Workout ${workoutId}`;

    const ok = await confirmModal({
      title: "Delete Workout",
      message: `Delete this workout?\n\n${filename}`,
      acceptLabel: "Delete Workout",
      cancelLabel: "Cancel",
      acceptClass: "btn-danger"
    });
    if (!ok) return;

    const response = await fetch(`/files/workouts/${workoutId}`, {
      method: "DELETE"
    });

    if (response.status === 401) {
      window.location.href = "/";
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Delete failed (${response.status})`);
    }

    await row.delete();
  }

  static async deleteWorkoutsByIds(workoutIds = []) {
    const normalizedIds = [...new Set(
      (Array.isArray(workoutIds) ? workoutIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )];

    if (!normalizedIds.length) {
      return [];
    }

    const response = await fetch("/files/workouts/bulk-delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workoutIds: normalizedIds
      })
    });

    if (response.status === 401) {
      window.location.href = "/";
      return [];
    }

    if (!response.ok) {
      let message = `Bulk delete failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    const result = await response.json();
    return Array.isArray(result.deletedIds) ? result.deletedIds : [];
  }

  static async loadWorkoutByRow(wid) {
    //console.log(row);

    //const wid = this.getWorkoutId(row);
    //console.time("fetchWO");
    try {
      const streamResponse = await fetch(`/workouts/${wid}/stream`);
      if (streamResponse.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!streamResponse.ok) {
        throw new Error(`Workout stream fetch failed (${streamResponse.status})`);
      }
      const buffer = await streamResponse.arrayBuffer();
      const workoutObject = Workout.fromBuffer(buffer);


      const trackResonse = await fetch(`/workouts/${wid}/track`);
      if (trackResonse.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!trackResonse.ok) {
        throw new Error(`Track fetch failed (${trackResonse.status})`);
      }

      const trackRow = await trackResonse.json();


  

      //console.timeEnd("fetchWO");




      /*const metaResponse = await fetch(`/files/workouts/${wid}/data`);

      if (metaResponse.status === 401) {
        window.location.href = '/login';
        return;
      }
      else {
        console.time("fetchOld");

        const { url } = await metaResponse.json();
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();*/

      const workout = {
        id: wid,
        workoutObject,
        validGps: !!(trackRow?.validgps ?? trackRow?.validGps ?? workoutObject.isValidGps()),
        sampleRateGPS: trackRow?.samplerategps ?? trackRow?.sampleRateGPS ?? 1,
        gpsSource: trackRow?.gps_source || null,
        segmentProcessingStatus: trackRow?.segment_processing_status || trackRow?.segmentProcessingStatus || "completed",
        segmentProcessingError: trackRow?.segment_processing_error || trackRow?.segmentProcessingError || null,
        segmentProcessingUpdatedAt: trackRow?.segment_processing_updated_at || trackRow?.segmentProcessingUpdatedAt || null,
        manualGpsLookupPoints: Array.isArray(trackRow?.manual_gps_lookup_points) ? trackRow.manual_gps_lookup_points : [],
        track: this.parseGeoJsonTrack(trackRow?.track),
        access: trackRow?.access || null
        //...WorkoutService.parseWorkoutBuffer(buffer)
      };

      //console.timeEnd("fetchOld");




      await SegmentService.fetchSegments(workout);

      return workout;
      //}
    }
    catch (err) {
      console.error("Parsing failed:", err.message);
    }

  }

  static async getWorkoutSharing(workoutId) {
    const response = await fetch(`/workouts/${workoutId}/sharing`, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Workout sharing load failed (${response.status})`);
    }

    const result = await response.json();
    return result.data;
  }

  static async updateWorkoutSharing(workoutId, payload) {
    const response = await fetch(`/workouts/${workoutId}/sharing`, {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Workout sharing update failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    const result = await response.json();
    return result.data;
  }

  static async getGpsCopyCandidates(workoutId) {
    const response = await fetch(`/workouts/${workoutId}/gps-copy-candidates`, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      let message = `GPS copy candidates failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    const result = await response.json();
    return Array.isArray(result?.candidates) ? result.candidates : [];
  }

  static async copyGpsFromWorkout(targetWorkoutId, sourceWorkoutId) {
    const response = await fetch(`/workouts/${targetWorkoutId}/gps-copy-from`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sourceWorkoutId
      })
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `GPS copy failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return response.json();
  }

  static async classifySimilarWorkouts(workoutId) {
    const response = await fetch(`/workouts/${workoutId}/similarity/classify`, {
      method: "POST",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Similarity classification failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return await response.json();
  }

  static async getSimilarWorkouts(workoutId) {
    const response = await fetch(`/workouts/${workoutId}/similarity`, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Similar workouts load failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return await response.json();
  }

  static async rebuildSimilarWorkouts(mode = "delta") {
    const response = await fetch("/workouts/similarity/rebuild", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: String(mode || "delta").trim().toLowerCase() === "full" ? "full" : "delta"
      })
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Similarity rebuild failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return await response.json();
  }

  static async getSimilarityRebuildJob(jobId) {
    const response = await fetch(`/workouts/similarity/rebuild/${jobId}`, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Similarity rebuild job load failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return await response.json();
  }

  static async saveManualGps(workoutId, points = []) {
    const response = await fetch(`/workouts/${workoutId}/manual-gps`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        points: Array.isArray(points) ? points : []
      })
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!response.ok) {
      let message = `Manual GPS save failed (${response.status})`;
      try {
        const result = await response.json();
        message = result.error || message;
      } catch {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
      throw new Error(message);
    }

    return await response.json();
  }

  static parseGeoJsonTrack(trackGeoJson) {
    if (!trackGeoJson || trackGeoJson.type !== "LineString") {
      return [];
    }

    return (trackGeoJson.coordinates || []).map(([lng, lat], idx) => ({
      lat,
      lng,
      idx
    }));
  }

  // -----------------------------
  // HELPERS
  // -----------------------------
  static getWorkoutId(rowOrData) {
    if (rowOrData && typeof rowOrData.getData === 'function') {
      const d = rowOrData.getData();
      return d.fileId ?? d.id;
    }

    if (rowOrData && typeof rowOrData === 'object') {
      return rowOrData.fileId ?? rowOrData.id;
    }

    console.warn("Unknown type:", rowOrData);
    return null;
  }

  static movingAverageCentered(values, windowSize = 10) {
    const out = new Array(values.length);
    const halfLeft = Math.floor((windowSize - 1) / 2);
    const halfRight = windowSize - 1 - halfLeft;

    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - halfLeft);
      const end = Math.min(values.length - 1, i + halfRight);

      let sum = 0;
      for (let j = start; j <= end; j++) {
        sum += values[j];
      }

      out[i] = Math.round(sum / (end - start + 1));
    }

    return out;
  }

  static smoothTypedArrayInPlace(arr, windowSize = 10) {
    const n = arr.length;
    if (n === 0) return arr;
    if (windowSize <= 1) return arr;

    const tmp = new Float64Array(n);
    let sum = 0;

    for (let i = 0; i < n; i++) {
      sum += arr[i];

      if (i >= windowSize) {
        sum -= arr[i - windowSize];
      }

      const divisor = Math.min(i + 1, windowSize);
      tmp[i] = sum / divisor;
    }

    for (let i = 0; i < n; i++) {
      arr[i] = Math.round(tmp[i]);
    }

    return arr;
  }

  // -----------------------------
  // PARSING
  // -----------------------------
  static parseWorkoutBuffer(buffer) {
    const view = new DataView(buffer);

    const recCount = view.getUint32(8, true);
    const validGps = (view.getUint32(12, true) === 1);
    const ts = Number(view.getBigInt64(16, true));
    const startdate = new Date(ts);
    const headerSize = 24;

    const [
      powers,
      heartRates,
      cadences,
      speeds,
      altitudes,
      latitudes,
      longitudes
    ] = TypedArrayHelpers.allocateViews(buffer, recCount, 0, headerSize);

    const { series, STRIDE } = this.buildWorkoutSeries(
      recCount,
      this.movingAverageCentered(powers, 50),
      this.movingAverageCentered(heartRates, 50),
      this.movingAverageCentered(cadences, 50),
      this.movingAverageCentered(speeds, 50),
      altitudes
    );

    const SEMI_TO_DEG = 18000 / 2147483648;

    const track = [];

    for (let i = 0; i < recCount; i++) {
      const lat = latitudes[i];
      const lng = longitudes[i];

      track.push({
        lat: lat * SEMI_TO_DEG,
        lng: lng * SEMI_TO_DEG,
        idx: i + 1
      });
    }

    return {
      startdate,
      validGps,
      recCount,
      series,
      STRIDE,
      track
    };
  }

  // -----------------------------
  // SERIES BUILDING
  // -----------------------------
  static buildWorkoutSeries(
    recCount,
    powers,
    heartRates,
    cadences,
    speeds,
    altitudes
  ) {
    const STRIDE = 10;
    const WIN5 = 5;
    const WIN15 = 15;
    const WIN_SPEED = 15;
    const WIN_ALTITUDE = 7;

    let sumPower5 = 0;
    let sumPower15 = 0;
    let sumSpeed5 = 0;
    let sumAltitude7 = 0;

    const data = new Float32Array(recCount * STRIDE);

    let idx = 0;

    for (let i = 0; i < recCount; i++) {
      idx = i * STRIDE;

      const power = powers[i];
      const heartRate = heartRates[i];
      const cadence = cadences[i];
      const speed = speeds[i] / 10;
      const altitude = altitudes[i];

      data[idx] = i;
      data[idx + 1] = power;
      data[idx + 2] = heartRate;
      data[idx + 3] = cadence;
      data[idx + 4] = speed;
      data[idx + 5] = altitude;

      sumPower5 += power;
      if (i + 1 >= WIN5) {
        sumPower5 -= data[(i + 1 - WIN5) * STRIDE + 1];
      }
      data[idx + 6] = sumPower5 / Math.min(i + 2, WIN5);

      sumPower15 += power;
      if (i + 1 >= WIN15) {
        sumPower15 -= data[(i + 1 - WIN15) * STRIDE + 1];
      }
      data[idx + 7] = sumPower15 / Math.min(i + 2, WIN15);

      sumSpeed5 += speed;
      if (i + 1 >= WIN_SPEED) {
        sumSpeed5 -= data[(i + 1 - WIN_SPEED) * STRIDE + 4];
      }
      data[idx + 8] = sumSpeed5 / Math.min(i + 2, WIN_SPEED);

      sumAltitude7 += altitude;
      if (i + 1 >= WIN_ALTITUDE) {
        sumAltitude7 -= data[(i + 1 - WIN_ALTITUDE) * STRIDE + 5];
      }
      data[idx + 9] = sumAltitude7 / Math.min(i + 2, WIN_ALTITUDE);
    }

    return { series: data, STRIDE };
  }
}
