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
All 812 tests passed, including 40 focused provisioning/CLI cases covering refresh,
retry exhaustion, HTTP/length/body/encoding, disk safety, cancellation, damaged
downloads, progress and JSON/stderr separation;
syntax/lint passed, with only the existing `lastEnd` type errors. No production
access, service restart, migration or real archive download was performed here.

Both commands emit `[maps]` phase updates to stderr, including database/catalog,
region discovery, bounds planning and each existing-archive inspection.
Preparation additionally reports the locked recheck of each required archive,
reuse, download requests/attempts, bytes and percentages, downloaded-file
verification, installation and coverage counters (every 100 workouts and at the
end). Download byte updates are throttled to at most one per second, plus initial
and final updates; they require incoming chunks, so waiting for a network response
does not produce a heartbeat. SQLite `quick_check` is synchronous and reports the
current archive before starting, not a percentage within that check. Both archive
inspection passes remain intentional. These messages are visible without a TTY;
`--json` keeps the script's stdout exclusively for its final JSON report.

Example progress (illustrative, not captured production output):

```text
[maps] inspect-existing archive=lorraine 7/8
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
Stop provisioning/restart rendering workers when replacing files already open by
running processes; existing workers do not automatically reopen archives.

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
- Local mode reuses every existing nonempty thumbnail, including old styles,
  Geoapify backgrounds and route-only fallbacks. There is no bulk generation,
  style upgrade or automatic fallback retry. Explicit manual/copied GPS edits
  still replace thumbnails because the route itself has changed.
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
  disk entries to 128 MiB per namespace/worker. Old namespaces and abandoned
  temporary files require manual cleanup; there is no cross-process tile dedup
  or global cache-root limit.
- Local mode makes no external map calls. Missing/incomplete coverage, invalid
  archives, worker errors, overload or timeout use the persisted route-only
  fallback, without automatic retry. Enlarging coverage does not replace saved
  images. Indoor/non-GPS profile thumbnails retain their existing path.

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