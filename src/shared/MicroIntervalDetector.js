import { normalizeWorkoutSegmentStructure } from './WorkoutSegmentStructure.js';

const WINDOW = 120;
const BIN_WIDTH = 8;
const BIN_COUNT = 256;
// Allow a doubled finishing effort plus small timing deviations in measured edges.
const FINAL_WORK_DURATION_FACTOR = 2.10;

function histogramQuantile(histogram, count, fraction) {
  const target = Math.max(1, Math.ceil(count * fraction));
  let sum = 0;
  for (let index = 0; index < histogram.length; index++) {
    sum += histogram[index];
    if (sum >= target) return index * BIN_WIDTH;
  }
  return 0;
}

function durationMedian(values) {
  const histogram = new Uint32Array(181);
  for (const value of values) histogram[Math.min(180, Math.max(0, Math.round(value)))]++;
  const target = Math.floor(values.length / 2) + 1;
  let count = 0;
  for (let index = 0; index < histogram.length; index++) {
    count += histogram[index];
    if (count >= target) return index;
  }
  return 0;
}

function validPower(value) {
  return Number.isFinite(value) && value >= 0 && value !== 0xffff;
}

export function summarizeMicroIntervalBlock(block) {
  let workSeconds = 0, recoverySeconds = 0, workEnergy = 0, recoveryEnergy = 0;
  let workMeasured = 0, recoveryMeasured = 0, repetitions = 0;
  for (const phase of block?.phases || []) {
    if (phase.phase_kind === 'work') {
      repetitions++;
      workSeconds += phase.duration;
      if (phase.avg_power != null) { workEnergy += phase.avg_power * phase.duration; workMeasured += phase.duration; }
    } else {
      recoverySeconds += phase.duration;
      if (phase.avg_power != null) { recoveryEnergy += phase.avg_power * phase.duration; recoveryMeasured += phase.duration; }
    }
  }
  return { repetitions, workSeconds, recoverySeconds,
    workPower: workMeasured ? Math.round(workEnergy / workMeasured) : null,
    recoveryPower: recoveryMeasured ? Math.round(recoveryEnergy / recoveryMeasured) : null };
}

export function microIntervalPatternLabel(block) {
  const summary = summarizeMicroIntervalBlock(block);
  const work = block.pattern_work_duration_seconds;
  const recovery = block.pattern_recovery_duration_seconds;
  const approximate = (block.phases || []).some((phase) => Math.abs(phase.duration - (phase.phase_kind === 'work' ? work : recovery)) > 2);
  return `${summary.repetitions} × ${approximate ? '≈ ' : ''}${work ?? '?'} / ${recovery ?? '?'} s`;
}

export function buildMicroIntervalBlock({ start, workSeconds, recoverySeconds, repetitions,
  includeLastRecovery = true, phaseDurations = null, name = '', segmenttype = 'manual' }, metrics) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5000) throw new Error('Invalid repetition count');
  const values = phaseDurations || Array.from({ length: repetitions * 2 - (includeLastRecovery ? 0 : 1) }, (_, index) => index % 2 ? recoverySeconds : workSeconds);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5000
    || !Number.isInteger(start) || start < 0 || values.length !== repetitions * 2 - (includeLastRecovery ? 0 : 1)
    || values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('Invalid microinterval pattern');
  }
  let offset = start;
  const phases = values.map((duration, position) => {
    const phase = { position, phase_kind: position % 2 ? 'recovery' : 'work', repetition_index: Math.floor(position / 2) + 1,
      start_offset: offset, end_offset: offset + duration - 1, duration, ...metrics(offset, offset + duration) };
    offset += duration;
    return phase;
  });
  return normalizeWorkoutSegmentStructure({ start_offset: start, end_offset: offset - 1, duration: offset - start,
    segmenttype, structure_kind: 'microintervals', segmentname: name,
    pattern_work_duration_seconds: workSeconds, pattern_recovery_duration_seconds: recoverySeconds,
    phases, ...metrics(start, offset) });
}

