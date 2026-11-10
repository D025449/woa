# Public REST API V1

## Status And Scope

Personal-key storage, profile management, four public workout endpoints and four
public analytics endpoints are implemented. `/api/v1` is mounted before browser sessions and browser
authentication. Deployment and live PostgreSQL/proxy verification remain pending.
The machine-readable contract is
[public-api-v1.openapi.json](public-api-v1.openapi.json).

V1 exposes owned imported workouts, with a broad set of elementary metrics and
classifications, plus an explicitly authorized single-workout FIT download.
Manual training activities contribute to analytics aggregates; individual manual
activity reads/FIT downloads, group-shared workouts, writes, imports and other
raw time-series/binary download endpoints are outside this version.
An administrator key grants no access to another user's workouts.

User approved the first analytics slice on 2026-11-10: period summary and daily
training load. `analytics:read` is independently issuable after manual migration
098. Power-profile and FTP-history endpoints were added after the successful
user-reported initial analytics test. Workout-level TSS,
IF and NP remain part of `workouts:read`; power profile additionally returns
source IDs with both read permissions. The opt-in [MCP server](mcp-server.md)
reuses these services through dedicated OAuth, not personal-key authentication.

## Authentication And Scopes

Production requires HTTPS with `Authorization: Bearer <personal-api-key>`.
Local non-production test/dev requests may use HTTP. Cookie
authentication, URL credentials, session creation and automatic user creation are
not part of this API. Route API requests separately from browser authentication.
Never log the Authorization header or include keys in URLs or examples.

| Scope | Permission |
| --- | --- |
| `workouts:read` | Owned workout summaries and details without location data |
| `workouts:gps:read` | Owned workout GPS, additionally requiring `workouts:read` |
| `workouts:fit:read` | Full owned FIT export, additionally requiring both workout and GPS scopes |
| `analytics:read` | Owned summary, daily training load and FTP history; power profile additionally requires workout read; no GPS prerequisite |

Scopes are an allowlist, not a hierarchy or wildcard language. Unknown scopes
must be rejected at issuance. Each request checks both the key and current user
state. Revocation and expiry apply to subsequent authorization checks without
waiting for a browser session or token refresh. Already transmitted data cannot
be recalled. Storage/authentication failures fail closed.

Personal-key issuance and revocation are session-authenticated account
operations, not public API-key operations. Store only a cryptographic hash of the
high-entropy random secret; show the full secret once. Retain safe metadata such
as key ID, display prefix, name, scopes, expiry, creation, revocation and last-use
timestamps. Do not copy Wahoo's encrypted upstream-token storage: these keys
never need to be recovered for outbound requests.

Approved and implemented: five active keys per user and fixed 90-day validity.
Implemented pilot protection uses rolling 60-second Redis sorted sets and an
atomic Lua operation, with Redis time as the clock:

| Bucket | Limit | Identity |
| --- | --- | --- |
| Ingress, before authentication | 480/minute | Client IP |
| All authenticated public requests | 240/minute | User, shared across all keys |
| GPS, after both scope checks | 40/minute | User, shared across all keys |
| FIT, after all three scope checks | 40/minute | User, shared across all keys |
| Analytics, after its scope check | 40/minute | User, shared across all four endpoints, keys and MCP connections |

Rejected ingress attempts do not consume a user bucket; a missing GPS scope
does not consume the GPS bucket; missing FIT permissions do not consume the FIT
bucket. Missing analytics permission does not consume the analytics or authenticated
user bucket. All families share the ingress and authenticated user limits.
Redis failures or malformed limiter results
return 503. Allowance exhaustion returns 429 and `Retry-After`. Buckets expire
after 60 seconds and store hashed identities, never API secrets. All application
instances must share Redis for these request limits. These are pilot defaults,
not a measured production capacity guarantee.

| Account state | Existing read key | Create key | Revoke key through account UI |
| --- | --- | --- | --- |
| `active` | Allowed | Allowed | Allowed |
| `pending_deletion` | Allowed until expiry, revocation or final deletion | Denied | Allowed |
| `deleted`, absent or unrecognized | Denied | Denied | No authenticated account access |

This preserves current read access during the 28-day deletion grace period.
Final deletion must remove key material/metadata as appropriate and deny access
even if a key record is accidentally retained. Existing memberships have usage
limits, but no API-read entitlement; no paid-tier restriction is introduced by
this draft. A general account-suspension policy is not implemented here.

## Endpoints And Pagination

| Method and path | Required scopes |
| --- | --- |
| `GET /api/v1/workouts` | `workouts:read` |
| `GET /api/v1/workouts/{id}` | `workouts:read` |
| `GET /api/v1/workouts/{id}/gps` | Both workout scopes |
| `GET /api/v1/workouts/{id}/export.fit` | All three scopes |
| `GET /api/v1/analytics/summary` | `analytics:read` |
| `GET /api/v1/analytics/training-load` | `analytics:read` |
| `GET /api/v1/analytics/power-profile` | `analytics:read` and `workouts:read` |
| `GET /api/v1/analytics/ftp-history` | `analytics:read` |

