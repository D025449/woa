# WOA1/V2 Specification

## Goal

`WOA1/V2` is a self-contained workout transport and persistence format for the synchronous upload path.

Per workout entry, the format must contain:

- all metadata required to write one `workouts` row
- one fully prepared workout stream blob
- one fully prepared GPS stream blob
- explicit codec metadata for both blobs

The target architecture is:

1. Browser parses FIT.
2. Browser computes the final row metadata exactly as the backend would.
3. Browser builds the final persisted workout stream blob.
4. Browser builds the final persisted GPS blob.
5. Browser compresses both blobs with `gzip`.
6. Backend only validates, adds `uid`, bulk-inserts, and schedules postprocess jobs.

No backend FIT parsing, workout materialization, GPS rebuild, or recompression should be required in the final path.

## Container

One uploaded `.woa1.zip` file contains many per-workout `WOA1/V2` entries.

Each entry contains exactly one workout.

The outer ZIP is only a transport container. The semantic contract lives inside each entry.

## Entry Layout

Each `WOA1/V2` entry is a binary container with four logical blocks:

1. `meta`
2. `sessions`
3. `workout_stream`
4. `gps_track`

Compared to current `WOA1`, `WOA1/V2` changes the meaning of the blocks:

- `meta` becomes the authoritative row-persistence block
- `workout_stream` becomes the final persisted workout stream payload, already compressed
- `gps_track` becomes the final persisted GPS blob payload, already compressed

## Header

Suggested header fields:

- `magic`: `"WOA1"`
- `majorVersion`: `2`
- `minorVersion`: `0`
- `flags`: reserved
- `metaLength`
- `sessionLength`
- `workoutStreamLength`
- `gpsTrackLength`

This keeps the current framing model and only upgrades semantics.

## Meta Block

The `meta` block is JSON and becomes the source of truth for the DB row.

It must contain all fields needed for synchronous `INSERT INTO workouts`, except `uid`, which is set by the backend from the authenticated user.

### Required Row Fields

These fields map directly to the current insert path in [fileDBService.js](/Users/D025449/woa/src/services/fileDBService.js):

- `start_time`
- `end_time`
- `total_elapsed_time`
- `total_timer_time`
- `total_distance`
- `total_cycles`
- `total_work`
- `total_calories`
- `total_ascent`
- `total_descent`
- `avg_speed`
- `max_speed`
- `avg_power`
- `max_power`
- `avg_normalized_power`
- `avg_heart_rate`
- `max_heart_rate`
- `avg_cadence`
- `max_cadence`
- `validGps`
- `year`
- `month`
- `week`
- `year_quarter`
- `year_month`
- `year_week`
- `points_count`
- `sampleRateGPS`
- `gps_source`

### Required GPS Geometry Fields

These are currently derived in backend code and must move into the `meta` block:

- `bbox`
  - `minLat`
  - `maxLat`
  - `minLng`
  - `maxLng`
- `track_start`
  - `lat`
  - `lng`
- `track_end`
  - `lat`
  - `lng`

Backend responsibility:

- if `validGps === false`, ignore GPS geometry fields and write `NULL` geometry/bounds fields
- if `validGps === true`, validate that `points_count >= 2` and GPS geometry fields are present

### Required Codec Fields

The metadata must explicitly declare the blob codecs:

- `stream_codec`
- `gps_track_blob_codec`

Allowed values:

- `gzip`
- `brotli`

For the target browser-first path, the expected default is:

- `stream_codec = "gzip"`
- `gps_track_blob_codec = "gzip"`

### Recommended Provenance Fields

These are not required for SQL insertion but are useful operationally:

- `sourceName`
- `sourceFormat`
- `recordCount`
- `pointsCount`
- `woaEntryVersion`
- `createdAt`
- `generator`

## Sessions Block

The `sessions` block can remain JSON.

Purpose:

- optional debugging
- optional validation
- future reprocessing support

It is not required for the synchronous insert once `meta` is authoritative.

If size becomes important, this block can later be made optional or dropped from upload-only workflows.

## Workout Stream Block

### Semantics

This block must contain the final persisted workout stream payload, already compressed.

The backend must store it directly into:

- `stream`

without rebuilding or recompressing it.

### Required Format Contract

The decompressed bytes must be exactly the format the runtime expects when reading `workouts.stream`.

There are two viable strategies:

1. Persist current internal runtime workout format
2. Migrate runtime to a transport-aligned persisted format and read that everywhere

For the final zero-materialization path, option 2 is cleaner, but only if all readers are migrated consistently.

### Codec

The raw bytes of this block inside `WOA1/V2` should already be compressed according to `meta.stream_codec`.

Target default:

- `gzip`

### Invariants

