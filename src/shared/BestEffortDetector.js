class BestEffortDetector {
  static DURATIONS = [5, 15, 60, 120, 240, 480, 900, 1800];

  static detect(records) {
    const durations = BestEffortDetector.DURATIONS;
    const n = records?.length ?? 0;

    if (n === 0) return [];

    const powerSum = new Float64Array(n + 1);

    const hrSum = new Float64Array(n + 1);
    const hrCount = new Uint32Array(n + 1);

    const cadenceSum = new Float64Array(n + 1);
    const cadenceCount = new Uint32Array(n + 1);

    const speedSum = new Float64Array(n + 1);
    const speedCount = new Uint32Array(n + 1);

    for (let i = 0; i < n; i++) {
      const r = records[i];

      const power = Number(r.power ?? 0);
      powerSum[i + 1] = powerSum[i] + power;

      const hrValid = r.heart_rate != null;
      const hr = hrValid ? Number(r.heart_rate) : 0;
      hrSum[i + 1] = hrSum[i] + hr;
      hrCount[i + 1] = hrCount[i] + (hrValid ? 1 : 0);

      const cadenceValid = r.cadence != null;
      const cadence = cadenceValid ? Number(r.cadence) : 0;
      cadenceSum[i + 1] = cadenceSum[i] + cadence;
      cadenceCount[i + 1] = cadenceCount[i] + (cadenceValid ? 1 : 0);

      const speedValid = r.speed != null;
      const speed = speedValid ? Number(r.speed) : 0;
      speedSum[i + 1] = speedSum[i] + speed;
      speedCount[i + 1] = speedCount[i] + (speedValid ? 1 : 0);
    }

    function rangeSum(prefix, offset, duration) {
      return prefix[offset + duration] - prefix[offset];
    }

    function rangeCount(prefix, offset, duration) {
      return prefix[offset + duration] - prefix[offset];
    }

    const results = [];

    for (const duration of durations) {
      if (duration > n) {
        results.push({
          startOffset: null,
          duration,
          endOffset: null,
          avgPower: null,
          avgHeartRate: null,
          avgCadence: null,
          avgSpeed: null,
        });
        continue;
      }

      let bestOffset = 0;
      let bestAvgPower = -Infinity;

      for (let offset = 0; offset <= n - duration; offset++) {
        const avgPower = rangeSum(powerSum, offset, duration) / duration;

        if (avgPower > bestAvgPower) {
          bestAvgPower = avgPower;
          bestOffset = offset;
        }
      }

      const endOffset = bestOffset + duration - 1;

      const avgPower = rangeSum(powerSum, bestOffset, duration) / duration;

      const hrN = rangeCount(hrCount, bestOffset, duration);
      const avgHeartRate =
        hrN > 0 ? rangeSum(hrSum, bestOffset, duration) / hrN : null;

      const cadenceN = rangeCount(cadenceCount, bestOffset, duration);
      const avgCadence =
        cadenceN > 0
          ? rangeSum(cadenceSum, bestOffset, duration) / cadenceN
          : null;

      const speedN = rangeCount(speedCount, bestOffset, duration);
      const avgSpeed =
        speedN > 0 ? rangeSum(speedSum, bestOffset, duration) / speedN : null;

      results.push({
        start_offset: bestOffset,
        duration,
        endOffset,
        avgPower: Math.round(avgPower),
        avgHeartRate: avgHeartRate == null ? null : Math.round(avgHeartRate),
        avgCadence: avgCadence == null ? null : Math.round(avgCadence),
        avgSpeed: avgSpeed == null ? null : Number(avgSpeed.toFixed(2)),
      });
    }

    return results;
  }
}


export { BestEffortDetector };