The list accepts only `from`, `to`, `type`, `limit` and `cursor`; reject unknown,
duplicated, malformed or conflicting parameters with HTTP 400. `from` is inclusive
and `to` exclusive against workout start time. Both accept RFC 3339 timestamps
with an explicit UTC offset and at most six fractional digits; require `from < to`
when both are supplied. Workouts without a start time are omitted when a time
filter is present.

Use a default limit of 50 and maximum of 100. Sort by start time descending,
NULLs last, then numeric workout ID descending. An authenticated opaque cursor
must bind to the user, time/type filters and ordering, including the NULL-start
partition. It uses AES-256-GCM with a domain-separated key derived from
`SESSION_SECRET` and expires after 24 hours; changing that secret invalidates
existing cursors. It must not expose raw SQL or act as authorization. Subsequent
requests repeat the same filters; `limit` may change. Reject invalid or mismatched cursors.
No expensive total count is promised. Pagination is not a historical snapshot:
deletions or edits can change results while traversing pages.

IDs are positive decimal strings, preserving PostgreSQL BIGINT precision. Return
timestamps normalized to UTC, finite JSON numbers and explicit `null` for missing
measurements. All listed workout fields are present in list and detail responses.
The list uses `{ "data": [...], "next_cursor": null }`; detail uses `{ "data": {...} }`.

## Workout Field Allowlist

These are API field names, not an automatic serialization of database rows.

| API fields | Source / meaning |
| --- | --- |
| `id`, `uploaded_at`, `start_time`, `end_time` | Workout identity and UTC timestamps; legacy timezone-less `uploaded_at` is interpreted as UTC, confirmed by the user on 2026-11-09 |
| `elapsed_time_seconds`, `timer_time_seconds` | `total_elapsed_time`, `total_timer_time` |
| `distance_meters`, `total_cycles` | `total_distance`, `total_cycles` |
| `work_joules`, `calories_kcal` | `total_work`, `total_calories` |
| `ascent_meters`, `descent_meters` | `total_ascent`, `total_descent` |
| `avg_speed_mps`, `max_speed_mps` | `avg_speed`, `max_speed`, in meters per second |
| `avg_power_watts`, `max_power_watts`, `normalized_power_watts` | `avg_power`, `max_power`, `avg_normalized_power` |
| `avg_heart_rate_bpm`, `max_heart_rate_bpm` | Heart rate summary |
| `avg_cadence_rpm`, `max_cadence_rpm` | Cadence summary |
| `tss`, `intensity_factor`, `ftp_used_watts` | Derived workout metrics and their FTP basis |
| `workout_type`, `terrain_profile` | Stored semantic classifications |
| `intensity_profile`, `intensity_structure`, `intensity_dose` | Stored semantic classifications, not model internals |
| `intensity_tags` | Decode the stored bitmask into semantic tag strings, never expose the bitmask |
| `perceived_exertion` | Existing 1-10 subjective scale, or null |
| `gps_available`, `gps_source`, `gps_sample_interval_seconds` | GPS presence and non-location provenance; `gps_source` is `recorded`, `manual_lookup` or null |

NP is persisted; public workout and analytics services share retrospective UTC
yearly FTP interpolation. Both load the full bounded anchor series, including
the following year when it exists. No FTP applies before the first valid anchor;
after the last anchor, its value is retained. The interpolated FTP is not rounded
before calculating IF/TSS. This public policy is distinct from the legacy browser
calculation, which remains unchanged.
For classified cycling workouts (`road`, `mountain`, `indoor`) with a valid
positive FTP and finite non-negative NP and timer duration,
IF = NP / FTP and TSS = round(duration_seconds / 3600 * IF * IF * 100).
Expose `ftp_used_watts` so clients can interpret these estimates. Missing or
invalid prerequisites produce null, not a fabricated zero. Unknown and motorsport
classifications have null IF/TSS/FTP basis. IF requires valid NP and FTP; TSS
additionally requires timer duration. A valid computed zero remains zero. Derived
values may change when FTP history or calculation policy changes; they are not immutable
measurements. Do not recalculate NP from a large stream merely to serve a list.

## GPS And Excluded Fields

The GPS endpoint returns `application/geo+json`, a Feature with a MultiLineString
geometry. Preserve recording gaps as separate lines and longitude/latitude order.
Properties include only `workout_id`. For an owned workout with no usable route,
return HTTP 200 with `geometry: null`. Missing either scope yields HTTP 403 even
when a workout has no route. Unknown and foreign workout IDs both yield HTTP 404.

Even small location fields (`gps_bounds`, start/end coordinates and manual lookup
points) are excluded from ordinary workout responses. V1 GPS does not additionally
publish these database fields: coordinates are provided through the route only.
Map thumbnails, route URLs and other location-bearing artifacts are also excluded
from ordinary responses. Do not join across invalid samples to satisfy GeoJSON.

Ordinary JSON/GeoJSON responses never publish streams, GPS blobs, codecs, histogram/model blobs, device metadata,
device identifiers, processing status/errors/version counters, owner IDs/emails,
sharing metadata or redundant calendar partition fields. FIT is the explicit
exception for full measurement series and available device information; it does
not expose database blobs or processing internals. Use explicit SQL columns
and response schemas, not `SELECT *`, spread database rows or a blob-only denylist.

## Errors And Operational Boundaries

