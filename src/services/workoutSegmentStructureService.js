import {
  mergeWorkoutSegmentStructure,
  normalizeWorkoutSegmentStructure,
  WorkoutSegmentValidationError
} from '../shared/WorkoutSegmentStructure.js';

const COLUMNS = [
  'start_offset', 'end_offset', 'segmenttype', 'duration', 'avg_power',
  'avg_heart_rate', 'avg_cadence', 'avg_speed', 'altimeters', 'position',
  'segmentname', 'structure_kind', 'pattern_work_duration_seconds', 'pattern_recovery_duration_seconds'
];
const RECORD_DEFINITION = `
  id BIGINT, start_offset INTEGER, end_offset INTEGER, segmenttype TEXT,
  duration INTEGER, avg_power DOUBLE PRECISION, avg_heart_rate DOUBLE PRECISION,
  avg_cadence DOUBLE PRECISION, avg_speed DOUBLE PRECISION, altimeters DOUBLE PRECISION,
  position INTEGER, segmentname TEXT, structure_kind TEXT,
  pattern_work_duration_seconds INTEGER, pattern_recovery_duration_seconds INTEGER
`;

function segmentId(value) {
  if (value == null || !/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new WorkoutSegmentValidationError('Invalid segment id');
  }
  return String(value);
}

export async function attachWorkoutSegmentPhases(queryable, rows) {
  const blocks = rows.filter((segment) => segment.structure_kind === 'microintervals');
  if (blocks.length === 0) return rows;
  const phases = await queryable.query(`
    SELECT * FROM workout_segment_phases
    WHERE segment_id = ANY($1::bigint[]) ORDER BY segment_id, position
  `, [blocks.map((segment) => segment.id)]);
  const byId = new Map(blocks.map((block) => [String(block.id), block]));
  for (const block of blocks) block.phases = [];
  for (const phase of phases.rows) byId.get(String(phase.segment_id))?.phases.push(phase);
  return rows;
}

// Import/archive path: caller already owns the transaction. Batch all blocks and
// all phases rather than issuing a write for every repetition or workout.
export async function insertWorkoutMicrointervalBlocks(queryable, uid, entries) {
  const blocks = entries.flatMap((entry) => entry.segments
    .filter((segment) => segment.structure_kind === 'microintervals')
    .map((segment, position) => ({ ...normalizeWorkoutSegmentStructure(segment),
      wid: entry.workoutId, position: segment.position ?? position, segmentname: segment.segmentname ?? '' })));
  if (!blocks.length) return { insertedCount: 0, statementCount: 0 };
  const result = await queryable.query(`
    INSERT INTO workout_segments (wid, uid, ${COLUMNS.join(', ')})
    SELECT u.wid, $2, ${COLUMNS.map((column) => `u.${column}`).join(', ')}
    FROM jsonb_to_recordset($1::jsonb) AS u(wid BIGINT, ${RECORD_DEFINITION})
    ON CONFLICT (wid, segmenttype, start_offset, duration) DO NOTHING RETURNING *
  `, [JSON.stringify(blocks.map((block) => ({ ...block, id: undefined, phases: undefined }))), uid]);
  const key = (block) => `${block.wid}:${block.start_offset}:${block.duration}:${block.segmenttype}`;
  const sources = new Map(blocks.map((block) => [key(block), block]));
  const phases = result.rows.flatMap((row) => sources.get(key(row)).phases.map((phase) => ({ ...phase, segment_id: row.id })));
  if (phases.length) await queryable.query(`
    INSERT INTO workout_segment_phases (segment_id, position, phase_kind, repetition_index,
      start_offset, end_offset, duration, avg_power, avg_heart_rate, avg_cadence, avg_speed, altimeters)
    SELECT segment_id, position, phase_kind, repetition_index, start_offset, end_offset,
      duration, avg_power, avg_heart_rate, avg_cadence, avg_speed, altimeters
    FROM jsonb_to_recordset($1::jsonb) AS u(segment_id BIGINT, position INTEGER,
      phase_kind TEXT, repetition_index INTEGER, start_offset INTEGER, end_offset INTEGER,
      duration INTEGER, avg_power DOUBLE PRECISION, avg_heart_rate DOUBLE PRECISION,
      avg_cadence DOUBLE PRECISION, avg_speed DOUBLE PRECISION, altimeters DOUBLE PRECISION)
  `, [JSON.stringify(phases)]);
  return { insertedCount: result.rows.length, statementCount: phases.length ? 2 : 1 };
}

