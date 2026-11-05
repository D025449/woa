# Workout Microinterval and Interval Blocks

Migration: `src/migrations/087_workout_segment_microintervals.sql`.
Longer interval blocks additionally require
`src/migrations/094_workout_interval_blocks.sql`. Execute migrations manually;
the application changes do not execute them or backfill existing workouts.

## Persistence API

`POST /files/workouts/:id/segments` accepts the existing `{ segments: [...] }`
envelope (or `{ segment: ... }`). `rowstate` selects `CRE`, `UPD`, or `DEL`.
All changes in a request are saved in one transaction. The workout and existing
segments must belong to the caller. The response contains saved parents with
their ordered `phases`; deleted parents are not included.

The segment GET endpoint and workout-open payload include the same structure.
Ordinary segments remain `structure_kind: "simple"` and do not require phases.
No power stream is decoded or scanned by the persistence API.

A minimal one-repetition block, including its last recovery::

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

Detection requires at least five repetitions with consistent work and recovery
durations. Only the final work phase may extend to 2.1 times the regular work
duration (approximately double, allowing small measured timing deviations),
subject to the existing 90-second work-phase limit. A prolonged finishing effort
ends the block; its actual duration is retained and its final recovery follows
the established recovery duration. Earlier work phases and all internal recovery
phases must still satisfy the regular pattern tolerances.

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

## Longer Interval Blocks

Longer intervals use `structure_kind: "intervals"`, separately from
`"microintervals"`. Both kinds share the same parent/phase persistence contract,
inclusive second offsets, validation, editor, phase metrics and manual-edit
protection. Existing simple segments and microinterval detection are unchanged.

`IntervalBlockDetector` recognizes at least three repeated efforts lasting about
one minute or longer, without hard-coding a work duration or repetition count.
Work and internal recovery durations must each stay within approximately 5% of
their respective local median, plus one second for sampled edge resolution.
Recoveries must last at least 15 seconds. A longer set break or incompatible
duration pattern ends a block; a subsequent block may have a different duration
or repetition count. The last work phase ends the detected block: cooldown or a
long set break is not silently appended as a final recovery.

Detection uses centered power smoothing, hysteresis, several histogram-derived
contrast levels and short-dip tolerance. Missing power breaks a pattern; steady
rides, insufficient contrast and irregular timing are rejected. Nominal labels
are rounded only within the timing tolerance; actual measured phase durations
remain unchanged. This is morphological detection, not a physiological intensity
classification or a guarantee that every outdoor training pattern is recognized.

The existing compact FIT import workers call the same shared detector. Detected
microinterval ranges take priority, avoiding duplicate long blocks over the same
short protocol. The chart menu also provides **Detect interval blocks**, using
the existing cached module worker. Opening a workout never starts a scan. The
editor can scan just a selected range, adjust individual phases and save an
automatic block as manual. Repeated scans replace only automatic blocks of the
requested kind and skip manual structured ranges. Interval blocks have their own
color, visibility toggle, minute-based labels and preserved view preferences.

The read-only development check of workout 85064 recognized **3 x 4 min / 3 min**:
work phases at offsets 952, 1375 and 1796 last 238, 235 and 234 seconds, averaging
312, 310 and 307 W. The two measured recoveries last 185 and 186 seconds. No
detected block was written to that workout during verification. Apply migration
094 manually before using the saving/import path with the new block kind.

## Transport and archives

WPP1 version 3 appends a length-prefixed JSON structure extension to the existing
compact segment columns. Payloads without structured blocks remain version 2, and
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

The structure extension now includes the optional `structure_kind` field for
both block kinds. Legacy version-3 extensions without that field remain
microintervals; unknown extension kinds are rejected. Payloads without either
structured block kind remain version 2. Admin/native backups and FIT phase-lap
export retain longer interval phases through the existing common paths. FIT
alone still does not preserve the application-specific parent hierarchy.

## Interval Block Verification

- Earlier full-suite verification passed 742 tests, including flexible 1/2/4/8-minute
  efforts, independent 3/4-repetition sets, 5% duration variation, irregular
  pauses, brief dips, missing samples, selected ranges, manual scan protection,
  WPP import, phase persistence/rename/resize, backup, visibility and phase areas.
- At that verification, syntax and targeted ESLint passed with 15 existing warnings.
  Type checking reported three nullable `lastEnd` errors, subsequently fixed below.
- A browser preview exercised the actual module worker, extracted unchanged
  controller scan method, editor and simulated segment API. It detected separate
  3/4-repetition sets, saved a manual phase correction and retained block kind.
  Desktop and 390-pixel mobile editor screenshots and dimensions were checked;
  the shared editor now sizes itself independently of global CSS resets and
  avoids overlapping mobile field labels.
- This was not an authenticated application/database write test. The complete
  dashboard controller could not be imported in the static preview because it
  does not serve the application's vendor URL. Migration 094 was prepared only;
  no migration, backfill, real segment save, deployment or restart was performed.

## Detector Type-Check Fix (2026-11-05)

The brief-dip merge condition now snapshots the closure-mutated `lastEnd` in
`const previousEnd` before its null guard and arithmetic. Detection thresholds,
missing-sample boundaries and runtime decisions are unchanged. The full
`npm run check:types` passes without errors; all 23 tests in
`tests/microinterval-detector.test.js`, detector syntax, targeted ESLint and editor
diagnostics pass. The full test suite was not rerun for this type-only fix.
No migration, database write, deployment or restart was performed.