Return JSON errors shaped as `{ "error": { "code": "...", "message": "...",
"request_id": "..." } }`. Messages are safe English text; clients use the stable
code. No HTML login redirects, stack traces, SQL, tokens or provider error dumps.
All success/error responses use `Cache-Control: no-store`; HTTP 401 carries a
Bearer challenge and HTTP 429 carries `Retry-After` seconds.
Every public response carries a server-generated `X-Request-ID`. REST error
bodies and structured `public_api_error` server logs share that ID; inbound
request IDs are ignored. Logs contain only the family, allowlisted HTTP method
and route template, status, public error code and allowlisted dependency reason
(for example `28P01` or `database_password_type`). No request URL/query/body,
Authorization/cookie, user identity, raw exception message or stack is logged.
Diagnostic sink failures do not replace the API response.

| HTTP | Meaning |
| --- | --- |
| 400 | Invalid ID, query parameter, date range or cursor |
| 401 | Missing, invalid, expired or revoked personal key |
| 403 | Insufficient scopes or unavailable account |
| 404 | Workout absent or not owned; indistinguishable externally |
| 405 | Only GET is supported |
| 422 | GPS cannot be returned within the configured response budget; never silently truncate |
| 422 | FIT export exceeds a source, record, lap, response or worker budget |
| 422 | Analytics exceeds a source-row, FTP-row, history-span or JSON budget |
| 429 | Rate/resource allowance exceeded |
| 503 | Authentication/storage service unavailable; never bypass authorization |

Non-GET requests, including HEAD and OPTIONS, return 405 with `Allow: GET`.
HEAD carries the error headers without a response body, as required by HTTP.
Unknown `/api/v1` paths return `not_found` (404); they never fall through to
browser login or dashboard Analytics. Every error has `application/json`,
including failures after GPS processing has selected a GeoJSON content type.
Invalid/missing classification values map to the documented `unknown` or
`altitude_missing` fallback, never to arbitrary stored strings.

### GPS Resource Budgets

| Resource | Maximum |
| --- | --- |
| Stored GPS blob fetched from PostgreSQL | 2 MiB |
| Decompressed GPS bytes | 4 MiB |
| Declared slots, including missing/invalid samples | 100,000 |
| Complete serialized GeoJSON response | 4 MiB |
| Worker execution, including startup | 2 seconds |
| Simultaneous GPS workers | 2 per application process |
| Worker old-generation heap | 96 MiB |

Oversized blobs are rejected in SQL before copying their payload. Gzip and
Brotli decompression have output limits; identity and inferred legacy codecs
are supported. The API validates legacy GPS2 layouts 1-4 before calling the
existing decoder, whose incomplete-block tolerance could otherwise fabricate
zero coordinates. Layout 5 uses the existing strict bitmap/column decoder.
Legacy binary V1 is also supported. Invalid coordinates split lines; isolated
points are omitted because GeoJSON lines require at least two positions.
A route with no usable line has null geometry. Corrupt/unsupported payloads
return 503; size/time/heap budget failures return 422; worker capacity returns
429 with a short Retry-After. Workers are terminated and capacity released
on completion, timeout and failure. No route is shortened to fit a budget.

Workout SQL runs in read-only transactions with a five-second timeout per
statement. This is not an end-to-end deadline or a pool-acquisition limit.
GPS decoding happens outside the database transaction. FTP is read once per
nonempty page, using the shared UTC interpolation and unrounded basis; at most
500 yearly anchors are accepted.
Database query plans and production route distributions remain unmeasured.
The API's API-key scopes are expressed with `x-required-scopes` in OpenAPI:
HTTP Bearer security itself cannot declare OAuth scope lists. No OAuth
authorization server is implied.

## Single-Workout FIT Export

`GET /api/v1/workouts/{id}/export.fit` returns `application/octet-stream` with
`Content-Disposition: attachment` and a filename derived from the workout start
in UTC. Invalid/missing start times use a safe workout-ID filename. No query
parameters are accepted. All three scopes are required even for GPS-free workouts.
Foreign/shared-only/absent workouts return the same 404.

The file is regenerated from stored workout data, using the existing shared
FIT generator and shared GPS interpolation, device metadata
fallback, NP/calorie values and manual/interval lap inputs. It is not the original
uploaded file. Available temperature and balance series and stored device
identifiers are intentionally included. The existing generator normalizes FIT
records and removes unmistakable corrupt terminal samples; budget enforcement
does not truncate a successful file. The API preserves missing/invalid GPS sample
positions so later coordinates retain their timing and interpolation cannot cross
a gap. The GeoJSON endpoint's separate-line geometry contract remains specific
to GeoJSON. No coordinates or source errors are logged by the API export.

### FIT Resource Budgets

| Resource | Maximum |
| --- | --- |
| Stored workout stream fetched from PostgreSQL | 16 MiB |
| Decompressed workout stream | 32 MiB |
| Workout records | 172,800 |
| Stored/decompressed GPS | 4 MiB / 8 MiB |
| GPS slots including gaps | 172,800 |
| Standalone or embedded device metadata block | 64 KiB |
| Relevant manual/interval segments | 1,000 |
| Interval phases | 50,000 |
| Complete FIT response | 32 MiB |
| Worker execution including startup | 15 seconds |
| Simultaneous FIT workers | 2 per application process |
| Worker old-generation heap | 512 MiB |

