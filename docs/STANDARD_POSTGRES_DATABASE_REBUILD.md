# Standard PostgreSQL database rebuild

The application uses PostgreSQL's built-in `box` type and GiST indexes. It does
not require PostGIS.

## Complete rebuild

The rebuild intentionally removes all application data, including users,
workouts, segments, plans, and import history. Stop the server and all workers
before running it.

The exact target database name must be supplied as a safety confirmation:

```bash
NODE_ENV=production npm run db:rebuild -- --confirm <DB_NAME>
```

The command performs these steps:

1. Removes installed PostGIS-related extensions with `CASCADE`, including old
   geometry columns that depend on them.
2. Drops the complete `public` schema with all contained objects.
3. Creates a fresh `public` schema.
4. Replays all scratch migrations.

The resulting schema stores:

- workout and segment bounds as native PostgreSQL `box` values;
- workout start and end coordinates as `double precision` values;
- workout and segment tracks as binary blobs;
- bounds indexes as native GiST indexes.

After the rebuild, restart the application, register the initial user, and
upload the source workouts again.