The workout stream must already reflect all browser-side decisions:

- 1 second timebase
- field quantization
- speed omission or reconstruction policy
- altitude encoding
- distance encoding
- all record ordering assumptions

Backend must not reinterpret these semantics.

## GPS Track Block

### Semantics

This block must contain the final persisted GPS blob payload, already compressed.

The backend must store it directly into:

- `gps_track_blob`

without rebuilding or recompressing it.

### Required Format Contract

The decompressed bytes must be exactly the format the runtime expects when reading `workouts.gps_track_blob`.

As with the workout stream, this can either be:

1. the current legacy GPS persistence format
2. a migrated new GPS persistence format

The crucial point is consistency across:

- workout details
- thumbnails
- similarity matching
- best-effort segment scans
- FIT export
- any other GPS consumer

### Codec

The raw bytes of this block inside `WOA1/V2` should already be compressed according to `meta.gps_track_blob_codec`.

Target default:

- `gzip`

### Invariants

The GPS payload must already reflect browser-side truth:

- reduced sampling cadence
- quantization scale
- `validGps`
- `points_count`
- bounds
- start/end point

No backend recomputation should be required.

## SQL Mapping

### Direct Mapping

Current insert columns:

- `uid`
- `start_time`
- `end_time`
- `total_elapsed_time`
- `total_timer_time`
- `total_distance`
- `total_cycles`
- `total_work`
- `total_calories`
- `total_ascent`
- `total_descent`
- `avg_speed`
- `max_speed`
- `avg_power`
- `max_power`
- `avg_normalized_power`
- `avg_heart_rate`
- `max_heart_rate`
- `avg_cadence`
- `max_cadence`
- `validGps`
- `year`
- `month`
- `week`
- `year_quarter`
- `year_month`
- `year_week`
- `bounds`
- `track_start`
- `track_end`
- `points_count`
- `sampleRateGPS`
- `gps_track_blob`
- `stream`
- `gps_track_blob_codec`
- `stream_codec`
- `gps_source`

### Backend-Derived Only

Only these values should still be backend-owned:

- `uid`
- SQL geometry wrappers
  - `bounds = ST_MakeEnvelope(...)`
  - `track_start = ST_GeomFromText(...)`
  - `track_end = ST_GeomFromText(...)`

The coordinate values themselves come from `meta`.

## Browser Truth Rules

To make the format safe, browser logic must exactly match backend semantics.

### GPS Validity

`validGps` must be `true` only if:

- at least 2 valid points exist
- `bbox`, `track_start`, `track_end` are present

Otherwise:

- `validGps = false`
- `points_count = 0` or `1`
- geometry fields must be omitted or null
- `gps_source = null` unless special business logic says otherwise

### Date Buckets

The browser must compute:

- `year`
- `month`
- `week`
- `year_quarter`
- `year_month`
- `year_week`

using the same UTC and ISO-week logic as [fitService.js](/Users/D025449/woa/src/services/fitService.js).

### Speed Units

Current backend row semantics store:

- `avg_speed`
- `max_speed`

in `km/h`, not `m/s`.

Browser must apply the same conversion.

### Normalized Power

`avg_normalized_power` must be the same rounded value the backend currently persists.

## Validation Rules

Backend should validate each `WOA1/V2` entry before inserting:

- magic/version correct
- `meta` JSON parses
- required fields present
- declared codecs allowed
- `stream` block present and non-empty
- `gps_track_blob` block present if `validGps === true`
- `points_count >= 2` if `validGps === true`
- `bbox`, `track_start`, `track_end` present if `validGps === true`
- `start_time` present and parseable

The backend should reject only the broken entry, not the whole upload, where feasible.

## Migration Strategy

### Phase 1

Keep current stable backend path.

Add a new browser builder that can emit `WOA1/V2` metadata plus precompressed stream blobs.

### Phase 2

Add a new backend import branch:

- detect `WOA1/V2`
- directly map `meta` to SQL params
- directly store `stream` and `gps_track_blob`
- no materialization

### Phase 3

Compare old and new results on the same sample imports:

- same row values
- same GPS visibility
- same thumbnails
- same stream readers
- same postprocess behavior

### Phase 4

Once stable, make `WOA1/V2` the default WOA upload path.

## Non-Goals

`WOA1/V2` does not need to preserve raw FIT semantics beyond what the product uses.

It is allowed to be a product-specific persistence contract, not a general interchange standard.

## Current Implementation Gap

Today, current `WOA1` is not yet self-contained enough for zero-materialization persistence because:

- row metadata is not yet the full authoritative insert contract
- stream blocks are not yet the final persisted blobs
- backend still rebuilds row semantics and recompresses blobs

`WOA1/V2` closes exactly that gap.