These are separate from the GPS endpoint's smaller budgets. SQL CASE projections
avoid fetching oversized source blobs and device metadata; bounded segment/phase
queries bind both owner and workout. Source records/header lengths and embedded
metadata are checked before stream decoding. Identity/gzip/Brotli and existing
supported legacy/WS11 stream formats are handled inside a worker. Decoding and
FIT generation occur after releasing the read-only database transaction.
Budget failure yields 422 `fit_response_too_large`; worker capacity yields 429
with `Retry-After`; corrupt data/dependency failures yield safe JSON 503.
No attachment header is sent before successful generation.

Migration 097 only extends the allowed scope combinations. It grants no FIT
permission to existing keys, rewrites no workout data and adds no endpoint for
editing scopes. After manually applying it, issue a new key with the FIT option.
Using the terminal variables from the API smoke test:

```zsh
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/workouts/$WOA_WORKOUT_ID/export.fit" \
  --output workout.fit
```

Use a newly issued FIT-enabled key and an owned workout ID. On failure, the
download file may contain a JSON error; check the curl exit status before opening
it as FIT. Never paste real keys into documentation or chat.

## Analytics Summary And Training Load

`GET /api/v1/analytics/summary` returns `{ meta, data }`, where `data` contains
period counts/duration/TSS coverage, `latest_load` for the last included date and
`ftp_watts` as of that date. `GET /api/v1/analytics/training-load` returns the same
metadata and a chronological daily `data` array, including days without activity.
Both require only `analytics:read`; they expose no workout/manual IDs, names,
notes, coordinates, device data, raw samples or performance records. Existing
keys receive no analytics rights automatically.

### Dates And Included Activities

- Only `from` and `to` are accepted, once each, as valid `YYYY-MM-DD` UTC dates.
  `from` is inclusive and `to` exclusive. Intervals must contain at least one day; multi-year ranges are supported. `to` cannot
  exceed tomorrow UTC. Without parameters, include the latest 28 UTC calendar days
  through today; providing only `to` uses its preceding 28 days. Unknown parameters,
  offsets/timestamps, duplicate parameters and invalid intervals return 400.
- All owned imported non-motorsport workouts and all manual activity types count
  toward volume. Null/invalid start times and future-start activities are excluded.
  The full duration/load is attributed to the UTC start day, even across midnight.
  Strength/mobility/other manual activities contribute duration, not cycling TSS.
- TSS applies to imported `road`, `mountain` and `indoor` workouts and manual
  `cycling` activities. Unknown imported types have no applicable cycling TSS.
  Explicit manual/legacy-null-source TSS is used when present, including zero.
  Otherwise, imported and modeled manual cycling use NP, duration and historical
  yearly FTP: `round(duration_seconds / 3600 * (NP / FTP)^2 * 100)`. Valid zero
  power/duration yields zero TSS if FTP exists. Missing prerequisites yield missing
  TSS, never a manufactured valid zero. Manual inputs remain estimates.
- `recorded_derived_tss` sums known TSS calculated from imported measurements;
  `manual_estimated_tss` sums known manual/model-derived TSS. `tss` is their sum.
  `known_tss_count`, `missing_tss_count` and `tss_not_applicable_count` explain
  coverage. If every applicable TSS is missing, `tss` is null; a rest day/no
  applicable activities has zero TSS. Partial sums retain their missing count.
  Duration likewise sums known seconds and reports `missing_duration_count`;
  it is null when all activity durations are missing. Summary counts refer only
  to the requested calendar interval, not the latest N activities.

### Load And FTP Semantics

The API reuses the existing daily-rounded CTL/ATL recurrence with time constants
42 and 7 days. Each day updates and rounds CTL/ATL; TSB is the updated CTL minus
updated ATL. The starting state is zero on the first available day with known
applicable TSS. Complete bounded history before `from` contributes to load;
requesting a shorter display interval never resets load. Rest days continue
through the exclusive end date, including after the last recorded activity.
Before the first known TSS, or with no known TSS anywhere, CTL/ATL/TSB are null.
This rounding matches the current application and can retain small nonzero
values after prolonged inactivity. It is not a new unrounded physiological model.

Missing TSS contributes zero to the recurrence.
`meta.history_missing_tss_count` counts missing applicable TSS across all included
history, so consumers can recognize incomplete load even when the requested
interval has complete coverage. `meta.history_from` records the first known TSS
date. `current_day_partial` flags a result/day containing today, since its data
can still change. Load reflects stored activities, not proof of complete training
history. Source edits/deletion or new FTP data may change retrospective results.

FTP comes from the existing owned `get_ftp_by_period2(user, year)` calculation,
using positive valid yearly values. Interpolation uses UTC January 1 anchors,
carries the latest value forward and returns null before the first available
year. No future-year values beyond the last requested year are fetched. Existing
yearly estimates can include later efforts within that year; this is a retrospective
estimate, not the FTP known at the time. `meta.ftp_method` makes the method explicit.
The existing browser calculations are unchanged; timezone handling, pre-first-year
fallback and rest days after the last activity can therefore differ from the UI.
`TrainingContextService` still has the separately documented last-7/28-activities
issue; this API does not reuse it or change the coaching context in this slice.

