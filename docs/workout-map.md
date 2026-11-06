# Workout, Analytics and Segment Map Views

The workout detail map, Analytics workout detail and separate segment page have an in-place
**2D / 3D** switch. Leaflet is the default when no server preference exists.
Each page restores its own saved renderer choice. The existing MapTiler-powered
flyover modals are unchanged.

## Rendering and Data Sources

- 2D keeps each page's existing Leaflet behavior. Workout and segment pages
  retain their OpenStreetMap, OpenTopoMap and CyclOSM choices.
- 3D uses MapLibre GL JS, OpenStreetMap raster tiles and Mapterhorn elevation
  tiles from `https://tiles.mapterhorn.com/tilejson.json`. The 512-pixel DEM
  tiles use Terrarium encoding. Terrain exaggeration is 1, with a separate
  DEM source for hillshading, following the MapLibre terrain example.
- No API key, MapTiler account, database change or migration is needed for this
  embedded terrain view. The flyover still uses its existing MapTiler setup.
- The terrain map and its network requests are created only after selecting
  or restoring 3D. All three pages use MapLibre 4.7.1, the existing workout and
  segment flyover version. This version does not expose `supported()`;
  map construction failures are caught instead.
- Public endpoints currently require no paid subscription. This is not a
  promise of unlimited access or availability. Follow the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  and [Mapterhorn attribution requirements](https://mapterhorn.com/attribution).
  Preserve the visible map attribution. Browsers contact both providers directly;
  providers receive the requesting IP and tile areas, not uploaded workout files.
- Terrain only affects visualization. Stored GPS positions, recorded altitude,
  ascent/descent and workout analysis are not changed.

## Local On-Demand Route Thumbnails

The regular thumbnail service supports local regional maps. The current Dev
processes use the Baden-Wuerttemberg and Hessen Shortbread 1.0 archives from the
prototype; rendering no longer depends on prototype code or its preview server.
The user reports that the production environment settings have been entered;
production archives, runtime compatibility and activation have not been verified
by Copilot. No production deployment or preparation was performed here.

### Development Configuration

The user configured these values in the local development environment file:

```dotenv
PORT=3000
FEATURE_THUMBNAILS_ON_DEMAND=1
WOA_THUMBNAIL_MAP_PROVIDER=local
WOA_MAP_DATA_DIR=tmp/local-map-prototype/data
WOA_MAP_CACHE_DIR=tmp/woa-local-map-cache
```

Restart with `npm run start:all` and open
`http://localhost:3000/dashboard-new`. The currently registered Cognito callback
requires port 3000. Stop any previous Dev start first. These variables are
inherited by app and workers; there is no automatic archive download or migration.
The protected environment file was updated by the user, not Copilot.

Root dependencies include `@mapbox/vector-tile`, `pbf` and `simplify-js` alongside
Sharp. The rendering worker requires `node:sqlite`; verified on Node 26.4.0/macOS.
The data directory must contain one to sixteen Shortbread vector `.mbtiles`
archives, opened read-only. Current BW/Hessen files occupy about 943 MiB.
Relative paths resolve from the working directory. Without explicit overrides,
data defaults to `<WOA_TEMP_DIR>/woa-map-data` and cache to
`<WOA_TEMP_DIR>/woa-postprocess/thumbnails/raster-cache`; `WOA_TEMP_DIR` defaults
to the repository's `tmp` directory. Restart after changing archives/configuration.
Unset the provider override to retain the Geoapify path. Production requires
separate archive provisioning and Node/native dependency verification.

### Production Planning And Preparation Over SSH

Two manual npm commands separate provisioning from deployment and rendering:

```bash
cd ~/woa
npm run maps:plan -- --env-file .env.production
npm run maps:prepare -- --env-file .env.production
```

Deploy the scripts/dependencies before running them remotely, but keep
`WOA_THUMBNAIL_MAP_PROVIDER=local` disabled until preparation succeeds. Otherwise
the deployment's service restart can activate local rendering before its maps
exist, persisting route-only fallbacks that are not automatically refreshed.
The user performs SSH, deployment and production command execution manually.

Recommended production directories, outside the code checkout:

```dotenv
WOA_MAP_DATA_DIR=/home/ec2-user/woa-map-data
WOA_MAP_CACHE_DIR=/home/ec2-user/woa-map-cache
FEATURE_THUMBNAILS_ON_DEMAND=1
```

1. Keep the provider override unset/disabled, deploy the code and install the
  locked root dependencies. Use a Node.js release with `node:sqlite` support;
  Node 26.4.0/macOS was tested, not Linux ARM64. The commands fail early if the
  SQLite module is unavailable. Use the existing service account, not root.
2. Run `maps:plan` and review region names, existing archives, total download,
  free disk, missing/unsupported bounds, unmapped workouts and archive count.
  This command does not create files, download archives or change database data.
3. Run `maps:prepare`. Require both exit code 0 and `ready to activate: true`.
  A complete polygon plan alone does not prove that the archives contain every
  required tile. Resolve any reported actual tile gaps before enabling local maps.
4. Only then add `WOA_THUMBNAIL_MAP_PROVIDER=local` to the production environment
  and restart app and workers with the updated environment. Keep the Geoapify
  configuration for rollback by unsetting the provider override. The commands
  never edit environment files, restart services, render images or modify
  workouts/thumbnails, and never run migrations.

Both commands require an explicit `--env-file`; there is no implicit production
selection. `--help` needs no environment file. Append `--json` for a structured
report, including affected workout IDs for unresolved cases. Exit 0 means success,
2 means an incomplete plan/coverage check, and 1 means an operational failure.
Only controlled error messages are exposed; raw connection errors/environment
contents are not printed. Plans contain aggregate counts/region names rather than
raw GPS tracks. Per-region workout counts overlap when routes span regions.

The standalone commands use the same runtime database resolver as PM2, including
the production active-database pointer (default `/etc/cwa24/active-database.env`,
overridable with `BACKUP_ACTIVE_DATABASE_FILE`). Selecting `.env.production`
enables production pointer resolution even when the SSH shell has no `NODE_ENV`;
an explicit `NODE_ENV` in the selected file takes precedence. For differently
named production files, include `NODE_ENV=production` in that file. Development
files without `NODE_ENV` do not read the production pointer. If the pointer does
not exist, the configured `DB_NAME` remains the fallback. No PM2 invocation or
shell-sourcing of environment files is required.

Failures include a controlled stage and allowlisted error code, for example
`Map command failed [stage=database-connect, code=3D000]`. Stages distinguish
`environment`, `runtime-database`, `database-connect`, `database-read`, `catalog`,
`plan` and `prepare` (plus argument/runtime/close checks). Common codes include
`3D000` (database absent), `28P01` (authentication), `42501` (permissions),
`ECONNREFUSED`, `ENOTFOUND`, `EACCES` and `ENOSPC`. Unknown errors report `UNKNOWN`,
not raw messages, stacks, credentials or URLs. The npm scripts use `node --` to
keep the script's `--env-file` argument separate from Node's own option; the
documented npm invocation is unchanged. The earlier generic production failure
was not diagnosed remotely: retry after deploying this correction and use the
new stage/code as evidence rather than assuming a database-pointer cause.
Local verification: all 790 tests passed, including simulated production pointer,
connect/read failures, missing file/invalid pointer and secret-redaction tests.
Syntax/lint passed; only the three known `lastEnd` type errors remain. No production
access, service restart, migration or deployment was performed by Copilot.

Rejected archive responses now include `archive`, `http`, `expectedBytes`,
`reportedBytes`, `body`, `encoding` and `reason` before the existing stage/code.
`expectedBytes` comes from planning/HEAD; `reportedBytes` is the GET Content-Length,
not bytes already downloaded. Missing/invalid lengths are shown as `missing` or
`invalid`. Reasons distinguish `http-status`, `missing-body`, `content-encoding`,
`missing-length` and `size-mismatch`; simultaneous failures are joined with `+`.
Only recognized encoding names are exposed; unrecognized header values become
`other`. No response body, raw header values, credentials or URLs are printed.
Archive IDs and numeric values are constrained before inclusion in diagnostics.
Unmatched responses are canceled before creating a partial file. Only a positive,
safe numeric GET length differing from the planned length qualifies for the
bounded metadata refresh described below; HTTP, body, encoding and length checks
are still required. Download and archive validation have not been relaxed.

The user reported a complete production plan (3,236 GPS workouts, 2,704 missing
thumbnails, eight archives totaling 3.93 GiB, 23.57 GiB free), followed by repeated
`Archive response changed or invalid` failures during preparation. The enriched
production error identified Lorraine: HTTP 200, HEAD/planned length 248553472,
GET length 248664064, body present and no encoding. The 108 KiB discrepancy is
confirmed; an upstream update or inconsistent cached metadata is not proven.
Keep the local provider disabled until preparation reports ready. Completed valid
archives remain reusable; do not remove a live preparation lock or start another
preparation process while one is running. New code only affects subsequent runs
after deployment; it cannot change an already running process.
All 820 tests passed, including 48 focused provisioning/CLI cases covering refresh,
retry exhaustion, HTTP/length/body/encoding, disk safety, cancellation, damaged
downloads, progress, JSON/stderr separation and file-state-based inspection reuse;
syntax/lint passed, with only the existing `lastEnd` type errors. No production
access, service restart, migration or real archive download was performed here.

Both commands emit `[maps]` phase updates to stderr, including database/catalog,
region discovery, bounds planning and each existing-archive inspection.
Preparation additionally reports the locked file-state check of each required archive,
reuse, download requests/attempts, bytes and percentages, downloaded-file
verification, installation and coverage counters (every 100 workouts and at the
end). Download byte updates are throttled to at most one per second, plus initial
and final updates; they require incoming chunks, so waiting for a network response
does not produce a heartbeat. SQLite `quick_check` is synchronous and reports the
current archive before starting, not a percentage within that check. Existing
archives are fully inspected during planning. Under the prepare lock,
`check-file-state` compares device, inode, size, nanosecond mtime and ctime against
the successful inspection; unchanged archives go straight to `reuse` without a
second `quick_check`. Changed, missing or untrusted results take the
`inspect-required` full-check path. A file changing during inspection is not
accepted as valid. The inspection cache is private to the in-memory plan: it is
not persisted or included in JSON, and a new command invocation (or deserialized
plan) performs full checks again. New downloads still receive full validation.
This removes duplicate archive scans, not the first scan or final tile coverage
checks; no production timing improvement has been measured. These messages are
visible without a TTY;
`--json` keeps the script's stdout exclusively for its final JSON report.

Example progress (illustrative, not captured production output):

```text
[maps] inspect-existing archive=alsace 1/7
[maps] check-file-state archive=alsace 1/8
[maps] reuse archive=alsace
[maps] download-request archive=lorraine attempt=1/3
[maps] refresh-size archive=lorraine attempt=2/3
[maps] download-request archive=lorraine attempt=2/3
[maps] download archive=lorraine 124332032/248664064 bytes (50.0%)
[maps] verify-download archive=lorraine
[maps] installed archive=lorraine 1/2
[maps] coverage 100/3236
```

The inventory uses one `BEGIN READ ONLY` transaction and only stored
`workouts.gps_bounds` for valid GPS workouts, across all users. It counts existing
thumbnails without reading their content. Mercator framing/padding is shared with
the renderer, expanded to complete raster tile footprints. Geofabrik's GeoJSON
polygons determine intersections. Smaller extracts fall back to an available
parent; parent/child downloads are deduplicated. Redundant overlapping aggregate
regions such as DACH do not create false gaps. Regions with no archive coverage
and GPS workouts with missing/unsupported bounds are reported, not silently skipped.

The public Geofabrik catalog and region pages are fetched as bounded metadata;
Shortbread 1.0 links are read from the official HTML rather than guessed. HEAD
requests obtain exact current lengths. No PBF conversion or external raster map
service is used. Catalog data is not saved locally by these commands.

Preparation downloads sequentially under an exclusive `.maps-prepare.lock` in
the data directory. Valid existing Shortbread archives are reused, even if a
newer upstream version exists; this is not an update command. Missing/invalid
required archives download into unique `.part` files and replace their destination
only after exact length, SQLite `quick_check`, vector format and sample Shortbread
decoding pass. No authoritative upstream checksum is provided by this workflow.
Failed/interrupted downloads clean their own temporary files; completed archives
remain for safe reruns. A pure GET length mismatch cancels that body, refreshes
HEAD with a 30-second timeout, rechecks free space for the refreshed size plus
remaining downloads and the same safety margin, then retries GET. At most three
GET attempts and two HEAD refreshes are allowed per archive. GET and refresh
requests use `cache: "no-store"`; the server can still return inconsistent data.
Refresh must return a successful response with a positive safe integer length
and no encoding. Other response failures are not retried. A continued mismatch
ends with the enriched response error, not an unchecked download. The accepted
HEAD/GET size is also enforced while streaming and at completion, followed by the
original SQLite/format/Shortbread checks. Refreshed sizes affect that download;
the plan report retains its initial HEAD estimates. SIGINT/SIGTERM cancel requests;
the whole download attempt sequence for one archive shares a two-hour limit.
After a crash/SIGKILL, check that no preparation process remains before manually
removing a stale lock or abandoned `.part` file. Never clean live temporary files.

Free space must cover all planned downloads plus 5% and 256 MiB safety margin.
The renderer's 16-archive limit includes unrelated files already in the directory;
invalid unrelated archives block preparation. The command never deletes them.
After downloads, every required tile at each thumbnail zoom is checked in the
read-only archive set. No raster prewarming is necessary. For more than 16 regions,
an explicit larger-extract/consolidation strategy is needed before proceeding;
the commands do not change the renderer limit or silently remove archives.
Do not overwrite open archives in place. Rendering workers detect local inventory
changes and reopen between jobs; an active job completes on its existing handles.
This is not a validated versioned activation/rollback mechanism: prepare replacement
files separately, use atomic installation and coordinate changes to live datasets.

Local verification on 2026-11-05: 3,225 GPS workouts, 2,986 missing thumbnails,
zero missing/unsupported bounds and zero unmapped workouts. The complete plan
requires Alsace, Austria, Baden-Wuerttemberg, Bayern, Franche-Comte, Hessen,
Lorraine and Rheinland-Pfalz. Existing BW/Hessen files are reusable; six additional
archives total 3,233,480,704 bytes (about 3.01 GiB), with about 3.93 GiB for all
eight archives. These are Dev results, not a production inventory; upstream sizes
change. No real additional archives were downloaded. Preparation/download/error
paths were tested using small temporary MBTiles and mocked HTTP responses.
All 786 tests passed, including 20 focused provisioning/renderer checks. Syntax,
lint (70 existing warnings), production-style dependency-resolution dry-run and
patch checks passed. New modules have no editor errors; typecheck still reports
only the three known `lastEnd` errors. Linux ARM64 was not exercised.

### Loading, Persistence And Limits

- The existing library observer requests images near the viewport with a 200px
  prefetch margin. The list API already includes missing-image candidates when
  on-demand generation is enabled. Setting `FEATURE_THUMBNAILS_ON_DEMAND=0`
  preserves existing-image-only behavior. Placeholders remain visible until a
  successful image load, without removing the observable image footprint.
- Local mode reuses existing successful thumbnails and all unmarked legacy images,
  including old styles, Geoapify backgrounds and old route-only fallbacks. Only
  newly marked local fallbacks participate in the lifecycle below. There is no
  bulk generation or style upgrade. Explicit manual/copied GPS edits still replace
  thumbnails because the route itself has changed.
- Missing images use the existing authenticated route and `workout_thumbnails`
  storage: per-workout advisory locking, recheck after locking and commit before
  returning. The full self-contained SVG is durable across restarts. No migration.
- Each process lazily starts one serial rendering worker, with at most eight
  outstanding requests and a 30-second queue/render deadline. Existing thumbnail
  generation concurrency remains six. SQLite, MVT decoding and Sharp work stay
  off the webserver's main JavaScript thread. Sharp settings are worker-local.
- Reusable 256x256 PNG geometry tiles exclude routes; town labels are placed
  after composition. Route gaps, segment colors and endpoints remain vectors.
  The 320x200 SVG embeds WebP and visible OSM attribution. Cache namespaces include
  archive identity and style. RAM payload LRU is bounded to 16 MiB and completed
  disk entries to 128 MiB per namespace/worker, additionally constrained by the
  shared storage budget below. Old raster entries are reclaimed across namespaces
  when capacity is needed. Orphaned temporary files and empty namespace directories
  still require verified manual cleanup; there is no cross-process tile dedup.
- Local mode makes no external map calls. Missing/incomplete coverage, invalid
  archives, worker errors, overload or timeout use the persisted route-only
  fallback. New fallbacks distinguish missing coverage, unsupported routes and
  temporary failure; only these marked images can be retried. Enlarging coverage
  never replaces successful maps or unmarked old images. Indoor/non-GPS profile
  thumbnails retain their existing path.

### Global Map Storage Budget

Approved policy: archives and persistent raster cache share at most **50% of total
filesystem capacity, capped at 100 GiB**. This uses total volume size, not the
changing amount of free space. If the configured roots are on different devices,
each device must stay within its own 50% limit and their combined map storage must
stay below 100 GiB. Processes must use the same canonical data/cache configuration.
The fixed cap takes effect at a total volume capacity of 200 GiB.

`localMapStorageService.js` recursively counts regular file lengths beneath
`WOA_MAP_DATA_DIR` and `WOA_MAP_CACHE_DIR`, including partial downloads, protected
archives, rollback files and old cache namespaces. Overlapping roots are counted
once. File lengths also count sparse files conservatively; RAM and thumbnail rows
in PostgreSQL are outside this disk budget. Keep these dedicated directories
private to the app. Root aliases are canonicalized; symlinks inside the managed
trees and unknown filesystem capacity prevent new writes rather than bypassing
accounting. This is an application write policy, not an operating-system quota
against manual/uncoordinated external writes.

Before a download sequence or raster-cache write, `.maps-storage.lock` in the data
directory serializes cooperating processes; in-process callers also queue locally.
Full remaining download bytes are checked against the peak budget, including old
files that remain during replacement. Refreshed HEAD sizes are checked again
before another GET. The target volume must additionally retain a free-space
margin of 5% of the requested bytes plus 256 MiB after cleanup. Unknown capacity,
an occupied storage lock or protected data exceeding the budget refuses downloads.

Only recognized completed raster entries (`<20-hex namespace>/<z>-<x>-<y>.json`)
are eligible for oldest-modification-time-first deletion across source/style
namespaces; successful cache reads refresh that timestamp. Every archive, possible
rollback file, unknown file and partial is protected from capacity-driven eviction.
Explicit archive cleanup is described below. No active archive or future
rollback set is automatically removed. A cache miss can still render into RAM
when storage is busy/full; it skips optional persistence without replacing a valid
map with a route-only fallback. Existing per-namespace/RAM limits still apply.

`maps:plan`, including admin quick scans, only reports budget usage, limit and
whether cleanup could make the reservation fit; it deletes nothing. Prepare and
cache writes perform cleanup when needed, then recheck capacity. There is no timer
or proactive mass deletion, no new configuration variable, dependency, npm script
or migration. If a process is killed, either map lock can remain: verify owning
processes and active downloads before manual lock/partial cleanup. Do not remove a
live lock or run older uncoordinated writers alongside the upgraded processes.

Admin shows `Kartenbudget · Belegt / Limit`, disables download approval when even
safe cache cleanup cannot satisfy budget/reserve, and reports storage/cleanup
phases. CLI text/JSON reports the same budget; completed preparation reports the
new usage rather than its initial estimate. Archive validation and actual viewport
coverage checks remain unchanged. Versioned installation/rollback is described
below; automatic retirement/deletion remains a separate follow-up.

The follow-up increase from 30% to 50% passed all 57 provisioning/storage tests,
including rounding, the cap threshold and independent split-volume limits.
Initial implementation verification: all 846 tests passed, including 79 focused provisioning, renderer,
admin and navigation checks. Tests cover both budget thresholds, split volumes,
overlapping roots, protected partial/rollback data, global raster LRU, lock
serialization/release, rejection before GET, budget enforcement after a HEAD size
change, post-prepare reporting and valid rendering without optional cache writes.
Syntax/lint passed with 70 existing warnings; full type checking and editor checks
are clean. Actual EJS/controller browser checks with simulated budget reports at
1365 px desktop and 390 px mobile verified labels, blocked/cleanup-enabled approval
and nonoverflowing single-line budget values; screenshots inspected. No production
cleanup/download, DB data write, migration, deployment or normal Dev restart was
performed. Real production volume capacity and timing have not been measured.

### Local Map Lifecycle

The user approved a staged lifecycle design. Fallback state/targeted recovery and
the manual admin demand/provisioning workflow below are implemented locally.
Monthly metadata monitoring and manually approved versioned installation,
activation and rollback are implemented below. Unattended installation is disabled.

New local fallback SVGs carry `data-local-map-state`, a 64-hex-character
`data-local-map-revision`, `data-local-map-attempt` and the existing safe
`data-map-fallback`/`data-map-retry-at` attributes. They are persisted in the
existing PostgreSQL thumbnail row; no schema change or migration is required.
Raw exception messages, paths or credentials are not embedded.

| State | Implemented behavior |
| --- | --- |
| Successful map or unmarked legacy image | Reuse unchanged, including across future map revisions. |
| `missing-coverage` | Show the route-only image; retry on the next actual thumbnail request only after the local inventory revision changes. No repeated render with the same revision. |
| `temporary-failure` | Keep the route visible. Maximum three rendering attempts per revision: wait five minutes after the first, fifteen after the second, then hold after the third. Requests before deadlines only reuse the saved fallback. A changed revision or explicit replacement resets the sequence. No retry timer/background task is started. |
| `unsupported-route` | Keep the route-only image without automatic retry, even after map changes. Explicit GPS edits/replacement may rebuild it. This means unsupported route geometry; catalog-level unsupported regions belong to future demand management. |

The revision fingerprints the active set ID, selected relative archive paths,
source directory, device, inode, size and nanosecond mtime/ctime. Without a manifest,
it uses the legacy root inventory. It is an inventory identity, not an upstream
version/checksum or coverage guarantee. The synchronous directory/stat lookup is
memoized for five seconds and does not open SQLite or contact a provider. `.part`
files are excluded. A changed unrelated archive can allow a missing-coverage
fallback one new attempt; the renderer still verifies actual viewport coverage.
Fallback browser responses retain `private, max-age=60`, so a browser may first
reuse its cached image. Recovery is on demand, not an immediate bulk regeneration.

At the next queued render after a detected inventory change, the client retires
the idle worker and opens the new archive set. Active work is not interrupted.
The existing source-identity/style raster namespace separates new tiles from old
ones. Set activation is implemented below; archive deletion remains disabled.
Old raster entries are eligible under the shared storage policy above. Existing per-namespace
cache limits and the 16-archive cap remain in force.

Verification: all 827 tests passed, including 40 focused thumbnail/worker cases
covering states, legacy protection, safe annotation, persisted retry counters,
backoff/hold/reset, concurrent one-time replacement, real worker geometry errors,
inventory changes and raster namespace separation after atomic replacement.
Syntax/lint passed (70 existing warnings); only the three known `lastEnd` type
errors remain. No production access, deployment, actual archive download, schema
migration or service restart was performed for this stage. The user had separately
reported production preparation success: eight archives, 3,236 GPS workouts,
2,704 missing thumbnails and zero uncovered workouts, `ready to activate: true`.
Provider activation and live production rendering have not been independently
verified here.

Accepted follow-up requirements:

- Imports remain successful without map coverage; no upload or image request may
  trigger a multi-GiB regional download or external-provider fallback.
- Aggregate and deduplicate regional demand across workouts; expose region,
  estimated download size, status and available disk in an admin view. Import
  demand tracking and explicitly enabled automatic missing-region downloads are
  now implemented below; no additional monthly or per-region size quota applies.
- Provision missing regions in background work and permit targeted recovery of
  only marked fallbacks after successful activation. Unsupported catalog regions
  need a durable status, not endless attempts.
- Monthly upstream metadata monitoring is implemented below, without automatic
  installation. Length alone is not a version identifier.
- Versioned downloads, atomic activation and one previous rollback target are
  implemented below. Working maps survive download failures; successful thumbnails
  are not mass-regenerated.
- Global storage accounting and raster cleanup are implemented above. Automatic
  archive-set retirement remains deferred. Explicit manual cleanup and retirement
  are implemented below; active and rollback references remain protected.

There is no dedicated regional demand table or automatic archive retirement.
Import-triggered scans persist aggregated regional demand in a private atomic
file, described below; workout GPS bounds remain its durable source.
Global raster cleanup now runs on write-capacity pressure, not on a timer.
The manual workflow derives demand from PostgreSQL GPS bounds
and stores job snapshots in the existing Redis-backed Ops queue instead.

### Map Update Metadata Monitoring

`Updates prüfen` explicitly queues `maps-updates` in the same serial Ops queue.
Page loads and workout uploads do not enqueue it. When
`WOA_THUMBNAIL_MAP_PROVIDER=local`, the Ops worker registers the stable BullMQ job
scheduler `local-map-monthly-updates`: **03:00 UTC on the first of each month**.
This registration is idempotent and does not immediately check or download data.
With another provider, worker startup removes that scheduler. Registration failure
logs a safe message; restart/reconnect the worker to retry. Manual map operations
use the existing shared deduplication ID. Future monthly jobs do not hold that ID
or count as active UI work while delayed; once due, they share the serial worker.
A manual check near a monthly run can result in two sequential metadata checks.
Long backup jobs can delay
the check; both Redis and the Ops worker must be available.

The async check reads the selected active set (legacy top-level `.mbtiles` files
without a manifest; maximum 16), fetches the official Geofabrik catalog and
region HTML pages, and issues archive HEAD requests with redirects rejected.
An empty inventory makes no network request. No archive GET, SQLite opening,
PostgreSQL connection, file write, cleanup, service restart or activation occurs.
Unknown filenames, unavailable regions and failed queries cannot become verified
versions. Symlinks/invalid active entries fail closed before network access.
Local file identity is checked before/after each query; an
overall ten-minute deadline bounds a run in addition to the request deadlines.

The service accepts bounded strong ETags and valid HTTP Last-Modified dates. Weak
ETags alone, missing validators, changed URLs and size-only differences are
inconclusive. A size change with unchanged validators is also inconclusive.
Comparable validator differences indicate an upstream change; no size change is
required. Matching metadata means only that the observed metadata is unchanged,
not that the installed archive is current, valid or byte-identical.

Redis key `<qualified Ops queue name>:map-update-state-v1` holds private comparison
anchors plus the latest public report, independently of completed-job expiry and
without an application TTL. Redis persistence/retention still determines actual
durability: losing/flushing this key starts new observations. The first usable
observation anchors the current local file fingerprint (device/inode/size and
nanosecond mtime/ctime). A detected change remains visible across repeated checks;
per-region errors preserve the anchor. Replacing/rewriting a local file resets its
anchor instead of inheriting old conclusions. Removed archives are pruned from
observation state only, never removed from disk by this feature.

Existing legacy downloads have no trusted recorded upstream provenance. Their
installed version remains explicitly **unverified**, including after matching repeated
metadata checks. The admin labels are `Upstream geändert`, `Metadaten unverändert`,
`Versionsstand unklar`, `Upstream nicht verfügbar` and `Prüfung fehlgeschlagen`;
the separate installed-version column says `Nicht belegt`. First observations
are inconclusive. Versioned downloads now record actual GET metadata, local hash
and file identity; unchanged matching files show `Stand erfasst`, and checks compare
against that installed source rather than a first-observation baseline. This is
recorded download provenance, not a signed upstream checksum or eternal freshness
guarantee. A fresh usable validator also permits explicitly approved replacement
of an unverified legacy region; size-only/weak-only metadata cannot authorize it.
No automatic download approval is created. The 50%-volume/100-GiB disk policy
remains unchanged because this check writes only bounded Redis state.

Admin `GET /admin/accounts/maps` returns `updates` separately from the demand
snapshot. The new `POST /admin/accounts/maps/updates` requires admin access and a
matching Origin host. Results contain no source URL, local path, fingerprint,
raw ETag, raw error or workout identity. Update jobs cannot replace a demand
snapshot or authorize `prepare`; normal snapshot expiry and approvals remain.

Integration correction (2026-11-05): a real BullMQ Job exposes its Redis connection
through `job.queue.client`, not `job.client`. The original plain-object mock
invented the latter and hid an immediate runtime failure. The service now uses
the queue connection, and the regression test constructs the installed BullMQ Job
class with an offline queue/client stub. All 854 tests, including 12 focused
admin/update tests, full typecheck and touched-file syntax/lint/editor checks
passed after this fix. Deploy the updated Ops worker before retrying the manual
check; no live Redis/upstream run, deployment or restart was performed here.

Initial feature verification: all 854 tests passed; syntax/lint passed with 70 existing warnings,
full typecheck and relevant editor diagnostics clean. Tests cover strict headers,
size-only ambiguity, real discovery method selection without archive GET,
latched/reset/error states, empty inventories, symlinks, protected files, schedule
registration/removal, Redis result retention and API approval isolation. Actual
EJS/map-controller browser preview with simulated reports at 1365 px and 390 px
verified all five labels, icon rendering, zero jobs on initial load, one job after
a click, busy/progress behavior and no page overflow; screenshots inspected.
The isolated preview does not load the real app's i18n or ZIP-vendor middleware;
unrelated navigation translations/vendor-backed admin controls were not verified
there. No live Redis scheduler, real upstream requests, production operations,
normal Dev restart or migration were executed. Preview retained at
`http://127.0.0.1:59197/admin/accounts#maps` with simulated data only.

### Versioned Installation And Rollback

After `Updates prüfen`, explicitly confirm the listed eligible regions and select
`Updates installieren`. The confirmation covers all eligible rows in that snapshot.
The API and worker revalidate the exact region IDs, a maximum one-hour snapshot
age and the expected active-set identity; queue delays can require another check.
No arbitrary source URL comes from the browser. The separate `Rollback freigeben`
confirmation and `Vorherigen Satz aktivieren` action target the currently displayed
previous set, not any user-supplied path. Opening the page starts no job.

`map-archive-set.json` in `WOA_MAP_DATA_DIR` is the authoritative version-1 pointer
to active/previous sets. Version files live at `versions/<UUID>/<region>.mbtiles`;
existing root archives remain valid legacy entries. Paths, regular-file identity,
symlinks, set size and duplicate regions are checked. Invalid manifests fail closed
rather than mixing root/staged files. Without a manifest, legacy behavior remains
unchanged. An over-limit legacy plan remains diagnosable but cannot activate.

New files are downloaded under the existing prepare/storage locks into a new
version directory. The GET must still match approved strong ETag/HTTP-date and
length; changed metadata refuses installation instead of silently adopting a newer
version. Full SQLite/Shortbread checks and all current stored workout viewport
tiles must pass before activation. Missing/unsupported bounds block activation.
The existing runtime DB pointer resolver supplies a read-only inventory. Active
files are never overwritten by versioned installation, including managed
`maps:prepare` additions. Legacy `maps:prepare` remains compatible. Damaged
manifest-selected files fail planning/rendering closed; use the verified rollback
path rather than overwriting them in place.

Each activated entry records streamed SHA-256, bytes, nanosecond file fingerprint
and actual GET source metadata where available. Inherited legacy entries receive
local hashes but no invented upstream provenance. The first activation records
the previous legacy files as a hashed rollback target. Manifest output is synced,
atomically renamed and the containing directory synced under the shared budget
lock, after rechecking the expected active identity. Existing valid files remain
available after a failed download, validation, coverage or stale-identity check.

Readers use one selected manifest snapshot. The existing five-second revision memo
detects set changes; the next queued render retires an idle worker and opens the
new set only after active work finishes. Version/source identities isolate raster
namespaces. Successful stored thumbnails are preserved; only marked recoverable
fallbacks can retry on demand as before. No bulk rerender or application restart
is triggered by installation or rollback.

Rollback verifies every target's stored fingerprint/hash and full SQLite format,
then checks current workout coverage before swapping active/previous pointers.
New workouts may therefore prevent rollback to an older incomplete set. No archive
download occurs during rollback. The current active set becomes the new previous
target, allowing a checked reversal; no unchecked pointer swap is offered.
Admin pointer/status reads remain available even if a current version file is
missing or has changed; this enables recovery to the verified previous set while
the renderer still refuses the damaged current set. A structurally invalid
manifest is not silently repaired or ignored. A failed prior target cannot be
reactivated merely because it remains referenced after a recovery rollback.

All live/previous/staged files, manifest output and older orphaned versions count
against the unchanged 50%-volume/100-GiB limit plus free-space reserve. Cache-only
eviction is permitted on capacity pressure. Explicit verified archive cleanup is
described below. Exactly one prior set is referenced; older files are not deleted
automatically. Open-reader reservations protect files beyond those two references.
Repeated updates can eventually exhaust the budget until an approved cleanup.
Automatic retirement remains deferred; never manually
delete active/previous entries or remove locks without checking process ownership.
Crash-left files count toward the budget and are not automatically trusted.

Deploy/restart all cooperating app/worker processes with the same data/cache
configuration before use; old binaries do not understand the manifest. Existing
top-level files are not moved/deleted during adoption. The manual installer uses
the existing serial Ops queue/CLI child, not a new daemon. Private approval state
is transferred over stdin with a 128 KiB bound, not command-line arguments; public
reports expose set IDs/opaque identities, never hashes, source URLs or file paths.
New protected endpoints are `POST /install` and `POST /rollback` under the map API.
Neither job can become a demand-plan snapshot or authorize missing-region prepare.

Verification: all 861 tests passed, including 94 focused renderer, provisioning,
admin, EJS and real offline CLI-subprocess cases. Full typecheck/editor checks are
clean; touched code is lint-clean. Tests cover legacy/managed selection, path
rejection, stale activation/approval, GET changes, invalid SQLite, missing install/
rollback coverage, corrupt rollback files, recorded provenance and real BullMQ Job
stdin transport. Actual EJS/CSS/controller browser checks with simulated jobs at
1365 px and 390 px confirmed no page-load mutation, explicit install/rollback
requests, busy/reset states, icons and nonoverflowing long IDs; screenshots inspected.
Preview retained at `http://127.0.0.1:60511/admin/accounts#maps`, simulated data only.
Its unrelated i18n/ZIP-vendor middleware is not loaded. No live Redis job, upstream
download, production activation/rollback, deploy, normal restart or migration was
performed. The user had separately confirmed the preceding metadata check works.

### Production Thumbnail Bands

Newly generated thumbnails now use separate filled bands matching the workout
chart palette: power blue `#2563eb`, heart rate green `#16a34a`, altitude cyan
`#38bdf8` and speed red `#ef4444`. Areas have no outlines, with opacity 0.3 for
altitude and 0.26 for other metrics. Each band has its own vertical scale.

- GPS: retain the map, route, markers and attribution. A compact lower strip
  shows Power and Altitude; unavailable altitude selects Heart Rate instead.
  The strip has a 0.6-opacity white backing, below route/markers and above the
  map image. Attribution remains outside it.
- Non-GPS, including indoor: Power, Heart Rate and Altitude; unavailable altitude
  selects Speed instead. Unavailable individual series are omitted, not invented.
- Altitude needs at least two finite values, but constant, zero and negative
  elevations remain valid. Its baseline is relative, padded and rounded to 10m.
  Other metrics also need a positive value. Null/undefined/missing altitude stays
  unavailable rather than being converted to zero.

GPS generation now also loads/decompresses its workout stream. The direct
WST9/WS10/WS11 thumbnail reader optionally reads altitude and speed. If speed is
not stored separately, it uses the existing full decoder's distance-derived
speed, with its additional allocation/decoding cost. An unreadable GPS profile
stream leaves the route/map available; non-GPS still requires a readable stream.
The benchmark reports stream decompression and decoding separately. A local
one-workout smoke (60151) completed all nine cold/disk/RAM batches with the PNG
RAM default; this is an integration check, not representative latency evidence.
Report: `tmp/woa-local-map-cache/gps-benchmark-f0e696d0-fda9-49fe-bb96-bdb3c0b6d5ca/report.json`.

Existing thumbnail rows are untouched and their currentness policy is unchanged.
The user will delete old rows manually. Browser thumbnail URL version is now 3
for the segment/phase integration; this separates earlier URL versions but does
not force database regeneration or invalidate an already cached version-3 URL. Successful
images still use the existing private immutable cache policy.

The retained line prototype is explicitly requested through `profileStyle: "lines"`.
The read-only preview also writes `tmp/gps-profile-preview/production.html`, using
the actual production band generator and GPS compositor with stored maps/real GPS
data, plus actual non-GPS streams. Dev examples: GPS 84965/84964/84963, non-GPS
85065/85035/85034 (including the Speed fallback). Browser checks at 1200/390px:
24 loaded, nonblank images with stable native/list sizes and no horizontal overflow.
All 888 tests passed; focused decoder/service tests and types also passed after
the final missing-column coverage adjustment. No existing thumbnail writes,
migration, deployment, normal service restart or environment-file edits.

### Production Segment And Phase Bands

The user approved the phase-detail variant as the default for newly generated
non-GPS/indoor and GPS thumbnails. Only stored interval blocks, microinterval
blocks and simple manual segments are rendered in the profile. Automatic simple
laps, critical-power, GPS and unknown segment types remain excluded there.
Existing colored segment overlays on the GPS route are unchanged.

The production segment SVG helper uses the same shared lane allocator, palette
and phase-area policy as the workout chart, without importing the browser UI or
running detectors. It renders compact header bars and areas across every visible
metric band. Work/recovery opacity is 0.28/0.04; manual segments use their solid
range area. Blocks without stored phases retain their parent area. Offsets are
clipped to the raw workout record count before series downsampling.

Non-GPS profiles retain the approved full phase design. GPS applies it inside the
existing 0.6-white-backed map strip, omitting tiny header labels and leaving the
segment-profile body transparent so the map can show through. Map, route,
endpoint layers and attribution remain outside/above the profile as before.
Stored parents are scoped by workout ID and owner, with ordered phases read from
the existing workout_segment_phases table. No new migration is needed; the
existing segment/phase schema must already be present. No detector or segment
write is triggered by thumbnail generation.

The read-only production preview uses that same loader/compositor. Existing map
SVG profile groups are removed only from the in-memory preview copy to avoid
reusing an old strip. Actual GPS examples: 85063 with two microinterval blocks,
85062/85058 with manual segments. Non-GPS 85065 has one interval block. The
synthetic microinterval demonstration remains confined to segments.html.

Verification: 892 full-suite tests, final 39 thumbnail tests, types and syntax
passed; scoped lint had no errors and three existing ChartView warnings. Browser
1200/390px checks: all 24 production-preview images loaded/nonblank, no overflow,
one GPS strip each, real phase/header elements and preserved attribution.
Nine of nine one-GPS Dev benchmark generations succeeded using temporary
thumbnail tables and PNG RAM default. Report:
`tmp/woa-local-map-cache/gps-benchmark-3dccf2cf-553a-4d61-9d7c-f6b96676105a/report.json`.
This is an integration smoke, not representative production latency evidence;
the isolated cache/report remains retained and budget-counted.
Existing thumbnail rows/currentness, route style version and tile-cache identity
are unchanged. No migration, deployment, application restart or env edit occurred.

### Combined GPS And Metric Profile Preview

This section records the retained, initially preview-only designs. The subsequent
approved production policy is documented above.
Generate the standalone local HTML preview with:

```bash
node -- src/scripts/preview-gps-profile-thumbnails.js --env-file .env.development
```

It requires the explicit local Dev environment/runtime database pointer, performs
its database queries inside a read-only transaction and selects existing local-map
GPS thumbnails with streams. It decompresses the streams and reuses the existing
non-GPS power/heart-rate/cadence SVG profile generator. No thumbnail rows are
created/replaced, map tiles generated/downloaded, migrations run or services
restarted. Output is `tmp/gps-profile-preview/index.html`, a standalone page with
embedded images; it needs no server and contains local workout data.

Three actual Dev workouts (84965, 84964, 84963) are shown as map-only, map plus
profile and the unchanged metric profile, each at 320x200 and 152x95 list size.
The compact strip reuses the generated metric curve paths without legend/grid,
on an 88%-opaque white backing at y=128..176. It sits after the map background
but before the route/markers, leaving attribution below it untouched. Curves use
non-scaling strokes. This is a design probe: overlapping route/profile colors and
the three-series density can reduce clarity at list size. No cache/version/style
or production rendering policy has been changed.

Verified with all 885 tests, types/scoped lint/syntax, desktop/mobile browser
screenshots and image/canvas checks: 18 loaded images, no overflow at 1200/390px,
320x200 native and 152x95 list dimensions, nonblank image pixels. The focused
preview test checks curve reuse, layer order, attribution and six comparison
images per workout. New production composite rendering remains a separate approval.

The subsequent approved preview variant is `tmp/gps-profile-preview/bands.html`.
Tabs link it to the retained line preview. It follows the workout chart's bands
layout: separate power/altitude areas, no data outlines, palette power `#2563eb`
at 0.26 opacity and altitude `#38bdf8` at 0.3. Power uses the existing smoothed
metric path closed at its zero baseline. Altitude is read through `Workout.fromBuffer`
and `getAltitudeAt`, with a relative baseline padded by max(10m, 5% of range) and
rounded down to 10m, then reuses the existing altitude-area thumbnail path.
This borrows the chart's visual policy, not its complete ECharts axis/render engine.
The band strip's white backing was reduced to 0.6 opacity at the user's request,
so the map shows through; the retained line variant stays at 0.88. Focused tests
verify both values. The two source profiles have 18px/14px side padding; the height area is horizontally
transformed to match power's time extent. Compact labels are omitted, full band
profiles retain Power/Altitude labels. Route/marker layering and attribution are
unchanged. All three Dev samples produced both bands. All 886 tests passed; the
final alignment adjustment also passed focused tests/types/lint. Desktop/mobile
screenshots show loaded images and no overflow; old line images remain available.

### Non-GPS Segment Thumbnail Preview

The same read-only Dev preview script now writes
`tmp/gps-profile-preview/segments.html`. It compares unchanged production bands,
bands with segment areas, and a phase-detail variant at 320x200 and 152x95.
The comparison page itself remains read-only. The phase-detail variant was
subsequently approved as the production default for GPS and non-GPS profiles;
see Production Segment And Phase Bands above. The other comparison columns and
synthetic demonstration remain preview-only. No detection, segment saves or
migrations run when creating the preview.

Only interval blocks, microinterval blocks and ordinary manual segments are
included. Automatic simple laps, critical-power, GPS and unknown segment types
are excluded. Stored parents and ordered phases are selected in the existing
read-only transaction. Actual examples are 85065 (one interval block) and
83935/59436 (two manual segments each). No stored non-GPS microinterval example
was found in this Dev selection, so a separately labeled Layout-Demo places
synthetic 12 x 40/20 phases on the real 85065 metric profile. These phases do not
represent detected efforts and are not persisted.

The design follows the actual ECharts Bands UI: same segment colors and header
lane allocator, compact top bars, and transparent areas across every displayed
metric band. Four compact overlap lanes are available; labels are omitted when
they do not fit. The reserved header space scales the metric body without
changing the outer SVG dimensions. Areas share the profile's 18..238 time extent;
structured block/phase end offsets are inclusive and clipped to the workout.
The phase variant uses the existing UI helper's work/recovery opacity 0.28/0.04
for all shown blocks, rather than requiring interactive hover/selection. Manual
segments have no phase-detail difference. No ECharts chart instance is created.

Verification: all 37 focused thumbnail tests, full type checking, scoped lint and
syntax passed. Desktop1200/mobile390 image/canvas checks found all 24 images
loaded/nonblank, correct native/list sizes and no horizontal overflow. Pixel
checks confirmed phase differences for the interval block and demo, and equality
for simple manual segments. The script retains the earlier three comparison
pages; current GPS examples are selected dynamically from Dev data.

### GPS Thumbnail Performance Measurement

The development-only GPS benchmark uses the real compact-track/segment matching,
local-map worker and thumbnail SQL pipeline:

```bash
node -- src/scripts/benchmark-gps-thumbnails.js --env-file .env.development --limit 6
```

It accepts only `.env.development`, a local database host, the local map provider,
installed active archives and a sample limit of 1..12. It uses the runtime database
pointer resolver, selects GPS workouts across compressed track-size quantiles and
excludes indoor/non-GPS thumbnails. No migration or application restart is performed.

Each generation connection creates a session-local `workout_thumbnails` temporary
table without persistent sequences/triggers and verifies that unqualified relation
lookup resolves to `pg_temp.workout_thumbnails` before continuing. Existing thumbnail
rows are neither deleted nor overwritten. SQL upsert and COMMIT run against that
table, which is dropped on COMMIT/ROLLBACK. Advisory-lock keys use a separate random
benchmark namespace, not the normal workout key. This measures the application
pipeline, **not durable production persistence latency**: transaction setup includes
temporary-table creation/isolation verification and COMMIT includes its removal.
There is no HTTP/session/auth/network round-trip measurement or production claim.

For concurrency 1, 3 and 6, each batch uses a fresh private cache namespace under
`WOA_MAP_CACHE_DIR/gps-benchmark-<UUID>/`. `cold` starts with an empty namespace;
tiles may then be reused between workouts in that same batch. `disk` recreates the
worker, emptying its RAM cache, but does not flush operating-system disk caches.
`ram` reuses the worker/cache after that disk batch. All runs retain the real
combined data/cache storage accounting and locks, but disable cache eviction, so
existing raster cache entries remain untouched. Insufficient capacity can prevent
test-cache persistence and invalidate the expected disk-reuse scenario; inspect
the built/disk/memory counters, not just wall time. Temporary reader reservations
protect archive files while the benchmark worker is alive. Test caches and
`report.json` are retained for inspection and count toward the storage budget;
remove only the known benchmark directory after verifying its workers have exited.

Profiles now distinguish generation-limit wait, pool connection wait, transaction
setup, advisory-lock wait, locked thumbnail lookup, payload creation, persistence,
connection-held time and full generation time. Worker profiles separate queue wait,
service time and startup/renderer initialization. Tile profiles distinguish cache
read, vector load/decode, geometry construction, SVG rasterization, storage
reservation, cache file write and cache trim. Byte-identical regional tile rows
are counted diagnostically but still rendered; no source deduplication or geometry
simplification has been applied. CPU time includes all process threads; sampled peak RSS is not
per-request memory. OS filesystem counters are operation counts, not byte totals,
and may be zero on macOS. Six-workout percentiles are descriptive, not robust tails.

Two actual local Dev runs on 2026-11-06 rendered all six selected GPS workouts in
all nine scenarios without fallbacks. The detailed run measured:

| Cache batch, concurrency 1 | Mean map render | Mean generation pipeline | Batch, 6 workouts |
| --- | ---: | ---: | ---: |
| New test cache | 611.7 ms | 661.0 ms | 3,968 ms |
| Disk reuse | 56.1 ms | 90.4 ms | 544 ms |
| RAM reuse | 19.4 ms | 55.6 ms | 336 ms |

Across the three new-cache batches, mean per-workout SVG-to-PNG rasterization was
412-413 ms, geometry construction 83-85 ms, vector load/decode 5-14 ms, and storage
reservation 60-68 ms. The earlier run's storage reservation was 39-49 ms; cache
inventory size and OS/database warm-up differ. Peak sampled RSS was 287-338 MiB.
New-cache concurrency 3 versus 6 took 3,653 versus 3,632 ms for the same six workouts,
while mean worker wait grew from 830 to 1,315 ms. Increasing request concurrency
does not parallelize the existing single map worker.

The detailed new-cache runs processed 210 regional source tile rows, of which 60
(28.6%) were byte-identical duplicates for the same tile coordinates. A justified
next experiment is to skip **byte-identical** duplicate source rows before geometry
construction/rasterization, while preserving distinct regional content, attribution
and active archive references. Coordinate overlap alone is never sufficient, as
the Austria retirement regression demonstrated. Require focused image/content
comparisons and the same benchmark before claiming improvement; worker-pool or
transaction-lifetime changes remain separate, unapproved follow-ups.

Detailed report: `tmp/woa-local-map-cache/gps-benchmark-a0a3aff9-f9b9-443e-a573-e30bd9322e4c/report.json`.
Initial report: `tmp/woa-local-map-cache/gps-benchmark-35620b18-d068-457b-9d66-cbad3c41da6d/report.json`.
These are ignored local artifacts and are not portable sample fixtures. Verification:
all 883 tests, full types and touched-code lint passed; fixtures cover deterministic
worker queue/startup timings, cache hit/build phases, temporary relation isolation
and cache-eviction refusal. Existing stored images were not regenerated.

#### Warm Render Phase Follow-Up

The approved follow-up adds `localMap.renderProfile` and benchmark `render.*`
summaries without changing cache contents, Sharp operations or rendered output:
`viewportMs`, `tileAssemblyMs`, `mosaicDecodeCompositeMs`, `labelPlacementMs`,
`outputPipelineMs` and `finishSvgMs`. Tile assembly includes cache access and
label/region collection; its nested `tile.cacheReadMs` must not be added again.
The mosaic phase includes PNG decoding/compositing and raw-buffer materialization.
The output phase deliberately preserves one lazy Sharp pipeline: crop, resize,
label SVG rasterization/compositing and WebP encoding are measured together, not
as individually attributed costs. Route/overlay projection, simplification,
base64 embedding and final SVG assembly are covered by `finishSvgMs`.

Two six-workout runs each completed all 54 generations without fallback. The
second ran after all regression/static checks had finished, avoiding competition
with those checks. All RAM scenarios used memory hits only, with no disk hits or
tile builds. Its concurrency-1 mean times per complete map render were:

| Phase | Mean |
| --- | ---: |
| Viewport | 0.126 ms |
| Tile assembly, including cache lookup | 0.109 ms |
| PNG decode / mosaic / raw buffer | 8.524 ms |
| Label placement | 0.052 ms |
| Crop / resize / label rendering / WebP | 10.141 ms |
| Route / overlays / final SVG | 0.365 ms |
| Complete map render | 19.345 ms |

Nested cache lookup was only 0.074 ms for all requested tiles combined, not per
tile. The corresponding concurrency-3/6 map means were 16.025/16.251 ms; mosaic
6.888/6.859 ms and output 8.672/8.875 ms. Worker queue waits are separate from
these render timings. Small phase gaps cover instrumentation/setup overhead;
these six Dev workouts do not establish production latency or a speedup.

The evidence supports a proposed decoded-pixel RAM cache experiment before
micro-optimizing lookup/allocation code. It could avoid repeated PNG decoding,
but not mosaic construction or the output pipeline; no entire-phase saving is
promised. Account for raw buffer bytes in the existing RAM limit, keep the disk
PNG cache and verify pixel/output equivalence and the same benchmark. The approved
implementation and comparison are recorded below; duplicate-source deduplication
remains unapproved and unimplemented. Existing stored thumbnails were not modified.

Isolated report: `tmp/woa-local-map-cache/gps-benchmark-94e43a00-8982-4165-ba5f-2749fe09bcce/report.json`.
First phase report: `tmp/woa-local-map-cache/gps-benchmark-04b06a5f-1c80-4435-8b74-f86f7c945caf/report.json`.
Both test caches remain under the real storage budget; workers exited. All 883
tests, full types, scoped lint/syntax and editor diagnostics passed. The existing
cache test checks finite/non-overlapping phases and equal cold/disk/RAM backgrounds.

#### Decoded-Pixel RAM Cache

After explicit approval, raster cache entries retain their PNG plus a decoded
pixel buffer, dimensions and channel count. Mosaics pass the pixel buffers to
Sharp as raw inputs, avoiding repeated PNG decoding on RAM hits. Disk JSON/PNG
format, checksum validation, cache version/identity, map styling, route/label
rendering and worker concurrency remain unchanged; installed cache files need no
conversion. After reviewing the approximately 4.3x retained-memory cost for a small
warm-render gain, the user approved restoring PNG-only RAM as the default.
`rawPixelCache` now defaults to `false`; explicit `true` retains the experiment
for controlled comparisons. Timing instrumentation and image tests remain in place.

The existing 16 MiB retained-entry LRU budget counts both actual PNG and raw buffer
lengths plus estimated labels/regions/entry overhead. Oversized entries are not
retained; eviction and `clearMemory()` still enforce/reset the budget. This is not
a process-RSS or transient render-buffer cap. Raw RGBA tiles take 256 KiB before
PNG/metadata overhead, so fewer tiles fit than with PNG-only entries. Decode is
performed once per load/build, even when an entry cannot be retained. Its time is
reported as `tile.pixelDecodeMs`, zero on RAM hits; on disk hits it is nested in
cache-read time and always nested in tile assembly, not an additive top-level phase.

Use the same development guards/cache isolation/temp-table persistence as above:

```bash
node -- src/scripts/benchmark-gps-thumbnails.js --env-file .env.development --limit 6
node -- src/scripts/benchmark-gps-thumbnails.js --env-file .env.development --limit 6 --raw-memory --compare-pixels
```

The default measures PNG-RAM; `--png-memory` remains an explicit compatibility
alias for that default. `--raw-memory` opts into raw pixels for the nine measured
batches. Supplying both memory flags fails before environment/database access.
`--compare-pixels` adds two unmeasured generation passes after those batches,
one PNG and one raw, in a separate test-cache namespace. It verifies local-map
backgrounds and exact full-thumbnail RGBA equality, records hashes/SVG equality,
and fails on changed pixels. It adds 12 generations for six samples, all still
persisted only in session-local temporary tables. Report batches state
`rawPixelCache`; comparisons are stored separately as `imageComparisons`.

Direct sequential same-code Dev measurements on 2026-11-06, without concurrent
tests, gave these mean complete-map times for memory-only batches:

| Request concurrency | PNG RAM | Raw-pixel RAM | PNG mosaic | Raw mosaic |
| --- | ---: | ---: | ---: | ---: |
| 1 | 20.363 ms | 16.424 ms | 8.947 ms | 3.988 ms |
| 3 | 15.746 ms | 14.354 ms | 6.582 ms | 3.757 ms |
| 6 | 16.824 ms | 12.981 ms | 7.104 ms | 3.397 ms |

That pair shows about 9-23% lower warm render time, not HTTP/end-to-end or production
throughput. Retained tile RAM rose from 2.12 to 9.12 MiB, below 16 MiB. Raw decode
costs about 4-5 ms per workout on initial load/build; cold runs were not faster
(roughly 2-5% slower complete-map means in this pair). Storage inventory grows
between isolated runs and OS/CPU/SQL times vary, so do not attribute the whole cold
difference to raw decoding. An earlier raw run also produced pixel-identical
images with variable total timings; no production/tail guarantee is inferred.
Both raw runs verified exact pixels and byte-identical SVGs for all six workouts.

Paired reference: `tmp/woa-local-map-cache/gps-benchmark-70c6a23f-8a17-4e1e-9ca6-f2e32e2be103/report.json`.
Paired raw: `tmp/woa-local-map-cache/gps-benchmark-9c42066a-11cd-4046-a8f9-d6a19bab9b11/report.json`.
Initial raw: `tmp/woa-local-map-cache/gps-benchmark-b097351d-eac9-44ca-8741-2ade7fa5fafd/report.json`.
All measured batches completed 54/54 generations; raw comparison runs added 12/12.
Caches/reports are retained and budget-counted; workers exited. Verification:
884 tests, full types, scoped lint/syntax/editor checks; expanded cache test also
checks unchanged disk format/cache identity, raw-byte accounting and eviction.
Pixel comparison tests reject color, alpha and dimension changes. No existing
thumbnail writes, map downloads, migrations, deployment or normal restart occurred.
After default restoration, all 884 tests, types and scoped lint/syntax passed;
a one-GPS nine-batch smoke run verified `rawPixelCache=false` and zero
`tile.pixelDecodeMs` without flags. These are default-behavior checks, not new
performance claims; previously measured raw results above remain historical.

### Manual Archive Cleanup And Region Retirement

The map area at `/admin/accounts#maps` now offers two independent manual workflows.
Page load only reads reports and starts no operation. There is no automatic archive
deletion, upstream request, thumbnail rebuild, new npm script, dependency,
environment variable or database migration in this stage.

`Bereinigung prüfen` queues `maps-cleanup-scan` and lists recognized unreferenced
MBTiles files with their region, relative filename, size and reader protection.
Only regular files with validated archive names at the data root or in
`versions/<UUID>/` are candidates. Active and previous manifest references are
protected individually: a set can reuse files from several version directories.
Legacy inventories without a manifest remain entirely protected. Unknown paths,
symlinks, partials, metadata, raster caches and empty directories are not deleted.

`Alte Dateien löschen` needs a checked confirmation and the matching completed scan
job, at most one hour old. The API accepts only its job ID and opaque identity,
not caller-provided filenames. The Ops worker transfers the private stored snapshot
to the isolated `cleanup` CLI through bounded stdin (128 KiB). Under exclusive
prepare, storage and reader gates, it rechecks the manifest references, every
approved file's device/inode/size/nanosecond timestamps and current readers before
the first deletion. Changed or newly referenced/in-use files reject the operation.
Only approved files are unlinked, and affected directories are synced. Disk failure
or interruption can leave a partially completed cleanup; rescan rather than reuse
the old approval. Cleanup acquires the storage lock without a capacity reservation
or cache eviction, so it also works above the budget. The public preview omits
file fingerprints; results report the removed file count and bytes.

`Ausmusterung prüfen` queues `maps-retire-scan`. It reads all current GPS workout
bounds through the runtime database pointer in a read-only transaction. When GPS
workouts exist, it fetches the official region catalog and uses the same catalog
validation and polygon/viewport intersection helpers as installation planning.
All intersecting region IDs and their ancestors are protected, including installed
aggregate/parent extracts. Active archives absent from the catalog are also
protected because their geography cannot be established. Unknown workout geography,
an unavailable/invalid catalog, missing/unsupported bounds, invalid archives or
incomplete current tile coverage block retirement. With zero GPS workouts no catalog
is needed. No archive download or HEAD request is made; catalog metadata and full
local checks can still take time.

Only geographically unneeded, known regions proceed to the additional cumulative
tile-removal check. Matching tile coordinates in another archive do not prove
matching geographic content, especially along national borders. This check cannot
override geographic protection: an archive requested by installation planning for
unchanged workout demand cannot be retired just because another archive contains
the same tile rows. The selection is conservative, not a maximum-space optimizer.

`Regionen ausmustern` requires its own fresh completed scan and explicit approval.
Under the prepare lock it rereads current workout bounds and recomputes the exact
candidate set, geographic protection and remaining coverage with a fresh catalog.
The preview records policy version 2 and a private catalog identity; old tile-only
previews are hidden/rejected by the API and execution rejects changed catalog
geometry/hierarchy. After recording/checking archive hashes it
reads the workout inventory once more before activation; changed demand rejects
the approval. It activates a reduced manifest atomically and retains the former
active set as the single rollback target, replacing the older rollback pointer.
An empty active set is permitted when there are no GPS workouts. Retirement deletes
no archives and initially frees zero archive bytes: files retained for rollback
remain protected until a later activation replaces that reference. A subsequent
cleanup scan can then offer unreferenced files. Activation still obeys the existing
manifest storage budget/reserve. Imports are not locked or transactionally coupled
to activation; later/concurrent new demand follows the existing import-demand and
fallback-recovery workflow. The stored demand summary is not rewritten by retirement;
use `Bedarf prüfen` for a refreshed regional display.

**Deploy and restart all cooperating app/worker processes before using cleanup.**
Older renderer binaries do not register readers and cannot be detected by this
protocol. A renderer registers its exact pinned archive list in a private
`.maps-reader-<UUID>.json` while opening SQLite under `.maps-reader-gate.lock`.
Closing a renderer or exiting its worker removes the reservation only after reads
have ended. A crashed process's reservation is ignored only when the OS confirms
its PID no longer exists; permission errors or reused live PIDs remain protected.
Malformed reservations fail closed. Never manually remove a live reservation or
gate. Crashes can leave prepare/storage/reader gates behind; verify process ownership
before operator cleanup. While the short reader gate is occupied, new renderer
startup fails closed through the existing temporary-fallback path rather than
opening files concurrently with deletion. Existing rendering continues.

The four internal commands use the existing serial Ops queue and manual map
deduplication key. Large retirement scans/hash checks can delay backups. Public
API previews redact fingerprints and the opaque workout-inventory hash; they do
not authorize ordinary map downloads. New scans and completed mutations reset UI
approval, and all actions are disabled during a running map operation.

Verification and limitations are recorded in `docs/arbeitsstand.md`. Browser checks
use the actual EJS/controller with simulated APIs, not live Redis or production
deletion. Offline tests use small SQLite archives, real worker threads, real
BullMQ Job instances and CLI subprocesses with bounded stdin.

### Admin Map Demand And Provisioning

### Imported Regional Demand And Optional Automatic Downloads

Successful GPS inserts through both single and bulk workout persistence enqueue
`maps-demand` without awaiting network, planning or downloads. Transactional bulk
overwrites enqueue only after COMMIT; duplicate/rejected inserts enqueue nothing.
This is enabled only for `WOA_THUMBNAIL_MAP_PROVIDER=local`. The existing Ops queue
debounces pending requests by ten seconds using a separate import-demand key;
manual approvals are not reused or swallowed by this key. Active work can finish
and a later job recomputes demand from all currently stored GPS workout bounds.
Jobs have at most three attempts with exponential backoff from one minute.
The ordinary import remains successful if queuing fails; run an admin scan to
recover missed demand. This is best-effort post-commit dispatch, not a transactional
outbox. No schema change or migration is needed.

The isolated CLI `demand` command uses the same runtime database resolver and
read-only transaction as preparation. It fully inspects existing archives and
selects the finest intersecting catalog regions for the rectangular thumbnail
viewport, including its map margin, rather than only the workout's start point.
It never climbs to a parent if a leaf has no directly available Shortbread
archive. Such regions are persisted as `unsupported` with aggregate workout and
missing-thumbnail counts. The existing manual planner retains parent fallback.
The provider's smallest available extract may itself be a whole country where
there are no finer catalog regions; no arbitrary size limit is imposed.

`WOA_MAP_AUTO_DOWNLOAD=1` explicitly enables automatic downloads of missing direct
regions; the default is off. Configure it consistently for cooperating app/worker
processes and deploy/restart them normally before use. No monthly transfer limit
or separate region-size limit is configured. The combined 50%-volume/100-GiB
storage budget and free-space reserve remain mandatory, including staging,
rollback and demand metadata. Missing bounds, unsupported geometry/regions,
archive-count limits, invalid archives or insufficient capacity block automatic
preparation of the entire plan; partial unsupported plans are not downloaded.
An existing invalid archive requires manual recovery, not automatic replacement.
This is checked again under the prepare lock if files change after planning.

Automatic preparation always uses immutable version paths, complete SQLite and
Shortbread validation, current viewport tile checks, hashes, atomic activation
and one previous rollback target. Existing valid archives are reused. Existing
archive updates still require explicit admin installation approval. Successful
and unmarked legacy thumbnails remain unchanged; marked missing-coverage
fallbacks recover on their next actual request after the inventory changes.
No upload/view request downloads archives or starts a bulk thumbnail rebuild.

Aggregated demand lives in `WOA_MAP_DATA_DIR/map-regional-demand.json`, version 1,
with checked time, region counts/sizes, capacity and download state. Writes use
private mode 0600, a synced temporary file, atomic rename and directory sync under
the shared storage lock. It contains no workout IDs, source URLs or credentials.
Symlinks, malformed state and files over 128 KiB are rejected. Redis job expiry
does not remove it. The CLI records the initial plan before downloads and records
success or a safe failure state afterwards; filesystem failure can prevent that
last status write. Exhausted protected storage may also prevent recording fresh
demand. The last snapshot is not a live DB view: GPS edits, deletions, restores,
crashes and missed dispatch may require a fresh admin scan. No periodic demand
reconciliation, archive retirement or UI cancellation is added here.

Admin scans/preparations pass `--record-demand` to refresh this file as well.
Plain `maps:plan` remains read-only. The Admin UI selects the newest available
demand snapshot, shows automatic-download configuration and unsupported regions,
and keeps durable results after queue expiry. A file snapshot never authorizes a
manual download: a fresh completed manual scan/prepare job and explicit approval
are still required. Page load queues nothing. All jobs use the serial Ops worker;
large scans/downloads can delay backups. Worker shutdown may orphan a CLI child,
as with existing operations; verify ownership before removing stale locks.

Verification is recorded in `docs/arbeitsstand.md`. Offline CLI tests use real
small SQLite archives and mocked database/upstream responses, not production
downloads, Redis queue execution or deployment.

### Manual Admin Demand Workflow

Open `/admin/accounts#maps` as an administrator. The existing
`/admin/accounts#local-map-management` link also opens the containing map area.
Administration now uses the same local navigation pattern as user settings:
desktop links, a mobile area select and one visible area at a time; switching
areas preserves approvals, controls and operation updates. See
[administration navigation](user-settings.md#administration-navigation).
The map section
shows region status/size, overlapping workout counts, missing thumbnail counts,
planned archive count, download total and free disk at planning time. Counts across
regions are not additive because a workout may intersect several regions.
Opening the page only reads stored job results; it starts neither metadata checks
nor downloads. There is no automatic scan on upload or page load.

`Bedarf prüfen` explicitly queues `maps-scan`. The existing backup Ops worker runs
the map CLI in a separate Node process with the standard environment file for its
`NODE_ENV`; production still uses the shared runtime database pointer resolver.
Read-only PostgreSQL inventory, regional deduplication, official metadata and
space/archive limits reuse the CLI implementation. Admin scans explicitly run
`plan --quick`: compare file state before/after inspection, read vector-format
metadata and decode one tile to confirm Shortbread layers, without running
`PRAGMA quick_check` over every archive. Catalog/HEAD requests and regional
geometry planning still run; no production timing improvement has been measured.

Sampled archives show `Vorhanden · Stichprobe geprüft`; full integrity checks show
`Vorhanden · Integrität geprüft`. A sample is not a whole-file integrity guarantee.
Plan-only reports leave `missingTileWorkouts` null and explicitly display untested
viewport coverage, rather than claiming zero missing tiles. Older stored region
summaries without an integrity marker retain the neutral `Vorhanden` label.
The ordinary `maps:plan` command remains a full integrity check unless `--quick`
is explicitly requested. `maps:prepare --quick` is rejected before connecting to
the database. Prepare always replans with full inspection, validates new downloads
and verifies actual viewport tiles. Sample inspections never populate the private
full-inspection reuse cache. Full SQLite checks still block the CLI child, not
Express or the Ops worker event loop; individual SQLite calls remain synchronous.

After a complete scan, the admin confirms the listed missing regions/total and
chooses `Fehlende Regionen laden`. Approval covers all missing regions in that
snapshot, not arbitrary supplied URLs or individually selected regions. The API
requires a completed result no older than one hour, exact matching approved IDs,
an explicit confirmation, admin access and an Origin matching the request host.
The prepare subprocess replans and checks `--approved-regions id,...` before any
download: if another missing region appeared meanwhile, it stops for a fresh
scan/approval. Existing valid files are reused; updated HEAD sizes and disk space
still undergo the existing strict checks. No schema migration is required.

API routes under `/admin/accounts/maps`:

- `GET /`: latest map job, last completed demand snapshot and separate persisted
  update report, no-store.
- `POST /scan`: explicitly queue a read-only scan.
- `POST /updates`: explicitly queue metadata monitoring, without downloads.
- `POST /install`: explicitly approve a fresh update snapshot and its eligible regions.
- `POST /rollback`: explicitly approve the expected previous set and active identity.
- `POST /prepare`: confirm a fresh snapshot and its missing region IDs.

Map operations share the existing `postgres-backup-ops` queue and its single
`backup:worker` slot (`start:all` starts it in development). A fixed BullMQ
deduplication key prevents concurrent admin scan/prepare/update requests from creating
duplicate map operations. Backups and map jobs therefore run serially; a long map
scan/download delays other Ops jobs. Without the worker, the UI remains waiting.
The browser polls active jobs every two seconds and displays safe structured
phases, region, counters, download percentages and final coverage problems.
Failures expose only safe stage/code tags, not raw process output. No UI cancel
action is implemented; killing the Ops worker alone may leave its CLI child
running. Verify processes and lock ownership before manual cleanup/retry.

Manual approval job snapshots are derived views: they share
the existing queue retention (up to 24h/50 completed and 7d/100 failed Ops jobs).
They may be evicted earlier by other operations. A separate atomic demand file
now preserves the latest aggregate display, but never grants manual approval.
With no fresh approval job, run a new scan; the durable source remains stored
workout bounds. Incomplete bounds/coverage or
archive-limit problems block prepare, as in the CLI. Existing-image preservation
and on-demand recovery of marked fallbacks are unchanged. This provisions missing
regions, not replacement updates to valid existing archives, and does not change
provider flags or restart application processes.

Verification after the quick-scan change: all 836 tests passed, including 57
focused admin/provisioning cases. Tests confirm that sample inspection skips
`quick_check` while retaining format/tile checks, direct preparation of a sample
plan performs full inspections, admin scan/prepare select the correct CLI modes,
and `prepare --quick` is rejected. An isolated real CLI quick scan reuses existing
archives with `quick_check` deliberately made unavailable and performs no download.
Tests cover summaries/privacy, admin/Origin guards, fresh approval, deduplication,
UI capacity/confirmation controls, safe child progress/failures and a real isolated
CLI subprocess refusing new unapproved demand before GET. Syntax/lint passed
(70 existing warnings), and full type checking passes without errors. The actual
EJS map section and browser module were checked at 1365px desktop and 390px mobile
with simulated reports: sample/full integrity labels, unknown coverage even in
error reports, approval gates, two icons, contained mobile table scrolling and no
page overflow; screenshots inspected. No production/Redis operation, real archive
download, migration or
normal Dev backend restart was performed by Copilot. The isolated UI test server
was stopped after verification; live authenticated Ops execution remains untested.

### Integration Verification

The initial integration passed all 771 tests, including 32 focused thumbnail/worker tests. Temporary
MBTiles fixtures exercise persistent cache reuse, corruption repair, style
isolation, limits, missing coverage, real worker reuse, bounded queueing, failure
recovery and timeout. Service tests cover local selection without external calls,
existing-image preservation and the actual library observer/visibility methods.
Syntax and focused lint passed with one pre-existing unused-import warning;
typecheck retains only three known `lastEnd` nullability errors in
`src/shared/MicroIntervalDetector.js:141`. Production-style dependency-resolution
dry-run passed; Linux ARM64 runtime/native packages remain untested.

A real Dev check created previously missing thumbnail `84965` exactly once:
local map, 20,435-byte SVG, committed storage. A second call returned identical
content and unchanged timestamp with no additional render. Existing thumbnail
`85063` remained unchanged; no thumbnails were deleted.

Authenticated live scrolling then generated and persisted local maps for the
previously missing `84964` and neighboring `84963` (23,583/24,760 bytes).
Repeated uncached HTTP reads returned identical content with unchanged database
timestamps. Of 96 list images, only 14 were requested during the tested scroll;
the far-end entry retained no `src`. Image decode, hidden-placeholder state,
320x200 dimensions and nonblank/colorful canvas pixels passed; the desktop
thumbnail screenshot showed the route and visible attribution.

The integrated browser pauses IntersectionObserver callbacks while its document
is hidden; making the page visible resumed normal loading without code changes.
At 390px viewport width the thumbnail decoded and retained its 16:10 footprint
(about 111x69px), but the dashboard had horizontal overflow (546px document width).
This broader layout issue was not changed. A mobile thumbnail screenshot could
not be captured reliably after the automation scrolled it horizontally outside
the viewport; mobile verification is limited to DOM/decode/size checks.
The original desktop viewport and 24-entry page preference were restored.
No EC2 access, deployment or migration was performed.

## Persisted Geoapify Route Thumbnails

GPS thumbnails now support a server-generated Geoapify background. This is separate
from both the interactive maps and the existing MapTiler flyover. Set
`GEOAPIFY_API_KEY` in the relevant server environment, then restart the app and
workers. Development configuration does not configure production. Never commit
keys or put them in browser configuration, logs, or generated SVGs.

The provider receives a viewport center and zoom, not the workout file or full
GPS route. `GeoapifyThumbnailClient` requests one 320x200 PNG, validates its MIME
type, dimensions and decoded format, then uses Sharp to produce a muted WebP at
quality 55. The 256x160 SVG embeds that image as a data URL. Routes, GPS gaps,
colored segment overlays and endpoint markers stay vector-based, using matching
Web-Mercator projection and sub-pixel simplification. A reserved attribution area
includes OpenStreetMap contributors, Geoapify and OpenMapTiles, inset to survive
the existing clipped 1.08 image zoom. No external image URL is needed to display
the saved SVG. Indoor and non-GPS profile thumbnails retain their previous path.

### Durable Cache And Concurrency

- The entire SVG, including the raster background, is stored in the existing
  `workout_thumbnails.content` column. No schema migration is required.
- Import jobs, on-demand generation and manual/copied GPS updates use the same
  `getOrCreateThumbnail` persistence boundary. It takes a PostgreSQL
  transaction-scoped advisory lock per workout and rechecks the saved thumbnail
  after acquiring it. Concurrent processes reuse the winning result.
- The upsert is committed before the result is returned. In-flight promises also
  coalesce same-process requests; at most six generation jobs per process hold
  database connections. The per-workout lock wait is 30 seconds to accommodate
  a 15-second provider request plus bounded queueing and encoding. This replaces
  the former write-behind persistence.
- Route style version 3 invalidates older route thumbnails lazily when requested.
  There is no bulk regeneration job. Matching saved map images are reused without
  new provider calls, including after process restarts. Visual style version 3 is
  unchanged by the retry correction, so successful maps are not regenerated.
- Missing credentials, unavailable Redis, exhausted budgets, excessive queueing,
  invalid geographic bounds, timeout, provider errors or invalid images use the
  original route-only SVG. That fallback is also saved, but normally retried on
  its next request after five minutes, not on every view. New fallbacks embed a
  safe `data-map-fallback` code and `data-map-retry-at` UTC epoch-millisecond
  deadline. Daily-budget exhaustion and HTTP 429 defer until the next UTC day.
  Older fallback SVGs without these attributes expire five minutes after their
  database `updatedAt` timestamp. Provider cooldowns and budgets still guard retries.
- Successful maps and profile thumbnails retain one-year immutable browser
  caching. Route fallbacks use `private, max-age=60`. The separate URL parameter
  `cache=1` bypasses previously immutable fallback responses without changing the
  visual style version. Restart running app/worker processes and reload the page
  after updating the code. No periodic browser polling or background job is added.
- Manual GPS changes intentionally replace the old thumbnail because it depicts
  a different route. Existing authenticated access checks remain in place. GPS
  files, workout streams and recorded elevations are not modified.

### Free-Tier Budget And Failure Limits

Geoapify currently advertises 3,000 free credits per day; static maps consume a
request credit plus tile credits. Credits are not equivalent to images. See the
[pricing](https://www.geoapify.com/pricing/) and
[static-map storage and attribution rules](https://www.geoapify.com/static-maps-api/).
The implementation does not upgrade a plan or configure payment.

The Free plan advertises up to five requests per second, but its FAQ defines
rate limits in credit-equivalent requests rather than treating every API call
as equally expensive. For this fixed 320x200, unpitched, marker-free request,
we conservatively reserve three credits per attempt. The provider calculator's
tile formula is explicitly only an estimate; this is a local reservation, not
an exact provider charge. See [credit calculation](https://www.geoapify.com/pricing-details/).

`GEOAPIFY_DAILY_MAP_LIMIT` defaults to 1,000 images per UTC day and is capped at
1,000 (3,000 reserved credits); set it to `0` to disable new provider requests.
An explicitly configured lower image cap remains in effect. Redis atomically
reserves each attempt, including failed attempts, and schedules starts at least
600 ms apart (five reserved credits per second), with a bounded three-second
wait. Six parallel generation jobs per process allow slow responses to overlap
while leaving four connections in the default ten-connection database pool for
other operations. The existing daily counter and rate/pause keys are preserved
across the change, without resetting usage. Counters and provider cooldowns are
shared by the SHA-256 hash of the API key, without storing the key in Redis.
All processes sharing a key must use the same Redis backend for a common budget.
Separate Redis instances, Redis data loss and unrelated use of the same provider
account are outside this guard; monitor the provider dashboard. This conservative
image budget is not a provider-enforced credit or billing guarantee.

The image response is limited to 512 KiB, network/body reading to 15 seconds,
and WebP processing to two seconds. The network timer is cleared after the body
has been read. Redirects are rejected. One timeout or other failed attempt only
defers the affected thumbnail for five minutes; other workouts may still fetch
maps. Three consecutive failures in one client process open a shared five-minute
pause via Redis. A successfully encoded map resets that process's failure count.
HTTP 429 opens the shared pause immediately until the next UTC day. Logs include
`consecutiveFailures` and `globalPause` to distinguish individual failures from
shared pauses. Existing persisted cooldowns and fallback deadlines expire normally;
this change does not clear or bypass them. Redis failures fail closed rather than
making unmetered provider requests. Sharp uses
native image-processing packages; its macOS installation was verified here, but
the production Linux ARM64 installation has not been exercised in this change.

Actual provider/network/image-processing failures emit `console.warn` under
`[thumbnail] map.failed`, including workout ID, a safe reason such as `http-503`,
`timeout`, `invalid-image` or `budget-unavailable`, HTTP status when available,
and the next attempt time. The cooldown suppresses repeat warnings for skipped
attempts. Unexpected renderer exceptions emit `[thumbnail] map.render.failed`.
Persistence logs also include the fallback reason and retry deadline. API keys,
request URLs, response bodies and raw exception text are never logged. A closed
Redis connection can be recreated on a later controlled retry.

### Verification

The Free-quota update passed all 763 tests, syntax checks, service lint and patch
whitespace validation. Regression tests cover the 1,000-attempt default/cap,
lower configured limits and six overlapping generation jobs with the seventh
queued. An isolated real-Redis check verified 600-ms slot spacing, bounded queue
rejection, acceptance of attempt 1,000 followed by rejection, and shared pause
enforcement. Only random test-key counters were changed and removed afterward;
no provider requests or thumbnail writes were needed for this verification.

On 2026-11-04, three real Dev workouts were generated and persisted: 85063,
85057 and 83899, with complete SVG sizes of 18,440 / 17,698 / 14,358 bytes. Exactly
three Geoapify requests returned PNGs successfully. Repeated generation/cache
checks caused zero further requests; a concurrently started separate Node
process reused workout 85063 with zero provider requests. These three Dev
thumbnail rows were intentionally updated; no migration or production write ran.

The ignored `tmp/geoapify-thumbnail-check.mjs` verifies the saved content and serves
the generated images at `http://127.0.0.1:3109/` while running. Browser screenshots,
successful image decoding, nonblank/color pixel checks and attribution bounds
were checked with desktop and 390px mobile layouts at the representative
152x95 and 128x80 thumbnail sizes. This was an isolated browser preview, not an
authenticated end-to-end workout-library or production-worker test.

The retry correction was also verified against workout 85045: its expired style-3
fallback was replaced by a persisted 16,793-byte map SVG using one provider request;
the next generation call reused it with zero additional requests. No provider
budget or pause was bypassed, and no production write or migration was performed.

All 761 tests passed after the timeout/circuit correction, including isolation of
a single timeout, successful failure-count reset, the three-error threshold,
immediate HTTP 429 pausing, safe logging and durable map reuse. No additional
live provider request was needed for these behavior-scoped checks.
Lint of the two thumbnail services passed; earlier targeted lint reports two existing
unused-import warnings in the workout routes. The typecheck still reports the
three pre-existing nullable `lastEnd` errors in `MicroIntervalDetector.js:141`.
The dependency installation also reported eleven audit findings (eight moderate,
three high); no unrelated dependency upgrades or automatic audit fixes were run.

## Local Regional OSM Thumbnail Prototype

On 2026-11-05 the user approved an isolated Dev prototype covering
Baden-Wuerttemberg and Hessen. No production integration or upload was approved.
Artifacts live under ignored `tmp/local-map-prototype/`, not in the application
or a tracked reusable tool. Keep that directory to retain the prototype; its
source and downloaded files are not included in deployments.

Geofabrik already publishes experimental Shortbread 1.0 vector tiles, so this
prototype downloads MBTiles directly instead of generating PMTiles from PBF.
Both are local vector-tile archives; MBTiles uses SQLite, which the installed
Node 26.4.0 can read without another database service. Regional downloads:

- `https://download.geofabrik.de/europe/germany/baden-wuerttemberg-shortbread-1.0.mbtiles`
- `https://download.geofabrik.de/europe/germany/hessen-shortbread-1.0.mbtiles`

Downloaded file sizes are 560,644,096 bytes (534.7 MiB) and 427,806,720 bytes
(408.0 MiB), totaling 988,450,816 bytes (942.7 MiB). These are measured archive
sizes, not RAM requirements or estimates for other regions. Replacement downloads
may differ; the initial HEAD probes already observed an upstream version change.
Downloads stream to `.part` files, check the announced length and rename on
success. Length and SQLite quick_check are not cryptographic source verification.

### Local Operation

From the repository root, with the existing ignored prototype files present:

```bash
npm ci --prefix tmp/local-map-prototype --ignore-scripts
node tmp/local-map-prototype/setup.mjs
node tmp/local-map-prototype/setup.mjs --download
node --test tmp/local-map-prototype/render-cache.test.mjs
node tmp/local-map-prototype/preview.mjs --build-only
node tmp/local-map-prototype/preview.mjs
```

The setup command without `--download` only probes remote sizes and modification
times. The preview binds to `127.0.0.1:3110`; override `LOCAL_MAP_PREVIEW_PORT`
when that port is occupied. `Ctrl+C` stops it. The private dependency tree contains
`@mapbox/vector-tile`, `pbf` and `simplify-js`; Sharp is reused from the app.
Root package files and npm scripts are unchanged.

The preview guards localhost and `cwa24_dev`, reads the three known GPS routes
under `BEGIN READ ONLY`, and closes the DB pool before rendering. It does not
call persisted-thumbnail generation or overwrite existing database thumbnails.
Reports and example SVGs are written only under the prototype's `data/` folder.

The renderer opens both tile archives with SQLite `readOnly: true`, decodes
MVT/gzip, fits Web-Mercator bounds and paints land, woods, water, road classes,
boundaries and basic collision-filtered town labels through SVG/Sharp. It is an
OSM-like custom style, not the original OpenStreetMap Carto style. It embeds a
320x200/Q55 WebP background, a simplified vector route with GPS gaps/endpoints,
and visible `OpenStreetMap contributors` attribution. Tile parsing and RDP use
existing libraries. No external tile, font, style or image fetch is needed during
rendering. Both regional files are read at boundaries; buffered regional coverage
is not a guarantee of complete mapping outside the chosen states.

### Initial Vector-Only Measurements

| Workout | Distance | Complete SVG | First pass | Warm median, 5 repeats |
| --- | ---: | ---: | ---: | ---: |
| 85063 | 28.3 km | 15,525 bytes | 371 ms | 325 ms |
| 85057 | 48.0 km | 14,793 bytes | 569 ms | 568 ms |
| 83899 | 95.2 km | 21,213 bytes | 514 ms | 504 ms |

Mac measurements include tile reads, decoding, styling, WebP encoding and SVG
assembly, but not route DB retrieval. First pass does not mean cold OS caches.
End-of-run RSS was roughly 350 MiB after sequential repeats, not a measured peak.
Sharp caches are disabled and its concurrency is one in this isolated process;
the initial default-cache experiment retained roughly 1.4 GB. Never extrapolate
these figures to simultaneous EC2 requests without a separate memory/load test.

Both archives passed SQLite quick_check. Offline smoke tests rendered Stuttgart
and Frankfurt with fetch disabled and rejected a route outside local coverage.
All three real examples had zero missing tile positions. Desktop 1280x1100 and
mobile 390x1100 browser checks verified nine decoded images, nonblank colored
map/route pixels, 152x95/128x80 small frames, screenshots and no horizontal
overflow or overlapping figures. Browser reload made zero external requests.
Only a basic cartographic subset is implemented: no hillshade, sophisticated
label placement, complete bridge ordering, segment-colored overlays, production
queue, automatic provider fallback or workload isolation.

### Reusable Raster Tile Cache

The approved follow-up caches map geometry as fixed 256x256 lossless PNG tiles,
not workout-specific crops. `render()` uses these by default; pass
`{ rasterCache: false }` for the vector-only baseline. Tile PNGs contain no route
or baked-in town labels. Label candidates are stored alongside the image and
placed after crop/resize, preventing labels from being cut at tile boundaries.
Routes, endpoint markers and attribution stay in the final SVG overlay.

The preview writes `data/preview-raster-cache/<source-style-id>/<z>-<x>-<y>.json`.
The renderer's standalone default is `data/raster-cache/`. The version ID covers
the explicit style identifier, archive identity (device/inode/ctime), size and
mtime. Restart the renderer after replacing archives, and bump `cacheVersion`
when changing tile appearance. A final thumbnail is assembled from four to six
tiles in these examples, including both regional sources in overlap areas.

Entries are written to unique `.part` files and atomically renamed; image
checksums and PNG format/dimensions are validated on disk reads. Corrupt entries
regenerate. An estimated-payload 16-MiB RAM LRU avoids repeated reads; completed
disk entries are pruned by last-use mtime to 128 MiB **per version directory**.
These are not total process-memory or whole-cache-root limits. Obsolete version
directories and earlier experimental caches are retained and require manual
cleanup; concurrent writes can temporarily exceed the completed-entry limit.
Same-process concurrent requests share one in-flight tile build. Cross-process
build deduplication and a production generation queue are not implemented.

Every preview start intentionally benchmarks the baseline, forces all relevant
tile builds, clears RAM before disk reuse, then measures five RAM repeats. This
is a benchmark mode, not the normal lazy-cache strategy for production. The
latest local run measured:

| Workout | Vector only | Forced build | Disk reuse | RAM median, 5 repeats |
| --- | ---: | ---: | ---: | ---: |
| 85063 | 359 ms | 401 ms | 89 ms | 15 ms |
| 85057 | 581 ms | 689 ms | 94 ms | 17 ms |
| 83899 | 504 ms | 588 ms | 58 ms | 18 ms |

RAM reuse was about 24-34 times faster than the same-run vector-only baseline.
Disk reuse means an empty renderer RAM cache, **not cold operating-system disk
caches**. First tile creation remains slow; fixed-grid tiles can be reused by
other workouts and can be warmed separately. No EC2 throughput claim is made.
The sixteen tiles generated for these three examples occupy 1,699,736 bytes
(1.62 MiB), including base64 PNGs and label metadata. This is not a storage
estimate for prerendering both entire states. Final SVG sizes are now
12,325 / 14,217 / 20,561 bytes.

Four focused tests passed for persisted reuse across renderer recreation, RAM
hits without vector rendering, corruption recovery, shared parallel builds,
version separation, memory/disk bounds and offline region behavior. They use
temporary private cache directories and the downloaded archives read-only.
Pixel comparisons catch RGB/RGBA channel errors; Sharp's composite raw output
can have four channels even when its initial canvas had three, so the actual
output channel metadata must be carried into the next raw-image pipeline.

The updated preview passed desktop 1280x1100/mobile 390x1100 screenshots, nine
image decodes, nonblank map/route pixels, no overlapping figures or horizontal
overflow, and zero external requests on reload. Fixed-resolution tile resampling
slightly changes appearance: mean RGB differences versus the vector-only SVGs
were 7.07 / 4.39 / 5.38 on a 0-255 scale, not pixel-identical rendering.
Existing application code, persisted thumbnails, root dependency files and EC2
remain unchanged. The cache and its tests are disposable ignored Dev artifacts.

For future updates, prefer versioned archive sets built/downloaded separately,
validate both regions, then atomically switch a manifest to the new pair and
reopen read-only handles. Keep the previous pair for rollback. Budget roughly
1.9 GiB for two copies of these measured archives, plus application/DB reserve.
The setup downloader is a prototype, not an automated production update manager.
Existing successful workout thumbnails would stay unchanged after a data update.
OSM data is ODbL 1.0; retain attribution and review database redistribution duties
before publishing modified archives. Geofabrik attribution is shown in the preview.

Read-only EC2 inspection before this prototype found one persistent 30-GB root
filesystem with about 24 GB free and PostgreSQL at `/var/lib/pgsql/data` on it.
A possible future location is `/home/ec2-user/woa-map-data/`, separate from Git
and PostgreSQL's own directory. Nothing was created there. No production request,
deployment, schema migration or service restart was performed for this prototype.

## GPS Thumbnail Visual Prototype

On 2026-11-04 the user requested a small rendered comparison before deciding on
production integration. The disposable, ignored local artifact
`tmp/workout-map-thumbnail-preview.mjs` runs with
`node tmp/workout-map-thumbnail-preview.mjs` at `http://127.0.0.1:3108/` while this
session's server is running; it is not a tracked production tool or npm script.
It guards local `cwa24_dev`, queries under `BEGIN READ ONLY`, decodes GPS with the
existing service and rerenders the current route-only SVG style without segment
overlays. Existing persisted thumbnails and application behavior are untouched.

Examples are workouts 85063, 85057 and 83899 (28.3, 48 and 95.2 km). The proposed
variant fits actual Web-Mercator bounds and embeds a muted 512x320 WebP map at
quality 0.78 inside a 256x160 SVG, keeping route/markers as vector overlays. It
does not create Leaflet/MapLibre instances. One user-requested browser view uses
6, 6 and 9 OSM tiles respectively, normal HTTP caching and visible attribution;
it is not a bulk generation path. Provider approval/terms, cache design, segment
overlays and production persistence remain separate implementation decisions.

Self-contained SVG sizes are 42,803 / 50,575 / 65,548 bytes, versus current-style
2,340 / 3,877 / 3,787 bytes. Initial PNG embedding was 355-446 KiB and was replaced
with WebP. Browser rebuild times of 34 / 22 / 26 ms use already cached tiles and
are neither cold-load nor server-generation benchmarks. Screenshots at desktop
1280x1300 and mobile 390x1100, successful decoding of all six images, nonblank
canvas pixels/visible route pixels, and absence of horizontal overflow were
verified. No complete library rollout, database write or migration was performed.

### Native-Size Optimization

The user subsequently requested optimization for the actual workout UI. A browser
fixture using the unmodified dashboard CSS measured 152x95 CSS pixels on desktop
(`9.5rem` at a 16px root). At a 390px viewport with a 360px card, the responsive
grid measured 127.98x79.98. Mobile width depends on available card width, not a
universal fixed 128px value. Existing images use `transform: scale(1.08)` and a
clipped shell; the preview now reproduces the zoom and representative dimensions.
This was a CSS fixture measurement, not an authenticated live library session.

The comparison now includes the route-only SVG and three map variants. They share
the same geographic crop and vector route. The route uses the existing thumbnail
service's iterative RDP strategy, adapted to Web-Mercator screen coordinates with
0.45 logical-pixel tolerance, one-decimal coordinates and one defs/use path for
the outline and colored stroke. GPS gaps and endpoint markers are retained.
Input/output point counts are 650/55, 1,329/141 and 2,146/129 respectively. This
also reduces the reference variant; changes are still confined to the prototype.

Complete self-contained SVG sizes (UTF-8 bytes, not compressed HTTP transfer):

| Workout | Route only | 512x320/Q78 reference | 320x200/Q55 | 160x100/Q50 |
| --- | ---: | ---: | ---: | ---: |
| 85063 | 2,340 | 25,465 | 9,621 | 4,897 |
| 85057 | 3,877 | 23,198 | 9,346 | 5,382 |
| 83899 | 3,787 | 27,975 | 10,779 | 5,643 |

The 320x200/Q55 version is the recommended visual compromise for the approximately
152x95 display and high-density screens: about 77-84% smaller than the original
42,803-65,548-byte map draft. The 160x100/Q50 version saves more (about 89-91%),
but its background labels are visibly softer on high-density screens. Both keep
the route vector-based and sharp. These three samples are not a general size cap.
The original UI zoom can crop edge content: retain visible provider attribution
outside the clipped image or within a safe inset in any production integration.

Verified desktop 1280x1000 and mobile 390x1100, DPR 1/2, screenshots and decoding
of all twelve images. At 152x95, route-colored pixel counts match across the three
background variants for each workout (157, 331 and 351); backgrounds are nonblank.
No horizontal or caption overflow was found. Syntax validation passed. No
application CSS, production thumbnail service, existing thumbnail rows or
migrations were changed. The local preview remains at port 3108.

## Interaction and Failure Handling

`MapView` owns the shared workout, GPS sample indexing, segment visibility,
selection and chart-position state. `WorkoutTerrainView` renders those values
without connecting to workout APIs itself. GPS gaps remain separate lines.
Segment colors, hover, selection and the chart-position marker work in both
views. Selected 3D segment popups use visible track points to avoid clipping
outside the map on narrow viewports.

Chart segment-header hover now updates both the workout segment list and the
map's route highlight, matching the existing list-hover behavior in Leaflet and
MapLibre. Mouseout removes only the temporary hover; an existing segment
selection remains highlighted. The map hover methods do not emit another chart
hover callback, avoiding feedback loops.

Both renderers share short segment labels (`S-42`, `CP4`), type colors, CP color
markers, optional names, minimum projected path length and overlap suppression.
`MapView.getVisibleSegmentLabels` selects candidates using each renderer's own
screen projection. Leaflet still uses its existing noninteractive label markers;
MapLibre uses noninteractive DOM markers that follow the terrain. Labels are
recomputed on render, camera move end and resize. Existing MapLibre label markers
are reused, and stale labels are removed after visibility/workout changes or
terrain failure. Labels themselves do not intercept route clicks or GPS editing.

Leaflet labels use a dedicated noninteractive `segmentLabelPane` at z-index 575,
above the route (400), segments (500) and temporary/selected highlights (550).
This prevents highlight strokes from painting over labels. Shared Leaflet and
MapLibre label backgrounds have 78% white opacity and 2px background blur;
text and CP markers retain full opacity.

ECharts segment-header background rectangles, CP dots and text each carry an
explicit `z` of 120 plus their lane. A `z` on the graphic group alone does not
raise its children in the checked ECharts renderer. Background opacity is 52%
normally, 78% when highlighted/selected and 84% under the pointer. Text and CP
dots remain fully opaque; interaction and route-highlight behavior are unchanged.

Switching keeps the center and approximately equivalent zoom (Leaflet and
MapLibre use different base tile sizes). The 3D camera starts at a 60-degree
pitch and can be rotated or tilted with MapLibre navigation. Map style choices
are available only in 2D.

## Server-Side Renderer Preference

All three pages use the existing authenticated `/api/view-preferences/:viewKey`
GET/PUT path. The optional `mapRenderer` field accepts only `2d` or `3d` and is
stored in the existing JSON preference state in `user_view_preferences`:

- Workout detail: `workout-library` view key.
- Segment page: `segments` view key.
- Analytics workout detail: `analytics` view key.

The choices are independent per user and per view. Existing filter/chart state,
debounced saves and page-leave flushing remain in use. No schema change or
migration is required. Missing or unsupported server choices default to 2D;
existing browser state remains only the fallback when preferences cannot load.
Map center, zoom and 2D base style keep their existing local persistence.

Only explicit renderer choices schedule a preference save. Restore, unsupported
workout GPS/permissions and terrain/WebGL failures do not replace the preferred
renderer. A restored workout preference waits for eligible workout data. Moving
to an ineligible workout temporarily shows 2D; a subsequent eligible workout
reactivates 3D. A failed terrain instance is not automatically retried; the user
can retry 3D or explicitly choose 2D to change the preference.

## Shared Terrain Hit Testing

Both terrain views now use the same projection and line-distance implementation
in `WorkoutTerrainView`. Instead of asking MapLibre which rendered feature lies
under the mouse, the application projects the current segment paths into CSS
pixel coordinates with `map.project`. It finds the nearest line portion within
9 pixels of the pointer. This covers the existing 18-pixel hit-line width and
stays constant on screen when zoom, pitch or bearing changes. GPS gaps and
invalid points are never joined for hit testing. Cached projections invalidate
on camera movement, terrain/map rendering, resize and segment-data rendering.

Workout hover listens to map-wide mouse movement rather than native layer-hover
events. Hover and click use the same hit result, keeping the cursor, route
highlight and existing chart/list callbacks consistent even if native terrain
picking misses. Leaving a segment/map clears only temporary hover; the selected
segment remains. Clicking a selected segment still toggles it off, and a
background click uses the existing clear-selection path. Manual GPS drawing
takes priority and keeps its crosshair/click-to-append behavior. The segment
page additionally retains its endpoint-marker priority.

Workout regressions cover nearest overlapping paths, GPS gaps, invalid points,
cache reuse/invalidation, hover/selection callbacks and GPS drawing priority.
The isolated preview verified real canvas events at zoom 14/pitch 75 and zoom
15/pitch 80/bearing 40, plus normal-angle recovery, hover-end selection retention,
second-click deselection, background clicks, GPS draft points and nonblank
canvas pixels. This confirms callback forwarding, not an authenticated complete
dashboard/chart pointer round trip. No routing or database writes were run.

## Analytics Workout Detail

Analytics uses the same `MapView` and `WorkoutTerrainView` as the workout page,
including projected hover/click hit testing, segment labels, chart-position
markers, terrain sources and automatic Leaflet fallback. Its read-only detail
map does not introduce GPS editing or change the existing chart/map callbacks.

The CP legend continues to filter the same workout segments for both chart and
map. Renderer changes preserve the selected workout and CP filters; chart and
filter preference updates preserve `mapRenderer`. Restoring a saved 3D choice
waits until a GPS workout is selected and does not schedule another save.

Workouts without valid GPS retain the existing hidden-map layout. Before fitting
a newly revealed workout map, Analytics refreshes its dimensions so Leaflet does
not supply a stale zero-size camera to terrain. Returning to a GPS workout
reactivates a preferred 3D renderer without replacing the saved preference.

## Segment Page

`SegmentTerrainView` reuses the terrain sources, camera switching, draft drawing,
position markers, label markers and failure handling of `WorkoutTerrainView`.
Its segment-specific interactions preserve the existing controller callbacks:
line clicks select/open the segment, and start/end markers retain their distinct
actions. Tracks use the same cached smoothing as Leaflet. Selected routes are
highlighted, tooltips escape location names, and short `S-42` labels suppress
short, overlapping and offscreen candidates, prioritizing the selected segment.

Segment hover and clicks share screen-space hit testing using `map.project`
on the same smoothed track used for rendering. In the MapLibre 4.7.1 preview,
`queryRenderedFeatures` missed visible, pixel-confirmed route positions at zoom
14/pitch 75 and zoom 15/pitch 80, and also reported a false hit away from the
route. Its results are therefore not authoritative for segment selection.
The nearest projected line within 9 CSS pixels is selectable, matching half
the existing 18-pixel hit-line width. Start/end markers take priority within
their visible radius plus stroke (8 pixels normally, 10 when selected).
Outside those distances there is no selection or pointer cursor. Invalid track
positions are skipped without connecting across the invalid entry. Projection
geometry is cached and invalidated on camera movement, map render/resize and
segment-data rendering, including updates after terrain tiles load.

Focused regression tests cover missed and false native hits, endpoint priority,
distance limits, filtered/invalid tracks, shared cursor/click handlers and cache
invalidation. The isolated browser preview verified actual canvas mouse events
at zoom 14/pitch 75, zoom 15/pitch 80/bearing 40 and zoom 13/pitch 60, as well as
start/end actions and an outside-route click. This was synthetic preview data,
not an authenticated production segment-page test. The segment-specific endpoint
logic uses the shared terrain projection/line-distance core described above.

Viewport queries, including filter/favorite reloads, use bounds from the active
renderer. Terrain camera changes also update the existing local camera state
using the Leaflet-equivalent zoom. The elevation-profile position marker is
shared. Navigation and attribution appear on the left in this view so the
existing right-hand detail overlay cannot hide them.

The 2D/3D switch stays accessible during routing-point selection. Terrain clicks
append to the same `lookupPoints` array as Leaflet, and both views keep the draft
when switching. MapLibre shows a dashed connecting line and green/blue/red draft
points; this is not live routing. Lookup still uses `/segments/track-lookup` with
the existing start/waypoints/end/points payload and success/failure behavior.
Double-click zoom is temporarily disabled while selecting. Clearing or cancelling
selection updates both maps; a terrain failure retains the active draft.

## GPS Editing in Both Views

The existing GPS menu is available under the same ownership/data restrictions:
the current user must own the workout, and it must either lack valid GPS or use
the `manual_lookup` GPS source. Imported valid GPS tracks are not made editable.
The menu's GPX import (direct or routed) and copy-from-workout actions still use
their existing handlers and APIs, independently of the active map renderer.

Manual GPS editing now stays in the selected renderer. In MapLibre, clicks on
the terrain append lookup points to the same `MapView.manualGpsPoints` draft
used by Leaflet. A dashed line joins them; first, intermediate and last points
are green, blue and red. This is a draft connecting lookup points, not a live
routing preview. Existing routing/persistence remains in the shared save path;
MapLibre does not introduce another routing service or elevation write path.

The existing clear, cancel and save controls work in either view. Switching
between 2D and 3D preserves the draft. Clear removes the draft points but keeps
editing active; cancel discards the draft, and successful save ends editing.
Failed saves keep the draft. Selecting another workout discards the previous
unsaved draft. Moving or individually deleting points is not added here; this
change reproduces the existing click-to-append and clear-all behavior.

3D is also available for owned workouts without GPS so a new track can be drawn
there. Workouts without valid GPS and without edit permission still cannot use
3D. While editing in MapLibre, clicks take priority over segment selection,
the cursor is a crosshair and double-click zoom is temporarily disabled. The
previous double-click zoom state is restored when editing ends. A terrain
failure can still fall back to Leaflet without discarding the active draft.

Startup errors, source errors, WebGL context loss or a 20-second initial load
timeout return to Leaflet and show a localized status message. 3D can be retried.
Returning to 2D retains the existing terrain instance for reuse; shared data and
fit updates are skipped while it is inactive, but already-started tile requests
may finish.

## Verification

- The Analytics integration passes 117 focused Analytics, map, view-preference,
  hover/visibility and CP-header tests. Added coverage checks its default and
  server normalization, independent per-user/per-view storage, controller
  restore/save, preservation across chart preferences, shared chart/map CP
  filtering and map sizing before track fitting. Syntax and targeted ESLint pass
  with two existing controller warnings; types retain the three known nullability
  errors in unchanged `MicroIntervalDetector.js:141`.
- An isolated Analytics preview used its actual EJS/CSS, real map libraries,
  synthetic workouts and simulated preference APIs. Desktop and 390 x 844 mobile
  screenshots and canvas pixels confirmed terrain, labels, position markers,
  controls without overlap and no horizontal overflow. Real canvas hover/click
  worked at zoom 14/pitch 75/bearing 40. Switching, CP filtering, non-saving
  restore and no-GPS/eligible-workout transitions also passed, including camera
  framing after revealing the map. This is not an authenticated Analytics/chart
  pointer end-to-end test; no real preference or workout writes were performed.
- The preceding combined workout/segment map, view-preference, hover/header, track-rendering,
  best-effort-paging and UI-state checks passed 84 tests. Coverage includes
  per-user/per-view storage, invalid/legacy values, both controller restore/save
  paths, delayed workout availability, non-persisting fallbacks, segment endpoint
  actions, labels, active bounds/camera switching and tooltip escaping.
- The segment preview used the actual EJS template/CSS, real map libraries and
  synthetic segments with simulated query/routing responses. It verified canvas
  line/start/end clicks, profile-position markers, camera rotation, desktop
  screenshot and nonblank pixels, left-side controls/attribution, three routing
  points with one waypoint, draft preservation across switches, successful draft
  cleanup and non-persisting failure fallback. Mobile DOM/canvas checks at
  390 x 844 confirmed nonblank pixels, labels/marker and no horizontal overflow.
  Mobile screenshots were attempted, but the integrated browser clipped their
  raster output even in an isolated tab; full mobile visual inspection remains
  a user check. The hidden-tab animation-frame workaround was preview-only.
- No authenticated end-to-end preference save/reload, real routing or database
  write was performed. The full suite was not run. Syntax and targeted ESLint
  pass (seven existing warnings); type checking remains blocked by three known
  nullability errors in unchanged `MicroIntervalDetector.js:141`.
- Focused tests in `tests/map-segment-label.test.js` cover existing Leaflet labels,
  GPS gaps, coordinate order, shared route/segment/focus/marker state, WebGL
  fallback, in-place switching, edit permissions, inactive rendering,
  terrain configuration and compatibility with the current MapLibre version.
- Additional editing tests cover terrain click forwarding, draft geometry and
  colors, navigation restoration, common save/GPX handlers, failed-save draft
  preservation, clear/cancel behavior and workout-switch draft cleanup.
- Hover/label regressions in the existing map-label and segment-visibility tests
  cover the actual chart callback's enter/leave behavior, restoring selection,
  shared overlap/short-path/offscreen filtering, terrain-projected CP labels and
  marker reuse/removal. Existing CP chart-header tests remain unchanged.
- An isolated local browser preview with the real map modules, public tile
  services and a synthetic Innsbruck track verified desktop/mobile rendering,
  screenshots, nonblank canvas pixels, terrain activation, position markers,
  segment selection, center-preserving switching and workout/no-GPS changes.
- This preview is not an authenticated end-to-end dashboard test. The complete
  dashboard layout, real workout data and real chart pointer interaction still
  need a user check in the running application.
- The editing preview also verified simulated mouse events through the real
  MapLibre canvas handlers, draft preservation across renderers, a simulated
  save handler, and desktop/mobile screenshots and nonblank canvas pixels.
  The shared browser tab was hidden; a preview-only timer-based animation-frame
  shim allowed rendering during this check. Application code was not changed
  for that workaround. No live routing, GPX upload or database save was run.
- The hover/label preview verified `S-1` and `CP4`, camera changes, desktop/mobile
  screenshots, nonblank canvas pixels and nonoverlapping labels in the checked
  viewport. Invoking the actual chart callback body against the real map modules
  highlighted the route in both renderers and preserved selection after mouseout.
  This is not a full authenticated ECharts/list/map pointer round-trip test.
- Layering checks also cover explicit ECharts child z-order and hover opacity,
  plus Leaflet label-pane ordering and background-only translucency. An isolated
  ECharts browser render confirmed that a crossing line at z=4 is drawn before
  header rectangle/dot/text at z=120. Leaflet computed pane order and screenshots,
  plus MapLibre computed alpha, mobile screenshot and canvas pixels, were checked.