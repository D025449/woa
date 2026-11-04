# Workout Import Deduplication

## Rule

Migration `093_workout_time_exclusion.sql` adds the immediate PostgreSQL exclusion
constraint `workouts_no_time_overlap`. For the same `uid`, any positive overlap
between valid `[start_time, end_time)` ranges is rejected. This is deliberately
stricter than a percentage-based duplicate check. Adjacent workouts are allowed;
different users are independent. Elapsed wall-clock time, including recording
pauses, determines the range, not `total_timer_time`.

The constraint creates its own GiST index and uses `btree_gist` for BIGINT user
equality. No additional application-level advisory lock or matching index is
needed. PostgreSQL handles concurrent inserts and updates. The existing
`UNIQUE (uid, start_time)` remains in place.

Rows with missing bounds or `end_time <= start_time` are intentionally excluded
from this constraint. The start-time unique constraint still applies, subject to
its existing NULL semantics. This change does not repair or prohibit invalid
time ranges. Check and resolve them separately before relying on full coverage.

## End-Time Fallback And Manual Repair

Both WOA1 encoders now resolve each session's end independently. A finite
session `timestamp` after its start remains authoritative. If it is missing,
invalid or not after the start, a finite positive `total_elapsed_time` supplies
`start_time + total_elapsed_time`. The workout ends at the latest resolved
session end, not at the first start plus the sum of durations across sessions.
This uses elapsed wall time, never timer time. No duration is invented when a
usable elapsed value is absent. Existing WOA bundles are not rewritten.

Read-only inspection of local `cwa24_dev` on 2026-11-04 found 3,908 workouts with
equal start/end timestamps, all with positive elapsed and timer durations; no
start/end values were NULL or reversed. Six decoded streams independently
confirmed longer recordings. Some stream axes omit pauses and cannot safely
replace wall-clock end times. The encoders previously trusted the session
timestamp without this duration fallback; the original FIT session values of
these historical rows were not verified.

Prepared migration `src/migrations/095_workout_end_time_repair.sql` repairs only
NULL/non-increasing ends with a known start and positive finite elapsed duration.
It leaves already increasing ends untouched. It does not change duration,
streams, IDs or constraints, and does not delete workouts. Before the UPDATE it
checks proposed ranges against both unchanged workouts and other repair
candidates of the same user. Any positive overlap aborts the whole transaction,
even if the exclusion constraint has not yet been installed. Adjacent ranges
remain allowed. A write-blocking table lock protects this check from concurrent
changes; reads remain available. Lock timeout is five seconds and statement
timeout is five minutes.

Before execution, back up the intended database, deploy the import fix, pause
imports/writes, and run this read-only audit. Empty output means no proposed
overlaps, not that the repair has been applied:

```sql
WITH repairs AS (
  SELECT id, start_time + make_interval(secs => total_elapsed_time) AS repaired_end_time
  FROM public.workouts
  WHERE start_time IS NOT NULL
    AND (end_time IS NULL OR end_time <= start_time)
    AND total_elapsed_time > 0
    AND total_elapsed_time < 'Infinity'::double precision
), effective AS (
  SELECT w.id, w.uid, w.start_time,
         COALESCE(r.repaired_end_time, w.end_time) AS proposed_end_time,
         r.id IS NOT NULL AS will_repair
  FROM public.workouts w
  LEFT JOIN repairs r ON r.id = w.id
)
SELECT a.uid, a.id AS workout_a, b.id AS workout_b,
       a.start_time AS start_a, a.proposed_end_time AS end_a,
       b.start_time AS start_b, b.proposed_end_time AS end_b
FROM effective a
JOIN effective b ON b.uid = a.uid AND b.id > a.id
WHERE (a.will_repair OR b.will_repair)
  AND a.proposed_end_time > a.start_time
  AND b.proposed_end_time > b.start_time
  AND a.start_time < b.proposed_end_time
  AND b.start_time < a.proposed_end_time
ORDER BY a.uid, a.id, b.id;
```