### Analytics Budgets And Setup

| Resource | Maximum |
| --- | --- |
| Requested UTC calendar days | No annual cap; technical history/response budgets apply |
| Combined owned scalar source rows, including history | 50,000 |
| Daily load history span through `to` | 20,000 days |
| Yearly FTP rows | 500 |
| Response JSON | 1 MiB |
| Concurrent analytics calculations per process | 2 |
| Dedicated analytics DB connections per process | 2 |
| Analytics connection wait / individual SQL statement | 5 seconds / 5 seconds |

All four analytics endpoints share the 40/minute/user analytics bucket, plus the same
240/minute/user and 480/minute/IP buckets as workout endpoints. Redis enforces
rolling limits across keys/processes. Computation concurrency is per process.
Scalar projections bind the authenticated owner independently in both UNION
branches and fetch at most the row limit plus one. Source and FTP reads share a
repeatable-read, read-only transaction. A dedicated bounded-wait pool uses the
existing database configuration; it does not change the shared application pool.
The dedicated pool explicitly retains pg's non-enumerable password; object
spread alone would silently drop it. A real-pg fixture regression verifies
credential transfer, hidden password serialization and unchanged limits without
opening a connection. The 2026-11-10 correction passed all 969 tests, syntax,
zero-warning lint and types. Production read-only `SELECT 1` confirmed that
explicit credential transfer fixes the copied-pool connection failure; actual
analytics requests after deployment remain to be verified.
The connection is released before aggregation. No stream decompression, worker,
cache, write or new dependency is required.
Removing the annual constraint does not remove technical limits. Summary
responses serialize totals and the latest load without the unreturned daily
series; daily training-load still enforces the 1 MiB response budget. Both retain
the 20,000-day computation-history cap. FTP bucket construction checks its JSON
budget incrementally so a very long range cannot allocate an unbounded result.

Oversized source/history/FTP/response returns 422 `analytics_response_too_large`
without a truncated successful result. Busy computation or rate limits return
429 with `Retry-After`. SQL timeouts, unavailable connections and other dependency
failures return safe JSON 503. All responses are `no-store`; errors use the
existing `{ error: { code, message, request_id } }` envelope.

Manually review and execute prepared migration
`src/migrations/098_user_api_keys_analytics_scope.sql` after any earlier pending
migrations. It only extends the scope constraint and allows analytics-only keys.
The assistant has not executed it. Issue a new key in `/profile#api-keys` with
the analytics checkbox selected; workout/GPS permissions are optional.

```zsh
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/analytics/summary?from=2026-11-01&to=2026-11-11"
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/analytics/training-load?from=2026-11-01&to=2026-11-11"
```

For live rollout, check owned mixed/manual-only/no-data accounts, missing FTP/TSS,
UTC midnight and historical windows, shared limits and real PostgreSQL query
latency. Tests use offline SQL fixtures; no database constraint/query-plan/live
credential verification is implied.

## Recorded Power Profile And FTP History

These endpoints use the same UTC `from`/`to` date rules and, except for grouped
power profiles, the 28-day default, with
multi-year ranges supported, read-only repeatable-read snapshot and 5-second
SQL/connection budgets,
two shared concurrent analytics calculations and 1 MiB response budget as the
first analytics slice. All four endpoints share the 40/minute/user analytics
bucket. No new scope, key upgrade or migration is introduced.

Only owned imported `road`, `mountain` and `indoor` workouts with stored `crit`
segments supply performance data. Both workout and segment ownership are bound
in SQL. Manual activities, manual/interval segments, shared workouts, unknown
types and motorsport do not supply performance records. At most 50,000 scalar
effort rows are fetched (grouped power profiles fetch only period winners);
exceeding that limit returns 422 without truncation.
Queries use transaction-local `work_mem = 8MB`. No streams are fetched or decoded
and no new critical-power calculation is triggered. Invalid scalar inputs are
ignored; empty/missing estimates remain null.

### Power Profile

`GET /api/v1/analytics/power-profile` returns `{ meta, data }` with one record
per selected duration when `grouping` is omitted. Optional `durations` accepts distinct comma-separated
seconds without spaces from this fixed allowlist:
`5,15,60,120,240,300,360,480,720,900,960,1200,1800`; defaults to all. Unsupported,
duplicate, empty or malformed values yield 400.

For each duration, select the highest stored average power in the requested
workout-start interval. Ties prefer the newer exact UTC start timestamp, then
the larger exact BIGINT workout and segment IDs. SQL supplies a microsecond
sort key; IDs remain decimal strings. Fields include `duration_seconds`,
`power_watts`, `watts_per_kg`, `weight_kg`, `weight_source`, `weight_date`,
`workout_id`, `workout_start_time`, `start_offset_seconds` and
`end_offset_seconds`. No heart-rate, GPS or device fields are added.

W/kg uses the returned power and the historical weight valid on the source
workout UTC date, falling back to the current profile weight as in the existing
weight resolver. History/profile provenance is explicit. Missing or invalid
weight yields null W/kg. Weight queries are bounded to the distinct winner dates,
at most 13 in ungrouped mode. Grouped requests batch all distinct winner dates
in one weight query. Scalars are rounded to three decimals.