// O(n): fixed-size rolling histogram, light centered smoothing and run grouping.
// No FTP, heart-rate rise, FFT, nested search over the power stream or sample objects.
export function detectMicroIntervalBlocks({ recordCount, powerAtIndex, metrics,
  start = 0, end = recordCount, minimumRepetitions = 5 }) {
  start = Math.max(0, Math.floor(start));
  end = Math.min(recordCount, Math.floor(end));
  const histogram = new Uint32Array(BIN_COUNT);
  const ring = new Int16Array(WINDOW).fill(-1);
  const runs = [];
  let count = 0, low = 0, high = 0, activeStart = null, lastEnd = null;
  let enter = Infinity, exit = Infinity, invalidSinceEnd = false;
  const close = (offset) => {
    if (activeStart != null && Number.isFinite(enter)) {
      const earliest = Math.max(activeStart + 1, offset - 3);
      for (let candidate = offset - 1; candidate >= earliest; candidate--) {
        const power = Number(powerAtIndex(candidate));
        if (!validPower(power) || power >= enter) break;
        offset = candidate;
      }
    }
    if (activeStart != null) runs.push({ start: activeStart, end: offset, missingBefore: invalidSinceEnd });
    activeStart = null;
    lastEnd = offset;
    invalidSinceEnd = false;
  };
  for (let index = start; index < end; index++) {
    const raw = Number(powerAtIndex(index));
    const slot = (index - start) % WINDOW;
    if (ring[slot] >= 0) { histogram[ring[slot]]--; count--; }
    ring[slot] = -1;
    if (!validPower(raw)) {
      close(index);
      invalidSinceEnd = true;
      continue;
    }
    const previous = Number(powerAtIndex(Math.max(start, index - 1)));
    const next = Number(powerAtIndex(Math.min(end - 1, index + 1)));
    const smooth = (raw + (validPower(previous) ? previous : raw) + (validPower(next) ? next : raw)) / 3;
    const bin = Math.min(BIN_COUNT - 1, Math.floor(smooth / BIN_WIDTH));
    histogram[bin]++; ring[slot] = bin; count++;
    if ((index - start) % 5 === 0 && count >= 15) {
      low = histogramQuantile(histogram, count, 0.25);
      high = histogramQuantile(histogram, count, 0.85);
      const contrast = high - low;
      enter = contrast >= Math.max(60, high * 0.20) ? low + contrast * 0.60 : Infinity;
      exit = contrast >= Math.max(60, high * 0.20) ? low + contrast * 0.40 : Infinity;
    }
    if (activeStart == null && smooth >= enter) {
      activeStart = index;
      // Quantiles need some high samples after a long steady section. Recover
      // the actual leading edge instead of shortening the first repetition.
      for (let previousIndex = index - 1; previousIndex >= Math.max(start, index - 30, lastEnd ?? start); previousIndex--) {
        const value = Number(powerAtIndex(previousIndex));
        if (!validPower(value) || value < enter) break;
        activeStart = previousIndex;
      }
      // Keep very brief power dips within one work phase, but never bridge missing samples.
      if (lastEnd != null && !invalidSinceEnd && runs.length
        && (index - lastEnd <= 3 || (index - lastEnd <= 5 && lastEnd - runs.at(-1).start >= 15))) {
        activeStart = runs.pop().start;
      }
    } else if (activeStart != null && smooth < exit) close(index);
  }
  if (activeStart != null) close(end);

  const blocks = [];
  let series = [];
  const flush = (limit = end) => {
    // The first one or two repetitions may need raw-data recovery when scanning
    // a selection that starts directly with work. Require the full count below.
    if (series.length >= Math.max(3, minimumRepetitions - 2)) {
      const durations = series.map((run) => run.end - run.start);
      const gaps = series.slice(1).map((run, index) => run.start - series[index].end);
      const work = durationMedian(durations), recovery = durationMedian(gaps);
      // A local threshold may enter the first effort during its ramp-up. The
      // established onset rhythm refines that edge when the discrepancy is small.
      const period = durationMedian(series.slice(1).map((run, index) => run.start - series[index].start));
      const alignedStart = series[1].start - period;
      if (Math.abs(alignedStart - series[0].start) <= 8 && alignedStart >= start) series[0].start = alignedStart;
      durations[0] = series[0].end - series[0].start;
      // Very short protocols can finish their first effort before the rolling
      // histogram has enough high samples. Recover at most two preceding cycles
      // only when the raw work/recovery contrast verifies the established rhythm.
      const referencePower = metrics(series[0].start, series[0].end).avg_power;
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidateStart = series[0].start - period;
        const candidateEnd = candidateStart + work;
        if (candidateStart < start || candidateEnd >= series[0].start) break;
        let workSum = 0, restSum = 0, valid = true;
        for (let index = candidateStart; index < series[0].start; index++) {
          const value = Number(powerAtIndex(index));
          if (!validPower(value)) { valid = false; break; }
          if (index < candidateEnd) workSum += value; else restSum += value;
        }
        if (!valid || workSum / work < referencePower * 0.75
          || restSum / (series[0].start - candidateEnd) > referencePower * 0.65) break;
        gaps.unshift(series[0].start - candidateEnd); durations.unshift(work);
        series.unshift({ start: candidateStart, end: candidateEnd, missingBefore: false });
      }
      const stable = series.length >= minimumRepetitions && durations.every((duration, index) => series[index].extendedFinal && index === series.length - 1
        ? duration >= work && duration <= work * FINAL_WORK_DURATION_FACTOR
        : Math.abs(duration - work) <= Math.max(6, work * 0.20))
        && gaps.every((gap) => Math.abs(gap - recovery) <= Math.max(5, recovery * 0.25));
      if (stable && recovery >= 5 && recovery <= 60 && recovery / work <= 2) {
        const trailingSeconds = series.at(-1).extendedFinal
          ? recovery : Math.max(0, period - (series.at(-1).end - series.at(-1).start));
        const trailing = Math.min(trailingSeconds, limit - series.at(-1).end);
        const lastEndOffset = series.at(-1).end;
        let trailingValid = trailing > 0;
        for (let index = lastEndOffset; trailingValid && index < lastEndOffset + trailing; index++) {
          const power = Number(powerAtIndex(index));
          if (!validPower(power)) trailingValid = false;
        }
        const phaseDurations = series.flatMap((run, index) => index < series.length - 1
          ? [run.end - run.start, series[index + 1].start - run.end]
          : [run.end - run.start, ...(trailingValid ? [trailing] : [])]);
        const block = buildMicroIntervalBlock({ start: series[0].start, workSeconds: Math.round(work / 5) * 5,
          recoverySeconds: Math.round(recovery / 5) * 5, repetitions: series.length,
          includeLastRecovery: trailingValid, phaseDurations, segmenttype: 'auto' }, metrics);
        // Reject tiny fluctuations even if they happen to follow a regular rhythm.
        const summary = summarizeMicroIntervalBlock(block);
        if (summary.workPower > 0 && summary.recoveryPower != null
          && summary.workPower - summary.recoveryPower >= Math.max(60, summary.workPower * 0.20)) blocks.push(block);
      }
    }
    series = [];
  };
  for (const run of runs) {
    const duration = run.end - run.start;
    // A longer finishing effort is allowed only at the end of an otherwise
    // regular series, never as a relaxed duration rule for the entire block.
    if (series.at(-1)?.extendedFinal) flush(run.start);
    if (duration < 10 || duration > 90 || run.missingBefore) { flush(run.start); if (duration < 10 || duration > 90) continue; }
    if (series.length) {
      const previous = series.at(-1), gap = run.start - previous.end;
      const previousDuration = previous.end - previous.start;
      const priorGap = series.length > 1 ? previous.start - series.at(-2).end : gap;
      const longerFinal = series.length >= Math.max(3, minimumRepetitions - 2)
        && duration > previousDuration && duration <= previousDuration * FINAL_WORK_DURATION_FACTOR;
      if (gap < 5 || gap > 60 || (Math.abs(duration - previousDuration) > Math.max(8, previousDuration * 0.25) && !longerFinal)
        || Math.abs(gap - priorGap) > Math.max(6, priorGap * 0.30)) flush(run.start);
      else if (longerFinal && Math.abs(duration - previousDuration) > Math.max(8, previousDuration * 0.25)) run.extendedFinal = true;
    }
    series.push(run);
  }
  flush();
  return blocks;
}

export function workoutPhaseMetrics(workout) {
  return (start, end) => {
    if (start < 0 || end > workout.length || end <= start) throw new Error('Phase exceeds workout');
    const averages = workout.getAverages(start, end - 1);
    const finite = (value) => Number.isFinite(value) ? value : null;
    return { avg_power: Math.round(averages.power), avg_heart_rate: finite(Math.round(averages.hr)),
      avg_cadence: finite(Math.round(averages.cadence)), avg_speed: finite(Math.round(averages.speed * 100) / 100),
      altimeters: finite(Math.round((workout.getAltitudeAt(end - 1) - workout.getAltitudeAt(start)) * 1000)) };
  };
}
