import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMicroIntervalBlock, detectMicroIntervalBlocks, summarizeMicroIntervalBlock } from '../src/shared/MicroIntervalDetector.js';
import { decodeWorkoutLocalPostprocessTransport, encodeWorkoutLocalPostprocessTransport, detectWorkoutLocalSegmentsCompact } from '../src/shared/WorkoutLocalPostprocess.js';
import { normalizeWorkoutLocalPostprocessPayload } from '../src/services/workoutLocalPostprocessImportService.js';
import { microIntervalScanChanges } from '../src/public/js/microinterval-client.js';
import { buildMicroIntervalPhaseAreas } from '../src/public/js/chart-helpers.js';
import { parseSegmentTime } from '../src/public/js/microinterval-editor.js';
import { buildAdminWorkoutBackup, decodeAdminWorkoutBackup } from '../src/services/adminWorkoutBackupService.js';
import { classifyWorkoutIntensity, extractWorkoutIntensityFeatures } from '../src/shared/WorkoutIntensityClassifier.js';

const repeat = (power, seconds) => Array(seconds).fill(power);
function series(count, work = 40, recovery = 20, power = 380) {
  return Array.from({ length: count }, () => [...repeat(power, work), ...repeat(80, recovery)]).flat();
}
function scan(powers, options = {}) {
  return detectMicroIntervalBlocks({ recordCount: powers.length, powerAtIndex: (index) => powers[index],
    metrics: (start, end) => ({ avg_power: Math.round(powers.slice(start, end).reduce((sum, power) => sum + power, 0) / (end - start)) }), ...options });
}

test('recognizes two independent 40/20 blocks with ten and nine repetitions', () => {
  const powers = [...repeat(170, 180), ...series(10), ...repeat(180, 180), ...series(9, 40, 20, 410), ...repeat(170, 180)];
  const blocks = scan(powers);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => summarizeMicroIntervalBlock(block).repetitions), [10, 9]);
  assert.deepEqual(blocks.map((block) => block.duration), [600, 540]);
  assert.deepEqual(blocks.map((block) => [block.pattern_work_duration_seconds, block.pattern_recovery_duration_seconds]), [[40, 20], [40, 20]]);
});

test('recognizes shorter patterns without losing the leading repetitions', () => {
  for (const [work, recovery] of [[30, 15], [30, 30], [15, 15], [10, 5]]) {
    const [block] = scan([...repeat(170, 180), ...series(10, work, recovery), ...repeat(170, 180)]);
    assert.ok(block, `${work}/${recovery}`);
    assert.equal(summarizeMicroIntervalBlock(block).repetitions, 10);
    assert.equal(block.start_offset, 180);
  }
});

test('recognizes five 30/30 repetitions when the final work phase is prolonged to 45 seconds', () => {
  const powers = [...repeat(170, 180), ...series(4, 30, 30, 420),
    ...repeat(420, 45), ...repeat(80, 180), ...series(5, 60, 60, 350), ...repeat(170, 180)];
  for (const range of [{}, { start: 180, end: 180 + 4 * 60 + 45 + 30 }]) {
    const blocks = scan(powers, range);
    assert.equal(blocks.length, range.start ? 1 : 2);
    assert.equal(summarizeMicroIntervalBlock(blocks[0]).repetitions, 5);
    assert.equal(blocks[0].pattern_work_duration_seconds, 30);
    assert.equal(blocks[0].pattern_recovery_duration_seconds, 30);
    assert.equal(blocks[0].phases.filter((phase) => phase.phase_kind === 'work').at(-1).duration, 45);
    assert.equal(blocks[0].phases.at(-1).duration, 30);
  }
});

test('still rejects a doubled final effort and irregular work durations', () => {
  assert.deepEqual(scan([...repeat(170, 180), ...series(4, 30, 30), ...repeat(380, 60), ...repeat(80, 180)]), []);
  const irregular = [30, 45, 30, 45, 30].flatMap((duration) => [...repeat(380, duration), ...repeat(80, 30)]);
  assert.deepEqual(scan([...repeat(170, 180), ...irregular, ...repeat(170, 180)]), []);
});

test('import classification reuses fine-grained microinterval blocks', () => {
  const powers = [...repeat(170, 180), ...series(10), ...repeat(170, 180)];
  const features = extractWorkoutIntensityFeatures({ recordCount: powers.length, powerAtIndex: (index) => powers[index] });
  features.microIntervalBlocks = scan(powers);
  // Deliberately remove coarse buckets: the recognized structure is sufficient.
  features.powerBuckets = [];
  const result = classifyWorkoutIntensity(features, { ftp: 250, confidence: 100,
    powerDurationCurve: { 30: 550, 60: 450, 120: 400, 240: 370, 480: 300, 900: 270, 1200: 260 } });
  assert.equal(result.profile, 'vo2max');
  assert.equal(result.evidence.microIntervalSeriesCount, 1);
  assert.equal(result.evidence.microIntervalRepetitionCount, 10);
});

test('rejects steady rides, small periodic fluctuations and sprints with long rests', () => {
  assert.deepEqual(scan(repeat(220, 3600)), []);
  const small = Array.from({ length: 10 }, () => [...repeat(230, 40), ...repeat(200, 20)]).flat();
  assert.deepEqual(scan(small), []);
  assert.deepEqual(scan([...repeat(150, 180), ...series(6, 30, 180)]), []);
});