A duration without a stored matching effort has null power/source fields. In
particular, 300/1200-second rows may be absent from earlier imported data; these
requests do not backfill or synthesize efforts. Valid recorded zero remains zero.
The endpoint requires both `analytics:read` and `workouts:read` because it returns
source workout IDs and offsets. Missing workout permission returns 403 before
consuming the analytics bucket; the common authenticated user bucket still applies.

Optional `grouping=week|month|quarter|year` returns one chronological list with
all selected CP durations in every calendar period. Weeks begin Monday UTC.
For example, CP5 and CP20 per month across the available history:

```sh
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/analytics/power-profile?durations=300,1200&grouping=month"
```

Add `&from=2024-01-01&to=2026-11-11` to limit the workout-start interval
(inclusive/exclusive). With grouping, omitted `from` uses the earliest valid
matching stored effort before `to`; omitted `to` includes today. Without grouping,
the existing 28-day default and response remain unchanged. With no matching
history and no explicit `from`, `meta.from` is null and `data` is empty. An explicit
range includes empty periods with null points.

Grouped responses retain the existing power metadata and add `meta.grouping`.
Each `data` entry contains `period_from`, exclusive `period_to`, `partial_period`
and `points`, an array of the existing power-point objects in ascending duration
order. Period boundaries describe the full calendar period; candidates are
restricted to the requested range. `partial_period` flags clipped periods and
periods incomplete at generation time. Each point is the maximum stored effort
for that period/duration, with the same deterministic ties, missing/zero semantics
and source-date weight provenance as the ungrouped response.

Grouped mode ranks valid candidates in one SQL query and transfers only winners;
there are no separate source queries per period or duration. The 50,000-row budget
applies to returned winners in this mode; ungrouped power/FTP source budgets
remain unchanged. SQL time, work-memory, response-byte, concurrency and request
quotas still apply. Empty buckets and points are byte-budget checked incrementally
before weights are fetched, and the final weighted response is checked again.
Oversized requests return 422 without silently truncating; choose a coarser
grouping, fewer durations or a narrower time window. No migration or backfill.

### FTP History

`GET /api/v1/analytics/ftp-history` accepts optional `grouping`:
`week`, `month`, `quarter` or `year`, default `month`. Weeks begin Monday UTC.
It returns chronological calendar buckets intersecting the requested interval,
including empty buckets, with `period_from`, exclusive `period_to`,
`partial_period`, `cp8_watts`, `cp15_watts`, `ftp_watts`, `cp8_effort_count`,
`cp15_effort_count` and `confidence`. It requires only `analytics:read` and
returns no source IDs, dates, offsets, weight history or raw performance rows.

For each bucket, continuous 95th percentiles of positive stored 480-/900-second
efforts supply CP8 and CP15. Reuse the existing FTP formula:
`0.95 * (CP8 + (ln(1200)-ln(480))/(ln(900)-ln(480)) * (CP15-CP8))`. Missing
anchors or nonpositive estimates yield null FTP; empty buckets have zero counts,
not a fabricated zero FTP. `confidence` is the smaller anchor effort count,
matching the existing method; it is not a probability or quality percentage.

Only efforts within the requested date interval contribute. A calendar bucket
clipped by either bound or still in progress is marked `partial_period`, and
changing bounds can change its estimate. `meta.ftp_method` is
`period_cp8_cp15_p95`. This is a recorded-data, retrospective period estimate,
distinct from the browser's 84-day rolling FTP and the yearly interpolated FTP
used by summary/load. Browser models and stored yearly partitions are unchanged;
the public history derives its calendar grouping from UTC start times.

### Performance Smoke Requests

The existing analytics key works for FTP history. For power profile, use a key
with both analytics and workout-read permissions; the scope constraint is already
covered by migration 098. Existing keys cannot be edited or upgraded automatically.

```zsh
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/analytics/power-profile?from=2026-01-01&to=2026-11-11&durations=5,60,480,1200"
curl --fail-with-body -H "Authorization: Bearer $WOA_API_KEY" \
  "$WOA_API_BASE/api/v1/analytics/ftp-history?from=2026-01-01&to=2026-11-11&grouping=month"
```

Live performance requests, SQL query plans and real weight/source matching remain
to be verified. Offline tests do not establish those checks or a production rollout.

## Implementation And Verification

### Implemented Key-Management Layer

- **Migration status:** the user confirmed manual execution of
   `src/migrations/096_user_api_keys.sql` on 2026-11-09. The target environment was
   not specified; the assistant did not execute or independently verify it.
   Deploying without the table also breaks final account deletion,
   which now deletes key records in its existing transaction.
- `ApiKeyService` generates 256-bit random `woa_pk_` secrets, stores only SHA-256
   hashes and returns the full secret only on successful creation. A transaction
   locks the owning user row before enforcing the five-active-key limit. Names are
   limited to 80 characters. The FIT scope is issuable after manual migration 097;
   it requires both existing workout/GPS scopes. GPS requires workout read access.
   Analytics is independently issuable after manual migration 098, alone or combined
   with valid workout scopes. Existing keys are never upgraded automatically.
   Expiry remains creation plus 90 days.
