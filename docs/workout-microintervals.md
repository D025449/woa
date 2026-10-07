# Workout microinterval blocks

Migration: `src/migrations/087_workout_segment_microintervals.sql`.

## Persistence API

`POST /files/workouts/:id/segments` accepts the existing `{ segments: [...] }`
envelope (or `{ segment: ... }`). `rowstate` selects `CRE`, `UPD`, or `DEL`.
All changes in a request are saved in one transaction. The workout and existing
segments must belong to the caller. The response contains saved parents with
their ordered `phases`; deleted parents are not included.

The segment GET endpoint and workout-open payload include the same structure.
Ordinary segments remain `structure_kind: "simple"` and do not require phases.
No power stream is decoded or scanned by the persistence API.

A minimal one-repetition block, including its last recovery:

```json
{
  "segments": [{
    "rowstate": "CRE",
    "segmenttype": "manual",
    "structure_kind": "microintervals",
    "segmentname": "40/20",
    "start_offset": 100,
    "end_offset": 159,
    "duration": 60,
    "avg_power": 270,
    "pattern_work_duration_seconds": 40,
    "pattern_recovery_duration_seconds": 20,
    "phases": [
      {
        "position": 0, "phase_kind": "work", "repetition_index": 1,
        "start_offset": 100, "end_offset": 139, "duration": 40,
        "avg_power": 370
      },
      {
        "position": 1, "phase_kind": "recovery", "repetition_index": 1,
        "start_offset": 140, "end_offset": 159, "duration": 20,
        "avg_power": 70
      }
    ]
  }]
}
```

Microinterval offsets are inclusive seconds from workout start. Block and phase
durations equal `end_offset - start_offset + 1`. Existing simple segments keep
their legacy duration conventions. Metrics use existing segment units: watts,
bpm, rpm, km/h, and signed elevation difference in millimeters. Missing phase
metrics can be null. Nominal work/recovery durations are optional as a pair;
actual phase durations can differ from the nominal pattern.

## Updates and validation

- Phases must start with work, alternate work/recovery, and cover their block
  without gaps or overlaps. Positions are zero-based; repetitions are one-based.
- The last recovery is optional. Blocks have no relationship to each other.
- Name-only `UPD` requests preserve phases and pattern metadata. Changing block
  bounds requires a complete matching phase list; otherwise the API returns 409.
- Converting to `structure_kind: "simple"` clears phases and nominal durations.
- Deleting a parent removes its phases through the database foreign key.
- Invalid structures return 400, unavailable workouts/segments return 404, and
  duplicate segment bounds/type return 409. A failed write rolls back the request.
- `PATCH /files/workouts/:id/segments/:segmentId` also accepts structure and phase
  fields for owned manual segments. Supply the complete range and metrics there.

## Browser detection, editor and display

The dashboard chart menu offers **Detect microintervals** and **Create microinterval
block**. Import uses the existing FIT workers and already decoded compact arrays.
An existing workout is scanned only on request in a dedicated module worker;
opening or rendering it never starts a scan. The worker caches one cloned workout
buffer until the workout changes. Scan complexity is linear in sample count,
using a fixed-size 120-second rolling histogram and short run grouping.

Microintervals have a separate visibility toggle so hiding ordinary automatic
lap segments does not hide structured blocks. Selecting a block shows its phases
on the time or distance axis. The card has phase details and duration-weighted
work power. Actual detected phase durations may differ from the nominal label.

The editor supports simple and structured segments, pattern entry, detection in
just the selected range, shifting the start, optional last recovery and individual
phase duration corrections. Preview never stretches phases to match the selected
range; it reports any difference. Editing an automatic block saves it as manual,
which protects it from subsequent automatic scans.

Repeated detection replaces automatic blocks and skips ranges covered by manual
microinterval blocks. Import reprocessing keeps existing manual segments. Pattern
results are reused by import intensity classification when available; morphology
alone does not assign a physiological intensity.

## Transport and archives

WPP1 version 3 appends a length-prefixed JSON structure extension to the existing
compact segment columns. Payloads without microintervals remain version 2, and
both versions are accepted. Only recognized blocks/phases are transmitted; raw
power samples are not added to the transport. Parents and phases are inserted
in batches within the existing import transaction.

Admin and logical backups retain the exact parent structure and phases, including
manual corrections. Older archives without structure fields restore as simple
segments. FIT export represents each work/recovery phase as an equipment lap with
its intensity. FIT alone does not retain the app-specific parent name or hierarchy;
on ordinary FIT reimport, the browser detector reconstructs regular blocks from
power data. Native backups (including FIT backups with their metadata sidecar)
preserve the exact hierarchy instead of relying on redetection.
