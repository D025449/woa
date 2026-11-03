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