- `GET /api/profile/api-keys` returns safe metadata for at most 100 records, active
   keys first, issuance availability, limits and a session-bound CSRF token.
   `POST /api/profile/api-keys` creates a key; `DELETE /api/profile/api-keys/:id`
   revokes an owned key idempotently. These are browser management endpoints, not
   part of the public workout OpenAPI contract. All require matching authenticated
   browser/session identities; Authorization headers are rejected. Mutations also
   require the session CSRF token and an exact same-origin Origin header. Reverse
   proxies must preserve the correct external host/protocol under the app's trusted
   proxy configuration. Responses are no-store and no-referrer.
- `/profile#api-keys` opens the Account facet with translated creation, listing,
   last-use/expiry/status and confirmed revocation controls. The secret is masked
   initially, can be revealed/copied, and is erased on dismissal or page exit.
   Neither localStorage nor another persistence mechanism stores the secret.
   Analytics is unchecked by default and independent of workout/GPS selection;
   key creation requires at least one valid scope.
   Pending-deletion accounts cannot create keys but can revoke existing keys.
   FIT is unchecked by default; selecting it enables workout and GPS permissions.
   Clearing GPS clears FIT; clearing workout read clears both dependent permissions.
   The six-language hint explains that FIT contains full series, GPS and device
   information. Checkbox behavior is covered by a DOM-module test and an isolated
   browser fixture using the actual EJS partial, stylesheet and module. The fixture
   verified prerequisite toggling, explicit three-scope issuance, unchanged existing
   key labels, masked secret and erasure on dismissal, with no console errors.
   Its wrapper and APIs are simulated; it does not verify the full profile layout
   or create real credentials. Initial approval transport failures resolved after
   the user restored the network connection.
- `apiKeyAuth(requiredScopes)` accepts only a Bearer header, resolves identity
   from the hash and live account state, rechecks expiry/revocation before returning
   an immutable `{ userId, keyId, scopes }` in `req.apiAuth`, and updates last use.
   It does not create a browser session or trust an input user ID. Authentication
   outages fail closed. It is attached to all public data routes.
- A later local MCP server can keep a key in its own protected local configuration
   and send it as a Bearer header, never as a model-facing tool argument. No MCP
   server is delivered. Public summary/training-load endpoints are documented below.

Previous key-management verification: all 903 application tests, syntax, strict
zero-warning lint, types and diff checks passed. Focused tests cover hashing/one-time issuance, account and
scope rules, lock/limit SQL, ownership, CSRF, safe errors and deletion integration;
profile rendering is checked in all six languages. An isolated EJS/browser fixture
verified creation, literal rendering of an HTML-shaped name, secret dismissal,
confirmed revocation, pending-deletion behavior, quota, outage/retry and desktop/
mobile layout. SQL constraints, live PostgreSQL concurrency and real-session/proxy
integration have not been executed or verified against a database.

### Public Endpoint Verification And Rollout

The subsequent full-suite run passed all 982 tests after correcting an unstable
cursor tampering assertion. Replacing the first random Base64url character with
`A` could leave the original cursor unchanged; the test now flips one decoded
nonce byte and verifies inequality before expecting rejection. No production
cursor behavior was changed. This run also includes the ChatGPT OAuth
`ui_locales` compatibility fix documented in mcp-server.md.

Grouped power profiles (OpenAPI v1.5.0): all 981 tests, syntax, zero-warning lint,
types and diff checks passed. Coverage exercises the grouped REST response and
real MCP SDK dispatch through the shared service, UTC/leap/calendar boundaries,
period maxima with precise ties, missing/zero values, historical/profile weight
provenance, full-history defaults, empty history/ranges, query owner/parameter
bindings and budgets/rollback. SQL uses fixtures: live PostgreSQL execution,
query plans and latency remain unverified. The initial sandbox run could not open
four local test ports; after one technical approval-review stream failure, the
approved complete suite passed. No migration, deployment or restart was performed.

The 2026-11-10 improvements align workout/analytics FTP and TSS, remove the
366-day request cap for all four analytics endpoints and increase REST/MCP
request quotas by four. That slice introduced OpenAPI v1.4.0. Technical row/byte/SQL/worker/concurrency
limits and key/grant lifetimes are unchanged. Multi-year requests may still
return 422 when their actual computation or response exceeds those budgets.
Historical derived workout TSS/IF may change under the unified FTP policy.
No migration is required; code deployment and process restart are required.
All 976 tests, syntax, zero-warning lint, types and diff checks passed. New tests
compare actual workout and analytics services at fractional-year FTP anchors and
before/after available history, exercise all four MCP analytics tools across
multiple years, preserve large-range resource errors and verify quota wiring.
Diagnostics tests bind response/header/log IDs, reject inbound ID substitution,
keep dependency messages and credentials out of logs and tolerate log-sink
failure. Production queries/data and the new quotas remain to be checked after
rollout; no assistant migration, deployment or restart was performed.