test('brief dips remain part of a work phase, while missing samples split blocks', () => {
  const powers = [...repeat(170, 180), ...series(10), ...repeat(170, 180)];
  powers.fill(200, 180 + 4 * 60 + 16, 180 + 4 * 60 + 21);
  assert.equal(summarizeMicroIntervalBlock(scan(powers)[0]).repetitions, 10);
  powers.fill(0xffff, 180 + 4 * 60 + 16, 180 + 4 * 60 + 21);
  for (const block of scan(powers)) {
    assert.ok(!(block.start_offset <= 436 && block.end_offset >= 441));
  }
});

test('selection scanning stays within the selection and caps truncated last recovery', () => {
  const powers = [...repeat(170, 180), ...series(10), ...repeat(170, 180)];
  const blocks = scan(powers, { start: 180, end: 773 });
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].end_offset < 773);
  assert.equal(summarizeMicroIntervalBlock(blocks[0]).repetitions, 10);
});

test('scanning has a bounded number of power reads on a twelve-hour stream', () => {
  const count = 12 * 3600;
  let reads = 0;
  const blocks = detectMicroIntervalBlocks({ recordCount: count, powerAtIndex: () => { reads++; return 200; }, metrics: () => ({ avg_power: 200 }) });
  assert.deepEqual(blocks, []);
  assert.ok(reads <= count * 4);
});

test('manual editor builds actual custom phases, optional final recovery and safe boundaries', () => {
  const block = buildMicroIntervalBlock({ start: 180, workSeconds: 40, recoverySeconds: 20, repetitions: 2,
    includeLastRecovery: false, phaseDurations: [42, 18, 40] }, () => ({ avg_power: 300 }));
  assert.equal(block.duration, 100);
  assert.deepEqual(block.phases.map((phase) => phase.start_offset), [180, 222, 240]);
  assert.equal(block.end_offset, 279);
  assert.equal(parseSegmentTime('14:20'), 860);
  assert.equal(parseSegmentTime('1:14:20'), 4460);
  assert.throws(() => parseSegmentTime('14:70'));
  assert.throws(() => buildMicroIntervalBlock({ start: 0, workSeconds: 40, recoverySeconds: 20, repetitions: 100000 }, () => ({ avg_power: 300 })));
});

test('repeated scans replace only automatic blocks and respect manual block ranges', () => {
  const [automatic] = scan([...repeat(170, 180), ...series(10), ...repeat(170, 180)]);
  const manual = { ...automatic, id: 55, segmenttype: 'manual' };
  const changes = microIntervalScanChanges({ segments: [manual, { ...automatic, id: 56 }] }, [automatic]);
  assert.deepEqual(changes.map((segment) => [segment.rowstate, segment.id]), [['DEL', 56]]);
});

test('WPP transport preserves microinterval phases while old unstructured payloads stay version 2', () => {
  const powers = [...repeat(170, 180), ...series(10), ...repeat(170, 180)];
  const compact = { recordCount: powers.length, powersW: Uint16Array.from(powers),
    heartRatesBpm: new Uint8Array(powers.length).fill(140), cadencesRpm: new Uint8Array(powers.length).fill(90),
    speedsCmS: new Uint16Array(powers.length).fill(900), altitudesQ: new Int16Array(powers.length).fill(400), distancesQ: new Uint32Array(powers.length).fill(0xffffffff) };
  const segments = detectWorkoutLocalSegmentsCompact(compact);
  const bytes = encodeWorkoutLocalPostprocessTransport([{ startTimeSec: 1700000000, recordCount: powers.length, segments }]);
  const decoded = decodeWorkoutLocalPostprocessTransport(bytes);
  assert.equal(decoded.version, 3);
  const normalized = normalizeWorkoutLocalPostprocessPayload(decoded);
  const block = normalized.workouts[0].segments.find((segment) => segment.structure_kind === 'microintervals');
  assert.equal(block.phases.length, 20);
  assert.equal(block.duration, 600);
  const old = encodeWorkoutLocalPostprocessTransport([{ startTimeSec: 1700000000, recordCount: powers.length, segments: segments.filter((segment) => !segment.structure_kind) }]);
  assert.equal(decodeWorkoutLocalPostprocessTransport(old).version, 2);
  assert.throws(() => decodeWorkoutLocalPostprocessTransport(bytes.subarray(0, bytes.length - 1)), /extension/u);
});

test('phase rendering uses parent identity and half-open display widths', () => {
  const block = buildMicroIntervalBlock({ start: 100, workSeconds: 40, recoverySeconds: 20, repetitions: 1 }, () => ({ avg_power: 300 }));
  block.id = 12;
  const areas = buildMicroIntervalPhaseAreas(block);
  assert.equal(areas.length, 2);
  assert.deepEqual(areas.map((area) => [area[0].xAxis, area[1].xAxis]), [[100, 140], [140, 160]]);
  assert.equal(areas[0][0].segmentId, 12);
  assert.ok(areas[0][0].itemStyle.opacity > areas[1][0].itemStyle.opacity);
});

test('native admin backup round trip retains the complete microinterval structure', async () => {
  const block = buildMicroIntervalBlock({ start: 100, workSeconds: 40, recoverySeconds: 20, repetitions: 2 }, () => ({ avg_power: 300 }));
  const archive = buildAdminWorkoutBackup({ workouts: [{ id: 1, uid: 49, owner_auth_sub: 'test-owner', owner_email: 'test@example.com', stream: Buffer.from('test'), stream_codec: 'gzip' }],
    segments: [{ ...block, wid: 1 }], favorites: [] });
  const decoded = await decodeAdminWorkoutBackup(archive);
  const restored = decoded.workouts[0].segments[0];
  assert.equal(restored.structure_kind, 'microintervals');
  assert.deepEqual(restored.phases, block.phases);
});
