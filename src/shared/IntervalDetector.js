
import { SegmentService } from "./SegmentService.js";

class IntervalDetector {
  // ================================
  // PUBLIC API
  // ================================
  static detect(records) {
    const len = records.length;

    // --- Power extrahieren
    const power = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      power[i] = records[i].power || 0;
    }

    const smoothPower = this.movingAverage(power, 7);
    const baseline = this.computeBaseline(smoothPower);

    const enterThreshold = baseline * 1.4;
    const exitThreshold = baseline * 1.1;

    const minDuration = 20;

    const intervals = [];

    let state = 0; // 0 = REST, 1 = WORK
    let startIdx = 0;

    for (let i = 0; i < len; i++) {
      const p = smoothPower[i];

      if (state === 0) {
        if (p > enterThreshold) {
          state = 1;
          startIdx = i;
        }
      } else {
        if (p < exitThreshold) {
          const duration = i - startIdx;

          if (duration >= minDuration) {
            if (this.isValidInterval(records, startIdx, i)) {
              intervals.push(
                this.buildInterval(records, smoothPower, startIdx, i)
              );
            }
          }

          state = 0;
        }
      }
    }

    return this.mergeCloseIntervals(intervals, 10);
  }

  // ================================
  // INTERVAL BUILDING
  // ================================
  static buildInterval(records, smoothPower, start, end) {
    let sumPower = 0;
    let sumHR = 0;
    let sumSpeed = 0;
    let sumCadence = 0;

    let hrCount = 0;
    let speedCount = 0;
     let cadenceCount = 0;

    for (let i = start; i < end; i++) {
      sumPower += smoothPower[i];

      const hr = records[i].heart_rate;
      if (hr != null) {
        sumHR += hr;
        hrCount++;
      }

      const speed = records[i].speed;
      if (speed != null) {
        sumSpeed += speed;
        speedCount++;
      }

      const cadence = records[i].cadence;
      if (cadence != null) {
        sumCadence += cadence;
        cadenceCount++;
      }


    }

    const duration = end - start;

    return {
      start,
      end,
      duration,

      avgPower: Math.round(sumPower / duration),

      avgHeartRate: hrCount
        ? Math.round(sumHR / hrCount)
        : null,

      avgSpeed: speedCount
        ? this.round1(sumSpeed / speedCount)
        : null,
      avgCadence: cadenceCount
        ? Math.round(sumCadence / cadenceCount)
        : null,
      altitude_start : ( records[start]?.altitude != null ) ? Math.round(records[start].altitude * 1000) : null,
      altitude_end : ( records[end - 1]?.altitude != null ) ? Math.round(records[end - 1].altitude * 1000) : null,
      altimeters: ( records[start]?.altitude != null && records[end - 1]?.altitude != null)
        ? Math.round((records[end - 1].altitude - records[start].altitude) * 1000)
        : null
    };
  }

  // ================================
  // POWER PROCESSING
  // ================================
  static movingAverage(arr, windowSize) {
    const result = new Float32Array(arr.length);
    let sum = 0;

    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= windowSize) sum -= arr[i - windowSize];
      result[i] = sum / Math.min(i + 1, windowSize);
    }

    return result;
  }

  static computeBaseline(power) {
    const sorted = Array.from(power).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.3)];
  }

  // ================================
  // VALIDATION
  // ================================
  static isValidInterval(records, start, end) {
    const r0 = records[start];
    const r1 = records[end - 1];

    // HR muss steigen (optional, aber sinnvoll)
    if (r0.heart_rate != null && r1.heart_rate != null) {
      if (r1.heart_rate < r0.heart_rate + 5) return false;
    }

    // Cadence-Check (coasting rausfiltern)
    let activeSamples = 0;

    for (let i = start; i < end; i++) {
      if ((records[i].cadence || 0) > 0) activeSamples++;
    }

    return activeSamples > (end - start) * 0.5;
  }

  // ================================
  // POST PROCESSING (MERGE)
  // ================================
  static mergeCloseIntervals(intervals, maxGap) {
    if (intervals.length === 0) return intervals;

    const merged = [];
    let current = intervals[0];

    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i];

      if (next.start - current.end <= maxGap) {
        const totalDuration = current.duration + next.duration;

        const avgPower =
          (current.avgPower * current.duration +
            next.avgPower * next.duration) /
          totalDuration;

        const avgHR = this.weightedMerge(
          current.avgHeartRate,
          next.avgHeartRate,
          current.duration,
          next.duration
        );

        const avgSpeed = this.weightedMerge(
          current.avgSpeed,
          next.avgSpeed,
          current.duration,
          next.duration
        );
        const avgCadence = this.weightedMerge(
          current.avgCadence,
          next.avgCadence,
          current.duration,
          next.duration
        );



        current = {
          start: current.start,
          end: next.end,
          duration: next.end - current.start,
          altitude_start: current.altitude_start,
          altitude_end: next.altitude_end,
          altimeters:  next.altitude_end - current.altitude_start,
          avgPower: Math.round(avgPower),
          avgHeartRate: avgHR != null ? Math.round(avgHR) : null,
          avgSpeed: avgSpeed != null ? this.round1(avgSpeed) : null,
          avgCadence: avgCadence != null ? this.round1(avgCadence) : null          
        };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  // ================================
  // HELPERS
  // ================================
  static weightedMerge(a, b, wa, wb) {
    if (a == null) return b;
    if (b == null) return a;
    return (a * wa + b * wb) / (wa + wb);
  }

  static round1(value) {
    return Math.round(value * 10) / 10;
  }

  


  static writeIntervalsToArrays(
    intervals,
    starts,
    ends,
    durations,
    powers,
    heartRates,
    speeds,
    speedScale = 1 // optional (z. B. 10)
  ) {
    const len = intervals.length;

    for (let i = 0; i < len; i++) {
      const it = intervals[i];

      starts[i] = it.start;
      ends[i] = it.end;
      durations[i] = it.duration;

      powers[i] = it.avgPower ?? 0;
      heartRates[i] = it.avgHeartRate ?? 0;

      // Speed optional skalieren (z. B. *10 → int)
      const sp = it.avgSpeed ?? 0;
      speeds[i] = speedScale !== 1
        ? Math.round(sp * speedScale)
        : sp;
    }

    return len;
  }



}

export { IntervalDetector };