// Uses a single connection/transaction for parents and phases. No stream decoding
// or pattern scanning happens on the server; phases arrive from the browser.
export async function saveWorkoutSegmentChanges(pool, uid, workoutId, segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 1000) {
    throw new WorkoutSegmentValidationError('Segments must contain 1–1000 items');
  }
  const changes = segments.filter((segment) => segment?.rowstate !== 'DB');
  const ids = [];
  for (const segment of changes) {
    if (!segment || !['CRE', 'UPD', 'DEL'].includes(segment.rowstate)) {
      throw new WorkoutSegmentValidationError('Invalid segment row state');
    }
    if (segment.rowstate !== 'CRE') ids.push(segmentId(segment.id));
  }
  if (new Set(ids).size !== ids.length) throw new WorkoutSegmentValidationError('Duplicate segment id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM workouts WHERE id = $1 AND uid = $2 FOR UPDATE', [workoutId, uid]);
    if (owner.rows.length === 0) throw new WorkoutSegmentValidationError('Workout not found', 404);
    const existing = ids.length ? (await client.query(`
      SELECT * FROM workout_segments
      WHERE id = ANY($1::bigint[]) AND wid = $2 AND uid = $3 FOR UPDATE
    `, [ids, workoutId, uid])).rows : [];
    if (existing.length !== ids.length) throw new WorkoutSegmentValidationError('Segment not found', 404);
    if (options.manualOnly && existing.some((segment) => segment.segmenttype !== 'manual')) {
      throw new WorkoutSegmentValidationError('Manual segment not found', 404);
    }
    await attachWorkoutSegmentPhases(client, existing);
    const byId = new Map(existing.map((segment) => [String(segment.id), segment]));
    const normalized = changes.filter((segment) => segment.rowstate !== 'DEL').map((segment, index) => {
      const old = byId.get(String(segment.id));
      const result = old ? mergeWorkoutSegmentStructure(old, segment) : normalizeWorkoutSegmentStructure(segment);
      if (options.manualOnly && result.segmenttype !== 'manual') {
        throw new WorkoutSegmentValidationError('Invalid manual segment type');
      }
      result.segmentname = result.segmentname ?? '';
      if (typeof result.segmentname !== 'string' || result.segmentname.length > 100) {
        throw new WorkoutSegmentValidationError('Segment name must be at most 100 characters');
      }
      result.position = result.position ?? index + 1;
      if (!Number.isInteger(result.position) || result.position < 0 || result.position > 2147483647) {
        throw new WorkoutSegmentValidationError('Invalid segment position');
      }
      result.replacePhases = !old || segment.phases !== undefined || old.structure_kind !== result.structure_kind;
      return result;
    });
    if (normalized.reduce((sum, segment) => sum + segment.phases.length, 0) > 50000) {
      throw new WorkoutSegmentValidationError('Too many segment phases');
    }
    const deletedIds = changes.filter((segment) => segment.rowstate === 'DEL').map((segment) => segment.id);
    if (deletedIds.length) await client.query(`
      DELETE FROM workout_segments WHERE id = ANY($1::bigint[]) AND wid = $2 AND uid = $3
    `, [deletedIds, workoutId, uid]);
    const created = normalized.filter((segment) => segment.rowstate === 'CRE');
    const updated = normalized.filter((segment) => segment.rowstate === 'UPD');
    // Client create ids can be UUIDs; never send them into a bigint record field.
    const payload = (rows) => JSON.stringify(rows.map((row) => Object.fromEntries(
      [...COLUMNS, ...(row.rowstate === 'UPD' ? ['id'] : [])].map((column) => [column, row[column]])
    )));
    const saved = [];
    if (created.length) {
      const result = await client.query(`
        INSERT INTO workout_segments (wid, uid, ${COLUMNS.join(', ')})
        SELECT $1, $2, ${COLUMNS.map((column) => `u.${column}`).join(', ')}
        FROM jsonb_to_recordset($3::jsonb) AS u(${RECORD_DEFINITION}) RETURNING *
      `, [workoutId, uid, payload(created)]);
      saved.push(...result.rows);
    }
    if (updated.length) {
      const result = await client.query(`
        UPDATE workout_segments AS ws SET ${COLUMNS.map((column) => `${column} = u.${column}`).join(', ')}
        FROM jsonb_to_recordset($3::jsonb) AS u(${RECORD_DEFINITION})
        WHERE ws.wid = $1 AND ws.uid = $2 AND ws.id = u.id RETURNING ws.*
      `, [workoutId, uid, payload(updated)]);
      saved.push(...result.rows);
    }
    // Do not depend on SQL RETURNING row order when assigning phases to creates.
    const key = (segment) => `${segment.start_offset}:${segment.duration}:${segment.segmenttype}`;
    const createdByKey = new Map(created.map((segment) => [key(segment), segment]));
    const updatedById = new Map(updated.map((segment) => [String(segment.id), segment]));
    const replaceIds = [];
    const phaseRows = [];
    for (const row of saved) {
      const source = updatedById.get(String(row.id)) || createdByKey.get(key(row));
      if (source.replacePhases) {
        replaceIds.push(row.id);
        for (const phase of source.phases) phaseRows.push({ ...phase, segment_id: row.id });
      }
    }
    if (replaceIds.length) await client.query('DELETE FROM workout_segment_phases WHERE segment_id = ANY($1::bigint[])', [replaceIds]);
    if (phaseRows.length) await client.query(`
      INSERT INTO workout_segment_phases (
        segment_id, position, phase_kind, repetition_index, start_offset, end_offset,
        duration, avg_power, avg_heart_rate, avg_cadence, avg_speed, altimeters
      )
      SELECT segment_id, position, phase_kind, repetition_index, start_offset, end_offset,
        duration, avg_power, avg_heart_rate, avg_cadence, avg_speed, altimeters
      FROM jsonb_to_recordset($1::jsonb) AS u(
        segment_id BIGINT, position INTEGER, phase_kind TEXT, repetition_index INTEGER,
        start_offset INTEGER, end_offset INTEGER, duration INTEGER,
        avg_power DOUBLE PRECISION, avg_heart_rate DOUBLE PRECISION, avg_cadence DOUBLE PRECISION,
        avg_speed DOUBLE PRECISION, altimeters DOUBLE PRECISION
      )
    `, [JSON.stringify(phaseRows)]);
    await attachWorkoutSegmentPhases(client, saved);
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      throw new WorkoutSegmentValidationError('A segment with these bounds and type already exists', 409);
    }
    throw error;
  } finally {
    client.release();
  }
}