The Dev SELECT-only preflight found 3,908 candidates and zero conflicting pairs.
This says nothing about another database. Only the operator may manually execute
the prepared migration, with stop-on-error enabled. On failure, roll back the
open transaction and investigate; do not disable the exclusion constraint or
automatically delete recordings. After success, rerun the invalid-range query
below and verify representative end times against elapsed duration. The repair
is repeatable: repaired increasing ranges no longer qualify. No migration or
application-data repair was executed by the assistant. After the user reported
manual execution, SELECT-only Dev verification found 6,142 valid ranges, zero
invalid ranges and zero remaining candidates; the six samples matched elapsed
duration exactly and the exclusion constraint remained validated. This does not
verify migration execution on another database or deployment of the import fix.
The migration itself does not update benchmark copies; the separately authorized
refresh is recorded below.

## Manual Rollout

Only the operator executes migration SQL. Do not replay the full migration set
against an existing database; early migrations contain destructive statements.

1. Review the existing overlaps and invalid ranges with the read-only queries
   below. Decide which recordings to retain using the normal deletion workflow;
   there is no automatic deletion or device-priority rule.
2. Deploy the application-side conflict handling before activating the constraint.
   It remains compatible with the existing schema, but shifted duplicates are not
   prevented until the migration is applied.
3. Schedule a maintenance window and pause imports/writes. Adding the constraint
   scans existing rows and takes a strong table lock; it is not a concurrent
   index build. Large tables can also block reads during this operation.
4. Manually execute only `src/migrations/093_workout_time_exclusion.sql` against
   the intended database with stop-on-error enabled in the SQL client. The role
   needs permission to install `btree_gist` and alter the table. On failure, roll
   back any open transaction before retrying.
5. If any existing overlap remains, constraint creation fails and the transaction
   is rolled back. No workout rows are changed by the migration. Resume writes
   only after confirming the constraint exists and completing manual checks.

Missing or invalid bounds:

```sql
SELECT id, uid, start_time, end_time
FROM workouts
WHERE start_time IS NULL
   OR end_time IS NULL
   OR end_time <= start_time
ORDER BY uid, start_time;
```

Existing overlapping pairs with valid bounds:

```sql
SELECT
  a.uid,
  a.id AS workout_a,
  b.id AS workout_b,
  a.start_time AS start_a,
  a.end_time AS end_a,
  b.start_time AS start_b,
  b.end_time AS end_b
FROM workouts a
JOIN workouts b ON b.uid = a.uid AND b.id > a.id
WHERE a.end_time > a.start_time
  AND b.end_time > b.start_time
  AND a.start_time < b.end_time
  AND b.start_time < a.end_time
ORDER BY a.uid, a.start_time, b.start_time;
```

This self-join is a pre-migration audit, not the indexed import path. It may be
expensive on large histories; restrict both aliases to one `uid` when necessary.

After the manual migration, inspect the installed constraint:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'workouts'::regclass
  AND conname = 'workouts_no_time_overlap';
