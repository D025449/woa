import { buildMicroIntervalBlock, summarizeMicroIntervalBlock } from './MicroIntervalDetector.js';

const TOLERANCE = 0.05;
const BIN_WIDTH = 8;
const BIN_COUNT = 512;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nominal(seconds) {
  const step = seconds < 120 ? 5 : 30;
  const rounded = Math.round(seconds / step) * step;
  return Math.abs(rounded - seconds) <= rounded * TOLERANCE ? rounded : Math.round(seconds);
}

function consistent(values) {
  const reference = median(values);
  return values.every(value => Math.abs(value - reference) <= reference * TOLERANCE + 1);
}

export function intervalBlockPatternLabel(block) {
  const summary = summarizeMicroIntervalBlock(block);
  const duration = kind => nominal(median((block.phases || []).filter(phase => phase.phase_kind === kind).map(phase => phase.duration)));
  const format = seconds => !Number.isFinite(seconds) || seconds <= 0 ? '? min'
    : seconds % 60 === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
  return `${summary.repetitions} × ${format(block.pattern_work_duration_seconds ?? duration('work'))} / ${format(block.pattern_recovery_duration_seconds ?? duration('recovery'))}`;
}

export function detectIntervalBlocks({ recordCount, powerAtIndex, metrics,
  start = 0, end = recordCount, minimumRepetitions = 3, excludedBlocks = [] }) {
  start = Math.max(0, Math.floor(start));
  end = Math.min(recordCount, Math.floor(end));
  const length = Math.max(0, end - start);
  const prefix = new Float64Array(length + 1);
  const missing = new Uint32Array(length + 1);
  const histogram = new Uint32Array(BIN_COUNT);
  let validCount = 0;
  for (let index = 0; index < length; index++) {
    const raw = powerAtIndex(start + index);
    const power = Number(raw);
    const valid = raw != null && Number.isFinite(power) && power >= 0 && power !== 0xffff;
    prefix[index + 1] = prefix[index] + (valid ? power : 0);
    missing[index + 1] = missing[index] + (valid ? 0 : 1);
    if (valid) { histogram[Math.min(BIN_COUNT - 1, Math.floor(power / BIN_WIDTH))]++; validCount++; }
  }
  if (!validCount) return [];
  const quantile = fraction => {
    let count = 0;
    for (let index = 0; index < BIN_COUNT; index++) {
      count += histogram[index];
      if (count >= validCount * fraction) return index * BIN_WIDTH;
    }
    return 0;
  };
  const low = quantile(0.20);
  const candidates = [];
  const levels = [...new Set([0.75, 0.85, 0.95, 0.99].map(quantile))];
  for (const high of levels) {
    const contrast = high - low;
    if (contrast < Math.max(40, high * 0.15)) continue;
    const enter = low + contrast * 0.65;
    const exit = low + contrast * 0.50;
    const runs = [];
    let active = null;
    let below = null;
    const close = limit => {
      if (active != null && limit - active >= 60 * (1 - TOLERANCE)) runs.push({ start: active, end: limit });
      active = null;
      below = null;
    };
    for (let index = 0; index < length; index++) {
      if (missing[index + 1] !== missing[index]) { close(index); continue; }
      const left = Math.max(0, index - 4), right = Math.min(length, index + 5);
      const smooth = (prefix[right] - prefix[left]) / (right - left);
      if (active == null) {
        if (smooth >= enter) active = index;
      } else if (smooth < exit) {
        below ??= index;
        if (index - below >= 5) close(below);
      } else below = null;
    }
    close(below ?? length);
    let series = [];
    const flush = () => {
      if (series.length < minimumRepetitions) return;
      const work = series.map(run => run.end - run.start);
      const rests = series.slice(1).map((run, index) => run.start - series[index].end);
      if (!consistent(work) || !consistent(rests)) return;
      const workSeconds = nominal(median(work)), recoverySeconds = nominal(median(rests));
      const block = buildMicroIntervalBlock({ start: start + series[0].start, workSeconds, recoverySeconds,
        repetitions: series.length, includeLastRecovery: false, structureKind: 'intervals', segmenttype: 'auto',
        phaseDurations: series.flatMap((run, index) => index < series.length - 1
          ? [run.end - run.start, series[index + 1].start - run.end] : [run.end - run.start]) }, metrics);
      const summary = summarizeMicroIntervalBlock(block);
      if (summary.workPower - summary.recoveryPower < Math.max(40, summary.workPower * 0.15)) return;
      const score = work.reduce((sum, duration) => sum + Math.abs(duration - workSeconds) / workSeconds, 0) / work.length
        + rests.reduce((sum, duration) => sum + Math.abs(duration - recoverySeconds) / recoverySeconds, 0) / rests.length;
      candidates.push({ block, score, repetitions: series.length });
    };
    for (const run of runs) {
      if (series.length) {
        const previous = series.at(-1);
        const gap = run.start - previous.end;
        const work = [...series.map(value => value.end - value.start), run.end - run.start];
        const rests = [...series.slice(1).map((value, index) => value.start - series[index].end), gap];
        const validGap = gap >= 15 && missing[run.start] === missing[previous.end];
        if (!validGap || !consistent(work) || !consistent(rests)) {
          const keepPrevious = series.length < minimumRepetitions && validGap
            && consistent([previous.end - previous.start, run.end - run.start]);
          flush();
          series = keepPrevious ? [previous] : [];
        }
      }
      series.push(run);
    }
    flush();
  }
  candidates.sort((left, right) => right.repetitions - left.repetitions || left.score - right.score);
  const blocks = [];
  for (const { block } of candidates) {
    if (![...excludedBlocks, ...blocks].some(existing => block.start_offset <= existing.end_offset && block.end_offset >= existing.start_offset)) blocks.push(block);
  }
  return blocks.sort((left, right) => left.start_offset - right.start_offset);
}