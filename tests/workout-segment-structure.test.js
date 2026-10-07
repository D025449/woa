import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWorkoutSegmentStructure, normalizeWorkoutSegmentStructure } from '../src/shared/WorkoutSegmentStructure.js';
import { saveWorkoutSegmentChanges } from '../src/services/workoutSegmentStructureService.js';

function block() {
  return {
    id: 12, rowstate: 'CRE', segmenttype: 'manual', structure_kind: 'microintervals',
    start_offset: 100, end_offset: 219, duration: 120, avg_power: 270,
    pattern_work_duration_seconds: 40, pattern_recovery_duration_seconds: 20,
    phases: [
      { position: 0, phase_kind: 'work', repetition_index: 1, start_offset: 100, end_offset: 139, duration: 40, avg_power: 370 },
      { position: 1, phase_kind: 'recovery', repetition_index: 1, start_offset: 140, end_offset: 159, duration: 20, avg_power: 70 },
      { position: 2, phase_kind: 'work', repetition_index: 2, start_offset: 160, end_offset: 199, duration: 40, avg_power: 370 },
      { position: 3, phase_kind: 'recovery', repetition_index: 2, start_offset: 200, end_offset: 219, duration: 20, avg_power: 70 }
    ]
  };
}

test('accepts actual phases independently of the nominal pattern and optional last recovery', () => {
  const segment = block();
  segment.phases[0].end_offset += 2;
  segment.phases[0].duration += 2;
  segment.phases[1].start_offset += 2;
  segment.phases[1].duration -= 2;
  const actual = normalizeWorkoutSegmentStructure(segment);
  assert.equal(actual.pattern_work_duration_seconds, 40);
  assert.equal(actual.phases[0].duration, 42);
  segment.phases.pop();
  segment.end_offset = 199;
  segment.duration = 100;
  assert.equal(normalizeWorkoutSegmentStructure(segment).phases.length, 3);
});

test('rejects gaps, overlaps, invalid ordering, incomplete coverage, and invalid metrics', () => {
  const mutations = [
    (s) => { s.phases[1].start_offset++; },
    (s) => { s.phases[0].end_offset++; },
    (s) => { s.phases[1].phase_kind = 'work'; },
    (s) => { s.phases[2].repetition_index = 4; },
    (s) => { s.phases[1].position = 0; },
    (s) => { s.phases.pop(); },
    (s) => { s.phases[0].avg_power = Infinity; },
    (s) => { s.phases[0].avg_cadence = -5; },
    (s) => { s.phases[0].duration = true; },
    (s) => { s.duration--; },
    (s) => { s.pattern_recovery_duration_seconds = null; },
    (s) => { s.segmenttype = 'crit'; }
  ];
  for (const mutate of mutations) {
    const segment = block();
    mutate(segment);
    assert.throws(() => normalizeWorkoutSegmentStructure(segment), { status: 400 });
  }
});

test('simple legacy segments retain their duration convention but cannot hide phases', () => {
  const segment = { start_offset: 100, end_offset: 200, duration: 100, avg_power: 210 };
  assert.equal(normalizeWorkoutSegmentStructure(segment).duration, 100);
  assert.throws(() => normalizeWorkoutSegmentStructure({ ...segment, phases: block().phases }), { status: 400 });
});

test('name-only updates preserve structure; resizing requires matching phases; conversion clears it', () => {
  const existing = block();
  const renamed = mergeWorkoutSegmentStructure(existing, { segmentname: '40/20' });
  assert.equal(renamed.phases.length, 4);
  assert.equal(renamed.pattern_work_duration_seconds, 40);
  assert.throws(() => mergeWorkoutSegmentStructure(existing, { end_offset: 220 }), { status: 409 });
  const simple = mergeWorkoutSegmentStructure(existing, { structure_kind: 'simple' });
  assert.deepEqual(simple.phases, []);
  assert.equal(simple.pattern_work_duration_seconds, null);
});

function database({ owned = true, failPhases = false, existing = [] } = {}) {
  const calls = [];
  let savedRows = [];
  let phaseRows = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM workouts')) return { rows: owned ? [{ id: 85063 }] : [] };
      if (sql.includes('SELECT * FROM workout_segments')) return { rows: existing.map((row) => ({ ...row })) };
      if (sql.includes('SELECT * FROM workout_segment_phases')) {
        return { rows: phaseRows.length ? phaseRows : existing.flatMap((row) => (row.phases || []).map((phase) => ({ ...phase, segment_id: row.id }))) };
      }
      if (sql.includes('INSERT INTO workout_segments')) {
        // Reverse RETURNING order to exercise phase-to-parent mapping.
        savedRows = JSON.parse(values[2]).map((row, index) => ({ ...row, id: 100 + index })).reverse();
        return { rows: savedRows };
      }
      if (sql.includes('UPDATE workout_segments AS ws')) {
        savedRows = JSON.parse(values[2]);
        return { rows: savedRows };
      }
      if (sql.includes('INSERT INTO workout_segment_phases')) {
        if (failPhases) throw new Error('phase write failed');
        phaseRows = JSON.parse(values[0]);
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test('saves independent blocks and their correctly assigned phases in one transaction', async () => {
  const db = database();
  const first = block();
  first.id = 'browser-uuid';
  const second = block();
  second.start_offset += 300;
  second.end_offset += 300;
  second.phases = second.phases.map((phase) => ({ ...phase, start_offset: phase.start_offset + 300, end_offset: phase.end_offset + 300 }));
  const rows = await saveWorkoutSegmentChanges(db.pool, 49, 85063, [first, second]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.phases[0].start_offset, row.start_offset);
    assert.equal(row.phases[0].segment_id, row.id);
  }
  assert.equal(db.calls[0].sql, 'BEGIN');
  assert.equal(db.calls.at(-2).sql, 'COMMIT');
  assert.equal(db.calls.at(-1).sql, 'RELEASE');
});

test('rolls back parent writes when saving phases fails', async () => {
  const db = database({ failPhases: true });
  await assert.rejects(saveWorkoutSegmentChanges(db.pool, 49, 85063, [block()]), /phase write failed/u);
  assert.equal(db.calls.at(-2).sql, 'ROLLBACK');
  assert.ok(!db.calls.some((call) => call.sql === 'COMMIT'));
});

test('does not write segments for a workout belonging to another owner', async () => {
  const db = database({ owned: false });
  await assert.rejects(saveWorkoutSegmentChanges(db.pool, 50, 85063, [block()]), { status: 404 });
  assert.ok(!db.calls.some((call) => call.sql.includes('INSERT INTO')));
});

test('rename avoids replacing phases, and deletion is scoped by workout and owner', async () => {
  const current = { ...block(), rowstate: 'DB' };
  const db = database({ existing: [current] });
  const rows = await saveWorkoutSegmentChanges(db.pool, 49, 85063, [{ id: 12, rowstate: 'UPD', segmentname: 'Renamed' }]);
  assert.equal(rows[0].phases.length, 4);
  assert.ok(!db.calls.some((call) => call.sql.includes('DELETE FROM workout_segment_phases')));
  const deletion = database({ existing: [current] });
  await saveWorkoutSegmentChanges(deletion.pool, 49, 85063, [{ id: 12, rowstate: 'DEL' }]);
  const call = deletion.calls.find((item) => item.sql.includes('DELETE FROM workout_segments'));
  assert.match(call.sql, /wid = \$2 AND uid = \$3/u);
  assert.deepEqual(call.values, [[12], 85063, 49]);
});
