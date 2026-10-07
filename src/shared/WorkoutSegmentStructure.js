export class WorkoutSegmentValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkoutSegmentValidationError';
    this.status = status;
  }
}

const METRICS = ['avg_power', 'avg_heart_rate', 'avg_cadence', 'avg_speed', 'altimeters'];

function requireInteger(value, minimum, field) {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw new WorkoutSegmentValidationError(`Invalid ${field}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 2147483647) {
    throw new WorkoutSegmentValidationError(`Invalid ${field}`);
  }
  return number;
}

function metricsOf(source, requiredPower = false) {
  return Object.fromEntries(METRICS.map((field) => {
    const raw = source[field];
    if (raw == null && !(field === 'avg_power' && requiredPower)) return [field, null];
    const value = Number(raw);
    if (raw == null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(value)
      || (field !== 'altimeters' && value < 0)) {
      throw new WorkoutSegmentValidationError(`Invalid ${field}`);
    }
    return [field, value];
  }));
}

// The same validation can be used by the browser editor and the server.
// Offsets are inclusive seconds from workout start, not from block start.
export function normalizeWorkoutSegmentStructure(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    throw new WorkoutSegmentValidationError('Invalid segment');
  }
  const start = requireInteger(segment.start_offset, 0, 'segment start');
  const end = requireInteger(segment.end_offset, start, 'segment end');
  const duration = requireInteger(segment.duration, 1, 'segment duration');
  const type = segment.segmenttype ?? 'manual';
  if (!['manual', 'auto', 'crit'].includes(type)) {
    throw new WorkoutSegmentValidationError('Invalid segment type');
  }
  const kind = segment.structure_kind ?? 'simple';
  if (!['simple', 'microintervals'].includes(kind)) {
    throw new WorkoutSegmentValidationError('Invalid segment structure');
  }
  const normalized = {
    ...segment,
    start_offset: start,
    end_offset: end,
    duration,
    segmenttype: type,
    structure_kind: kind,
    ...metricsOf(segment, true)
  };
  if (kind === 'simple') {
    if ((segment.phases != null && (!Array.isArray(segment.phases) || segment.phases.length > 0))
      || segment.pattern_work_duration_seconds != null || segment.pattern_recovery_duration_seconds != null) {
      throw new WorkoutSegmentValidationError('A simple segment cannot contain a microinterval pattern or phases');
    }
    return { ...normalized, pattern_work_duration_seconds: null, pattern_recovery_duration_seconds: null, phases: [] };
  }
  if (!['manual', 'auto'].includes(type) || duration !== end - start + 1) {
    throw new WorkoutSegmentValidationError('Invalid microinterval block type or duration');
  }
  const work = segment.pattern_work_duration_seconds;
  const recovery = segment.pattern_recovery_duration_seconds;
  if ((work == null) !== (recovery == null)) {
    throw new WorkoutSegmentValidationError('Both pattern durations must be supplied together');
  }
  normalized.pattern_work_duration_seconds = work == null ? null : requireInteger(work, 1, 'pattern work duration');
  normalized.pattern_recovery_duration_seconds = recovery == null ? null : requireInteger(recovery, 1, 'pattern recovery duration');
  if (!Array.isArray(segment.phases) || segment.phases.length === 0 || segment.phases.length > 10000) {
    throw new WorkoutSegmentValidationError('A microinterval block needs 1–10000 phases');
  }
  let nextStart = start;
  normalized.phases = segment.phases.map((phase, index) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      throw new WorkoutSegmentValidationError('Invalid phase');
    }
    const expectedKind = index % 2 === 0 ? 'work' : 'recovery';
    const repetition = Math.floor(index / 2) + 1;
    const phaseStart = requireInteger(phase.start_offset, 0, 'phase start');
    const phaseEnd = requireInteger(phase.end_offset, phaseStart, 'phase end');
    const phaseDuration = requireInteger(phase.duration, 1, 'phase duration');
    if (requireInteger(phase.position, 0, 'phase position') !== index
      || phase.phase_kind !== expectedKind
      || requireInteger(phase.repetition_index, 1, 'repetition index') !== repetition
      || phaseStart !== nextStart || phaseEnd > end || phaseDuration !== phaseEnd - phaseStart + 1) {
      throw new WorkoutSegmentValidationError('Phases must alternate work/recovery and cover the block in order without gaps or overlaps');
    }
    nextStart = phaseEnd + 1;
    return {
      position: index, phase_kind: expectedKind, repetition_index: repetition,
      start_offset: phaseStart, end_offset: phaseEnd, duration: phaseDuration,
      ...metricsOf(phase)
    };
  });
  if (nextStart !== end + 1) {
    throw new WorkoutSegmentValidationError('Phases must cover the entire block');
  }
  return normalized;
}

export function mergeWorkoutSegmentStructure(existing, changes) {
  const structureChanged = changes.structure_kind !== undefined && changes.structure_kind !== existing.structure_kind;
  const boundsChanged = Number(changes.start_offset ?? existing.start_offset) !== Number(existing.start_offset)
    || Number(changes.end_offset ?? existing.end_offset) !== Number(existing.end_offset);
  if (existing.structure_kind === 'microintervals' && boundsChanged
    && changes.phases === undefined && changes.structure_kind !== 'simple') {
    throw new WorkoutSegmentValidationError('Resizing a microinterval block requires updated phases', 409);
  }
  const merged = { ...existing, ...changes };
  if (structureChanged && changes.structure_kind === 'simple') {
    merged.phases = changes.phases ?? [];
    merged.pattern_work_duration_seconds = changes.pattern_work_duration_seconds ?? null;
    merged.pattern_recovery_duration_seconds = changes.pattern_recovery_duration_seconds ?? null;
  }
  return normalizeWorkoutSegmentStructure(merged);
}