```

Manually verify a shifted duplicate, adjacent workouts, independent users, mixed
bulk imports and concurrent imports. No database migration or live constraint
test has been performed by the coding agent. Database performance is not measured.

## Import Behavior

- Both common workout inserts use untargeted `ON CONFLICT DO NOTHING`, covering
  the existing unique constraint and the new immediate exclusion constraint.
  Other database errors are not suppressed. Single-workout insertion keeps its
  existing duplicate-error behavior when no row is returned.
- Bulk entries without an inserted or exact-start existing row are marked
  `workout_time_conflict` and skipped. They are never mapped to a differently
  timed existing workout, so their segments and GPS matches cannot overwrite it.
  Unrelated entries in the bulk remain eligible for import.
- WPP1 and GBE1 bundle postprocessing omit these skipped start times and recount
  their payloads. Recovery checkpoints permit explicit time-conflict skips, while
  other skipped entries still fail the safe-mode workout phase.
- Automatic Wahoo imports treat persistence-time overlaps as `skipped`, including
  races after their early exact-start check. Ordinary conversion, database and
  postprocessing failures retain the existing retry behavior.
- Exact-start reimports retain their existing resolution/postprocessing behavior.
  The overwrite option deletes only exact-start matches, never all overlapping
  recordings. Every overwrite batch is transactional, regardless of recovery
  mode. If any deleted workout cannot be replaced, the entire batch rolls back,
  preserving that batch's existing workouts and dependent data. Other batches
  already committed are unaffected.
- Other write paths, including administrative restores, are also subject to the
  database constraint; they do not automatically gain the common import skip
  behavior and can fail on overlapping historical data.

Focused regression tests are in `tests/workout-time-conflicts.test.js` and
`tests/wahoo-webhook.test.js`. They use mocked database access; migration checks
are structural only, not a substitute for the operator's live verification.

## Prepared Development Benchmark

On 2026-11-04, the user explicitly authorized preparing an isolated test schema
in the existing local `cwa24_dev` database. This was benchmark setup, not an
application migration. No migration file, extension installation or modification
of `public.workouts` was executed.

- `benchmark.workouts_unique` contains the existing primary key, start-time
  uniqueness, checks and other indexes, without the time-exclusion constraint.
- `benchmark.workouts_exclusion` contains the same baseline plus the existing
  GiST time-exclusion constraint. The tables have eight and nine indexes;
  their common index definitions were compared and match.
- Both were cloned with `LIKE public.workouts INCLUDING ALL`, then populated
  from the same repeatable-read source snapshot, including stream/GPS blobs.
  The copied exclusion was removed only from the new baseline table. Existing
  schemas are never silently overwritten. Foreign keys and triggers are not
  copied by this mechanism: this isolates constraint/index costs, rather than
  reproducing every application side effect.
- At creation, each table had 6,142 rows and approximately 79 MB of total storage.
  Whole-row fingerprints matched each other and the source snapshot. Initially
  only 2,234 rows had valid ranges; the other 3,908 had equal start/end timestamps
  despite positive elapsed durations and were outside the exclusion index. This
  distribution was superseded by the authorized refresh below.
- Each table owns its own identity sequence under `benchmark`; their sequence
  positions were initialized after copying IDs. The application sequence was
  verified unchanged. `ANALYZE` was run on both tables.
- Functional probes accepted a new non-overlapping interval in both tables.
  A one-second-shifted overlap was accepted by the baseline and rejected with
  `23P01` by the exclusion variant. All probe rows were rolled back; both tables
  still contain 6,142 rows. These checks are not performance measurements.

After the user manually repaired the application data on 2026-11-04, a separately
authorized transaction synchronized only the 3,908 changed end times in each
benchmark table from one repeatable-read source snapshot. Each now has 6,142
valid ranges with full-row fingerprints identical to the source and the other
copy. `ANALYZE` was rerun on both. All index and constraint definitions, both
benchmark identity sequences, the application snapshot and the application
sequence were verified unchanged by this refresh. This was not a replay of the
application migration. Account for UPDATE-generated dead tuples and cache state
when preparing future timing runs; this refresh alone is not a measured benchmark.

Future benchmark writes must target only these schema-qualified test tables.
The existing `db:explain-workout-insert` script still targets the application
table and shifts times by milliseconds; do not use it unchanged for this test.
The first local measurements are recorded below. Benchmark traffic still shares
CPU, memory, I/O and WAL with Dev.
Removing `benchmark` must be a separate explicit cleanup action, never an
automatic step that could discard another session's test work.

## Local A/B Measurements (2026-11-04)

Environment: local PostgreSQL 16.14 Homebrew, ARM64 macOS, `shared_buffers=128MB`,
`fsync=on`, `synchronous_commit=on`. Both tables started with 6,142 valid ranges.
This was an ad hoc Node/pg measurement, not a new npm command or deployed runner.
Eight source workout IDs were 57947, 82834, 82398, 60402, 57510, 60003, 59154 and
84368, selected at the lower boundaries of eight payload-size buckets. Combined
stream/GPS payload sizes were 233, 5,688, 7,925, 9,415, 10,896, 12,866, 14,956 and
17,061 bytes. This is a fixed small sample, not the complete size distribution
or a largest-file stress test.

Every INSERT copied all source columns using server-side `INSERT SELECT`, with
explicit negative IDs, controlled user/time substitutions and targetless
`ON CONFLICT DO NOTHING RETURNING id`. New ranges were beyond the entire source
history and disjoint; overlap probes shifted original timestamps by one second.
Ten-row batches used the same selected payload ten times with disjoint ranges.
Each serial statement used its own transaction and was rolled back. There were
16 warmups followed by 128 measured statements per scenario/variant, cycling the
eight sources and reversing variant order every eight pairs. `EXPLAIN (ANALYZE,
BUFFERS, WAL, FORMAT JSON)` supplied execution time (excluding planning), buffers
and WAL. Percentiles use the nearest-rank definition. Only benchmark relations
were vacuumed/analyzed before testing, between scenarios, between concurrent
rounds and after the last round; physical file/cache state is not identical.

| Scenario | Baseline p50/p95 (ms) | Exclusion p50/p95 (ms) | Result |
| --- | --- | --- | --- |
| New single insert | 0.136 / 0.208 | 0.155 / 0.245 | One row inserted in each; p50 +0.019 ms (+14%) |
| Exact-start duplicate | 0.059 / 0.072 | 0.060 / 0.074 | Both skip |
| One-second-shifted overlap | 0.148 / 0.214 | 0.074 / 0.088 | Baseline inserts; exclusion skips, so not equivalent work |
| Ten-row batch | 0.652 / 1.107 | 0.948 / 1.509 | Ten rows inserted in each; p50 +0.296 ms (+45%) |

Mean WAL bytes per statement, baseline/exclusion: new insert 13,184/13,564;
exact duplicate 0/0; shifted overlap 11,920/0; ten-row batch 121,123/123,127.
These are EXPLAIN node WAL counts, not WAL-directory growth or durable commit
costs. Mean shared-buffer hits were 52.3/58.6 for new inserts and 500.4/574.3 for
batches. Across 128 statements, shared reads were 31/9 and 127/19 respectively;
neither storage nor cache differences were eliminated by this warm-cache test.

Parallel runs used four preconnected clients, eight warmups then 64 measured
statements per client, four rounds per variant/workload (1,024 measured inserts).
Each client kept one transaction open for its round and rolled it back afterwards.
Variant order alternated by round. All ranges were disjoint, including across
clients; one-user and two-user tests do not measure simultaneous overlap races
or waiting for another transaction to commit. Throughput excludes warmups,
BEGIN/ROLLBACK and connection establishment, but includes query round trips.

| Parallel workload | Baseline client p50/p95 (ms) | Exclusion client p50/p95 (ms) |
| --- | --- | --- |
| Same user, disjoint ranges | 0.408 / 1.253 | 0.459 / 1.662 |
| Two users, disjoint ranges | 0.378 / 0.917 | 0.414 / 1.414 |

Round throughput (inserts/s, chronological within each variant) was:

- Same user, baseline: 7,135; 9,542; 9,797; 4,977.
- Same user, exclusion: 4,636; 8,059; 3,599; 9,115.
- Two users, baseline: 9,705; 10,211; 10,014; 6,130.
- Two users, exclusion: 8,900; 9,053; 3,815; 9,374.

The large round-to-round variation rules out a precise throughput regression
claim from this run. Production hardware, sustained load, larger histories,
overlap races and durable commits remain unmeasured. FIT decoding, compression,
payload upload, application queries, foreign keys and triggers are also outside
this isolated server-side test.

After cleanup, total physical sizes were 90,791,936 baseline and 91,611,136
exclusion bytes; summed index sizes were 3,850,240 and 4,636,672 bytes. The GiST
exclusion index itself occupied 729,088 bytes. Relation growth from rolled-back
inserts can persist after ordinary VACUUM; do not attribute every byte of the
total-size difference to the new index.

Final verification matched full-row fingerprints across all three tables, each
at 6,142 rows (`f6e2ce77b8476f6eb4d5ae22b46e39b0`). Application and both benchmark
identity sequences, plus benchmark index/constraint definitions, were unchanged.
All probe rows were rolled back. Only benchmark physical storage/statistics and
shared database WAL/cache state changed; no application migration was executed.