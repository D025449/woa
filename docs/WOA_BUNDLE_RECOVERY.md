# WOA bundle recovery

The standard `/api/uploads/woa-bundle` endpoint supports an optional recoverable mode.
The browser always supplies an `uploadId`; recovery is controlled by the server and worker.

## Configuration

Set the same environment on the web process and the import worker:

```env
WOA_BUNDLE_RECOVERY_ENABLED=1
WOA_BUNDLE_RECOVERY_ATTEMPTS=3
WOA_BUNDLE_RECOVERY_SWEEP_MS=60000
WOA_BUNDLE_RECOVERY_RETENTION_HOURS=24
```

With `WOA_BUNDLE_RECOVERY_ENABLED=0` or unset, the endpoint follows the previous fast path
without bundle metadata writes or transactional workout overwrite batches.

## Safe-mode phases

1. `received`: Multer has stored and the server has validated all three compressed files.
2. `workouts_completed`: all workout batches have been persisted.
3. `wpp_completed`: workout-local segments have been replaced transactionally.
4. `gbe_completed`: GPS segment best efforts have been replaced transactionally.
5. `completed`: recovery files can be removed.

Workout overwrite uses one transaction per configured workout batch. The complete bundle does
not use one large database transaction. A retry resumes at the latest persisted phase, while a
phase whose commit raced with a process crash can safely be repeated.

The import worker scans stale or failed bundles and submits `woa-bundle-recovery` jobs to the
existing `fit-imports` BullMQ queue. Completed and permanently failed metadata is removed after
the configured retention period.

## Measurement

The `[import] woa-bundle.profile` log includes:

- `recoveryEnabled`
- `safeSetupMs`
- `checkpointMs`
- `recoveryOverheadMs`
- the existing phase and total timings

Compare identical uploads with recovery disabled and enabled. The upload payload and browser
processing are unchanged.
