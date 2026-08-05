# PostgreSQL backup recovery tools

These tools are deliberately isolated from the application source tree. They
do not import application modules and do not require the application, PM2,
Redis, or the web server to be running.

## Create a backup

Direct recovery-safe invocation:

```bash
NODE_ENV=production node ops/postgres-backup/create-backup.mjs
```

Convenience wrapper:

```bash
NODE_ENV=production npm run backup:create
```

An explicit environment file can always be supplied:

```bash
node ops/postgres-backup/create-backup.mjs \
  --env-file /etc/cwa24/backup.env \
  --label before-migration
```

The tool creates a PostgreSQL custom-format dump in a temporary directory,
validates it with `pg_restore --list`, calculates a SHA-256 checksum, uploads
the dump to S3, and uploads `manifest.json` last. A backup is complete only
when the manifest exists.

## Verify a backup

Use the prefix printed by the create command:

```bash
node ops/postgres-backup/verify-backup.mjs \
  --env-file /etc/cwa24/backup.env \
  --backup-prefix backups/postgres/production/cwa24_prod/2026/08/05/<backup-id>
```

The verifier downloads the manifest and archive, verifies size and SHA-256,
and validates the PostgreSQL archive catalog. It never writes to a database.

## Production installation

Copy this directory to `/opt/cwa24-recovery` and store the independent config
at `/etc/cwa24/backup.env` with mode `0600`. The scripts may then be executed
directly from `/opt/cwa24-recovery`, independently of an application release.
