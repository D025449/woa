import assert from "node:assert/strict";
import test from "node:test";

import { filterPowerArtifactsInPlace } from "../src/shared/powerArtifactFilter.js";

function createSeries({
  powers,
  cadences = powers.map(() => 88),
  heartRates = powers.map(() => 166),
  speeds = powers.map(() => 6.4)
}) {
  return {
    recordCount: powers.length,
    powersW: Uint16Array.from(powers),
    cadencesRpm: Uint8Array.from(cadences),
    heartRatesBpm: Uint8Array.from(heartRates),
    speeds: Float64Array.from(speeds)
  };
}

test("interpolates a short unsupported power spike", () => {
  const series = createSeries({
    powers: [345, 345, 219, 219, 273, 273, 312, 312, 1260, 1260, 128, 128, 120, 120, 143, 143, 253]
  });

  const stats = filterPowerArtifactsInPlace(series);

  assert.deepEqual(stats, {
    artifactCount: 1,
    correctedSampleCount: 2,
    maximumCorrectedPowerW: 1260
  });
  assert.deepEqual(Array.from(series.powersW.slice(6, 12)), [312, 312, 251, 189, 128, 128]);
});

test("keeps a peak supported by rising cadence and speed", () => {
  const powers = [220, 240, 260, 280, 300, 320, 350, 400, 1100, 1200, 1150, 420, 360, 320, 280];
  const cadences = [82, 83, 84, 85, 86, 87, 88, 90, 108, 112, 110, 96, 90, 87, 85];
  const speeds = [8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 9, 10.8, 11.5, 12, 12.2, 11.8, 11.2, 10.8];
  const series = createSeries({ powers, cadences, speeds });

  const stats = filterPowerArtifactsInPlace(series);

  assert.equal(stats.artifactCount, 0);
  assert.deepEqual(Array.from(series.powersW), powers);
});

test("removes a short peak supported by only one corroborating signal", () => {
  const powers = [0, 0, 426, 426, 432, 432, 1088, 1088, 229, 229, 0, 0, 0];
  const cadences = [0, 0, 48, 48, 61, 61, 73, 73, 108, 108, 0, 0, 0];
  const speeds = [5.77, 5.77, 7.21, 7.21, 9.39, 9.39, 10, 10, 9.84, 9.84, 8.18, 8.18, 5.55];
  const heartRates = [132, 132, 133, 133, 134, 134, 134, 134, 135, 135, 134, 134, 135];
  const series = createSeries({ powers, cadences, speeds, heartRates });

  const stats = filterPowerArtifactsInPlace(series);

  assert.equal(stats.artifactCount, 1);
  assert.deepEqual(Array.from(series.powersW.slice(4, 10)), [432, 432, 364, 297, 229, 229]);
});

test("keeps sustained high power and unsupported data without corroborating sensors", () => {
  const sustained = createSeries({
    powers: [250, 260, 270, 900, 950, 1000, 950, 280, 270]
  });
  assert.equal(filterPowerArtifactsInPlace(sustained).artifactCount, 0);

  const noSensors = {
    recordCount: 9,
    powersW: Uint16Array.from([250, 260, 270, 1200, 130, 140, 150, 160, 170])
  };
  assert.equal(filterPowerArtifactsInPlace(noSensors).artifactCount, 0);
});