Recorded-performance completion: all 954 tests, syntax, zero-warning lint, types
and diff checks passed. New coverage includes strict options, missing/zero effort
data, precise IDs/timestamps and deterministic winners, historical/profile weight
provenance, CP8/CP15 percentiles/anchor counts, UTC calendar boundaries/clipping,
owner-bound bounded source/weight queries, rollback, scope separation/shared
analytics buckets and exact OpenAPI fields. A synthetic 50,000-effort build
returned 13 power points and 46 weekly FTP buckets in 67 ms, with 3,464 and
8,904 response bytes. This does not verify live PostgreSQL/source matching.
No new-endpoint live request or deployment was performed by the assistant.

Analytics completion: all 945 tests, syntax, zero-warning lint, types and diff
checks passed. New coverage includes UTC/date windows, explicit manual/derived/
missing/zero TSS, history before the interval, rest days through its end,
scalar owner-bound UNION projections, read-only snapshot/rollback/capacity,
scope combinations and analytics-only issuance, safe HTTP errors/HTTPS/response
limits, and six-language profile rendering. A synthetic boundary build with
50,000 activities and 20,000 days of history returned 366 days and 124,404 bytes
in 38 ms. This is an offline calculation, not production-query verification.
The user confirmed manual migration 098 execution and a successful API smoke
test on 2026-11-10. Target and individual exercised requests were not specified;
this is not independent verification of the live matrix or query plans.
No live analytics request was performed by the assistant.
An isolated actual EJS/CSS/module browser fixture verified default-off and
independent analytics selection, no-scope issuance blocking, simulated
analytics-only issuance, unchanged existing key labels and secret masking/
erasure, with no console errors. The wrapper and API responses are simulated;
this does not verify the full profile layout or issue real credentials.

FIT completion verification: all 930 tests, full syntax, zero-warning lint,
types and diff checks passed. New checks cover generator parity, identity/gzip/Brotli, legacy
streams, device fallback, NP/calories/laps, retained GPS gap timing, ownership-bound
bounded queries, all three scopes, safe HTTP errors and worker limits/recovery.
A synthetic boundary export with 172,800 workout records and GPS slots completed
in 169 ms, producing a 4,147,515-byte FIT file. This is an offline synthetic check,
not production-data or live PostgreSQL verification. Migration 097 remains pending
manual execution by the user.

Previous three-endpoint completion: all 919 tests, full syntax, zero-warning lint, types and
diff checks passed. The 34 focused API/GPS tests include the existing key layer
and GPS codec regressions. OpenAPI JSON references and response field/enum sets
are checked in tests; no new external OpenAPI validator or dependency was added.
A separate temporary Redis instance with no TCP port or persistence verified
the actual Lua script: 65 concurrent same-user/different-key requests allowed
exactly 60 and rejected five; separate-user allowance, stale-score pruning, TTL,
Retry-After and closed-client failure were checked. It was stopped and removed.

The user confirmed a successful manual API test on 2026-11-09 after receiving
curl instructions for list/detail/GPS and selected error cases. The environment
and individual exercised requests were not specified. This is a user-reported
successful smoke test, not independent verification of the complete live matrix,
query plans, concurrency or production proxy configuration.

Automated checks cover ownership-bound SQL/projections, UTC upload conversion,
scalar/date validation, microsecond cursors and their user/filter/expiry bindings,
null/zero/load metrics, exact OpenAPI field and classification sets, stored GPS
codecs and gaps, corrupt legacy payloads, slot/byte/time/capacity limits, shared
user buckets, authentication/account failures, HTTP content types and safe errors.
Database fixtures use offline mocks; they do not execute migrations or prove
live PostgreSQL constraints, query plans or ownership filtering.

Rollout prerequisites and checks beyond the confirmed smoke test:

1. Ensure migration 096 is present in the deployment target. Manual execution
   is user-confirmed on 2026-11-09; the target environment was not specified.
   The assistant has not executed or independently verified it.
   For FIT issuance, also manually review and execute prepared migration
   `src/migrations/097_user_api_keys_fit_scope.sql` before deploying the FIT UI.
   Migration 097 has not been executed by the assistant or confirmed by the user.
   For analytics issuance, manually review and execute migration 098 before
   deploying the new analytics checkbox. A successful localhost FIT download of
   55,011 bytes was user-confirmed on 2026-11-09, including successful file access;
   it does not independently establish migration execution or production rollout.
2. Verify that current PostgreSQL upload writes still use UTC. The historical
   convention is confirmed; `uploaded_at` remains TIMESTAMP WITHOUT TIME ZONE.
   No schema rewrite or data migration is part of this implementation.
3. Deploy code with `SESSION_SECRET` and shared Redis configured. Ensure the
   proxy preserves HTTPS and supplies trustworthy client addresses under the
   existing `trust proxy = 1` setting; prevent clients from bypassing that proxy.
   Do not log Authorization or place credentials in URLs.
4. Try owned/foreign/shared/no-GPS requests with real personal keys; confirm
   revocation, expiry, account states, rate limits and missing-dependency errors.
   Check real query latency and stored route sizes against the pilot budgets.

No deployment, normal service restart, PostgreSQL operation or migration was
performed by the assistant. Summary/training-load analytics was subsequently
approved and implemented on 2026-11-10, followed by recorded power-profile and
FTP-history endpoints. MCP remains deferred. Migration 098 execution is user-confirmed on 2026-11-10;
the assistant neither executed nor independently verified it.
