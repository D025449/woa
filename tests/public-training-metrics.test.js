import test from 'node:test';
import assert from 'node:assert/strict';
import WorkoutService from '../src/services/publicWorkoutApiService.js';
import AnalyticsService from '../src/services/publicAnalyticsApiService.js';
import { prepareYearlyFtpSeries, yearlyFtpAt, derivedCyclingMetrics } from '../src/services/publicTrainingMetrics.js';

test('workout and analytics services use the same full UTC FTP series and unrounded TSS basis', async () => {
  const ftp = [{ period: 2026, ftp: 301 }, { period: 2025, ftp: 200 }, { period: 2024, ftp: null }];
  for (const [start, expectedFtp, expectedTss] of [
    ['2025-07-02T12:00:00Z', 250.5, 64],
    ['2024-07-02T12:00:00Z', null, null],
    ['2027-07-02T12:00:00Z', 301, 44]
  ]) {
    const calls = [], row = { id: '7', entity_type: 'workout', workout_type: 'road',
      start_time: start, avg_normalized_power: 200, total_timer_time: 3600 };
    const database = { connect: async () => ({ query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: sql.includes('get_ftp_by_period2') ? ftp : sql.includes('FROM workouts') ? [row] : [] };
    }, release() {} }) };
    const workout = (await new WorkoutService({ database }).detail('42', '7')).data;
    const analytics = (await new AnalyticsService({ database, now: () => Date.parse('2028-01-01T00:00:00Z') }).summary('42',
      new URLSearchParams({ from: start.slice(0, 10), to: start.slice(0, 8) + '03' }))).data;
    assert.equal(workout.ftp_used_watts, expectedFtp);
    assert.equal(workout.tss, expectedTss);
    assert.equal(analytics.tss, expectedTss);
    assert.equal(analytics.missing_tss_count, expectedTss == null ? 1 : 0);
    const ftpCalls = calls.filter(call => call.sql.includes('get_ftp_by_period2'));
    assert.equal(ftpCalls.length, 2);
    assert.equal(ftpCalls[0].sql, ftpCalls[1].sql);
    assert.deepEqual(ftpCalls[0].params, ['42', 'year', 501]);
    assert.deepEqual(ftpCalls[1].params, ftpCalls[0].params);
    assert.doesNotMatch(ftpCalls[0].sql, /WHERE period/);
  }
});

test('shared FTP and cycling metrics preserve missing values, valid zero and UTC year boundaries', () => {
  const series = prepareYearlyFtpSeries([{ period: 2026, ftp: 300 }, { period: 2025, ftp: 200 },
    { period: 'bad', ftp: 999 }, { period: 2024, ftp: 0 }, { period: 2023, ftp: Infinity }]);
  assert.equal(yearlyFtpAt(series, Date.parse('2024-12-31T23:59:59Z')), null);
  assert.equal(yearlyFtpAt(series, Date.parse('2025-01-01T00:00:00Z')), 200);
  assert.equal(yearlyFtpAt(series, Date.parse('2026-01-01T00:00:00Z')), 300);
  assert.equal(yearlyFtpAt(series, NaN), null);
  assert.deepEqual(derivedCyclingMetrics(0, 3600, 250, true), { tss: 0, intensity_factor: 0, ftp_used_watts: 250 });
  assert.equal(derivedCyclingMetrics(null, 3600, 250, true).tss, null);
  assert.equal(derivedCyclingMetrics(200, null, 250, true).intensity_factor, 0.8);
  assert.equal(derivedCyclingMetrics(200, 3600, 250, false).ftp_used_watts, null);
});
