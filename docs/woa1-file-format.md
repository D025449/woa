# WOA1 File Format Specification

## Purpose

`WOA1` is a binary container format for one workout. It is designed as a transport format between browser-side FIT preprocessing and backend import.

Goals:

- compact representation of one workout
- fast decode on the backend
- preserve the data required for current workout import
- avoid reparsing FIT on the server

The format currently contains four logical parts:

1. metadata JSON
2. sessions JSON
3. dense workout stream block
4. reduced GPS track block

This document describes the format as implemented in:

- [woa-format.js](/Users/D025449/woa/src/public/js/woa-format.js)
- [woa1Service.js](/Users/D025449/woa/src/services/woa1Service.js)

## Byte Order

All integer and floating-point values are encoded as `little-endian`.

## Top-Level Container

The top-level file starts with the ASCII magic `WOA1`.

### Header Layout

Offset | Size | Type | Meaning
--- | --- | --- | ---
0 | 4 | ASCII | Magic = `WOA1`
4 | 1 | `uint8` | Major version, currently `1`
5 | 1 | `uint8` | Minor version, currently `0`
6 | 2 | `uint16` | Reserved, currently `0`
8 | 4 | `uint32` | Metadata JSON byte length
12 | 4 | `uint32` | Sessions JSON byte length
16 | 4 | `uint32` | Workout stream block byte length
20 | 4 | `uint32` | GPS track block byte length

Total header length: `24` bytes.

### Body Layout

Immediately after the 24-byte header, the four payload blocks follow in this order:

1. metadata JSON bytes
2. sessions JSON bytes
3. workout stream block
4. GPS track block

There is no padding between blocks.

## Metadata JSON Block

The metadata block is UTF-8 encoded JSON.

It is generated from the parsed FIT data plus the reduced GPS track summary. It is informational and import-oriented, not the canonical numeric workout stream.

Current fields written by the encoder include:

- `sourceName`
- `sourceFormat`
- `recordCount`
- `pointsCount`
- `sampleRateGps`
- `validGps`
- `gpsSource`
- `startTime`
- `endTime`
- `totalElapsedTime`
- `totalTimerTime`
- `totalDistance`
- `totalCycles`
- `totalWork`
- `totalCalories`
- `totalAscent`
- `totalDescent`
- `avgSpeed`
- `maxSpeed`
- `avgPower`
- `maxPower`
- `avgHeartRate`
- `maxHeartRate`
- `avgCadence`
- `maxCadence`
- `normalizedPower`
- `bbox`
- `startPoint`
- `endPoint`

Notes:

- `gpsSource` is currently `"manual_lookup"` or `"recorded"`.
- This block is not performance-critical at decode time compared to the binary stream blocks.

## Sessions JSON Block

The sessions block is UTF-8 encoded JSON.

It contains the FIT-derived session array as-is from the typed parser pipeline.

Usage:

- preserves session-level values needed by current aggregation/import logic
- allows backend aggregation to reuse existing session-processing code

## Workout Stream Block

The workout stream block starts with ASCII magic `WST3`.

It stores dense per-record arrays for the main workout stream with an implicit 1-second sample interval.

### Header Layout

Offset | Size | Type | Meaning
--- | --- | --- | ---
0 | 4 | ASCII | Magic = `WST3`
4 | 4 | `uint32` | Record count
8 | 8 | `float64` | Base timestamp in milliseconds since Unix epoch
16 | 4 | `uint32` | Sample interval in milliseconds, currently `1000`
20 | 4 | `uint32` | Distance payload byte length
24 | 4 | `uint32` | Power payload byte length
28 | 4 | `uint32` | Heart-rate payload byte length
32 | 4 | `uint32` | Cadence payload byte length
36 | 4 | `uint32` | Speed payload byte length
40 | 4 | `uint32` | Altitude payload byte length
44 | 4 | `uint32` | Latitude payload byte length
48 | 4 | `uint32` | Longitude payload byte length

Total header length: `52` bytes.

### Implicit Timestamp Model

Timestamps are not stored per record.

Instead:

- record `0` timestamp = `baseTimestampMs`
- record `i` timestamp = `baseTimestampMs + i * sampleIntervalMs`

Current assumptions:

- the stream is normalized to 1-second spacing
- sample interval is currently always `1000 ms`

## Workout Stream Field Encoding

### Sentinel Values

Type | Sentinel | Meaning
--- | --- | ---
`uint8` | `0xFF` | missing
`uint16` | `0xFFFF` | missing
`uint32` | `0xFFFFFFFF` | missing
`int16` | `-0x8000` | missing
`int32` | `-0x80000000` | missing

### Field Order

The payload sections follow directly after the `WST3` header in this order:

1. distance payload
2. power payload
3. heart-rate payload
4. cadence payload
5. speed payload
6. altitude payload
### Distances

- logical unit: meters
- stored unit: decimeters
- storage type: custom payload with optional delta encoding

Encoding:

- finite distance value `d` is stored as `round(d * 10)`
- missing distance is stored as `UINT32_NAN`

#### Distance Delta Payload

Distances are split into blocks of `128` records.

Each block is encoded in one of two modes.

##### Mode 0: Raw

Offset in block | Size | Type | Meaning
--- | --- | --- | ---
0 | 1 | `uint8` | Mode = `0`
1 | 2 | `uint16` | Count in this block
3 | `count * 4` | `uint32[count]` | Raw decimeter values

##### Mode 1: Delta

Allowed only when:

- all values in the block are finite
- all deltas between consecutive values fit into signed 16-bit range `[-32767, 32767]`

Offset in block | Size | Type | Meaning
--- | --- | --- | ---
0 | 1 | `uint8` | Mode = `1`
1 | 2 | `uint16` | Count in this block
3 | 4 | `uint32` | First value
7 | `(count - 1) * 2` | `int16[count - 1]` | Deltas to previous value

Decoding:

- first output = first value
- every next output = previous output + delta
- final logical value = decoded integer / `10`

### Power

- logical unit: watts
- stored unit: integer watts
- storage type: `uint16`

Encoding:

- finite power `p` -> `round(p)`
- missing -> `0xFFFF`

### Heart Rate

- logical unit: bpm
- stored unit: integer bpm
- storage type: `uint8`

Encoding:

- finite HR -> rounded integer
- missing -> `0xFF`

### Cadence

- logical unit: rpm
- stored unit: integer rpm
- storage type: `uint8`

Encoding:

- finite cadence -> rounded integer
- missing -> `0xFF`

### Speed

- logical unit: meters per second
- stored unit: centimeters per second
- storage type: `uint16`

Encoding:

- finite speed `s` -> `round(s * 100)`
- missing -> `0xFFFF`

Optimization:

- if the distance series is complete for all records, the speed block is omitted entirely
- in that case its byte length in the header is `0`
- decoder reconstructs speed as first difference of cumulative distance

Current decoder behavior when omitted:

- `speed[0] = NaN`
- for `i > 0`: `speed[i] = max(0, distance[i] - distance[i - 1])`

Since distance is in meters and the sample interval is 1 second, this yields `m/s`.

### Altitude

- logical unit: meters
- stored unit: decimeters
- storage type: `int16`

Encoding:

- finite altitude `a` -> `round(a * 10)`
- missing -> `INT16_NAN`

## GPS Track Block

The reduced GPS track block starts with ASCII magic `GPS2`.

It stores a reduced track, currently downsampled to one point every `sampleRateSeconds` seconds, typically `5`.

### Header Layout

Offset | Size | Type | Meaning
--- | --- | --- | ---
0 | 4 | ASCII | Magic = `GPS2`
4 | 2 | `uint16` | Track block version, currently `1`
6 | 2 | `uint16` | GPS sample rate in seconds
8 | 4 | `uint32` | Point count
12 | 8 | `float64` | First timestamp in milliseconds since Unix epoch

Total header length: `20` bytes.

The coordinate payload starts immediately at offset `20`.

### Reduced Track Construction

The encoder builds the reduced track from the full typed record stream:

- walks full record stream in order
- requires finite latitude, longitude and timestamp
- keeps the first valid point
- then only keeps points at least `sampleRateSeconds * 1000` ms after the last accepted point

The reduced track therefore has:

- `sampleRateSeconds`
- `pointCount`
- `bbox`
- `startPoint`
- `endPoint`

### GPS Coordinate Payload

GPS points are stored in blocks of `128` points, similar to distance encoding.

Coordinates use:

- latitude as signed `int32` microdegrees
- longitude as signed `int32` microdegrees

#### Mode 0: Raw

Offset in block | Size | Type | Meaning
--- | --- | --- | ---
0 | 1 | `uint8` | Mode = `0`
1 | 2 | `uint16` | Count in this block
3 | `count * 8` | pairs of `int32 lat`, `int32 lng` | Raw coordinates

#### Mode 1: Delta

Allowed only when:

- all points in the block are finite
- each latitude delta fits into `[-32767, 32767]`
- each longitude delta fits into `[-32767, 32767]`

Offset in block | Size | Type | Meaning
--- | --- | --- | ---
0 | 1 | `uint8` | Mode = `1`
1 | 2 | `uint16` | Count in this block
3 | 4 | `int32` | First latitude
7 | 4 | `int32` | First longitude
11 | `(count - 1) * 4` | repeated `int16 dLat`, `int16 dLng` pairs | Coordinate deltas

Decoding:

- first point is absolute
- each next point adds `dLat` and `dLng` to previous point
- final logical value = decoded integer / `1e7`

### GPS Decoder Output Shape

Backend decoder currently returns:

- `validGps`
- `pointCount`
- `sampleRate`
- `bbox`
- `firstTimestampMs`
- `track`

`track` is currently returned as array of `[lat, lng]` pairs.

## Versioned Magics

Currently used block magics:

- container: `WOA1`
- workout stream block: `WST3`
- reduced GPS block: `GPS2`

Legacy note:

- the backend decoder remains compatible with older `WST2` payloads
- `WST2` additionally stored full-resolution per-record `lat/lng` arrays
- `WST3` removes those redundant arrays and keeps GPS only in `GPS2`

These magics are part of the compatibility contract.

## Backend Reconstruction

Current backend decode flow:

1. parse `WOA1` container header
2. decode metadata JSON
3. decode sessions JSON
4. decode `WST3` into dense typed arrays
5. decode `GPS2` into reduced GPS track
6. aggregate sessions with existing `FitProcessor`
7. build `Workout` object from typed arrays
8. map aggregated workout row for database insert

This means the canonical import payload is:

- `recordsTyped` from `WST3`
- `sessions` from session JSON
- reduced GPS track from `GPS2`

## Current Assumptions and Constraints

The current implementation assumes:

- one workout per file
- one-second normalized workout stream
- reduced GPS track separate from full workout stream GPS arrays
- UTF-8 JSON for metadata and sessions
- little-endian binary encoding

Not currently included:

- checksums
- compression inside the `WOA1` file itself
- optional block table
- random access index
- multiple workouts in one `WOA1` file

## Common Usage Pattern

Current practical transport pattern is:

1. browser converts FIT to raw `WOA1`
2. many `.woa1` files are placed into a ZIP archive
3. ZIP archive is uploaded to backend
4. backend reads ZIP entries, decodes each `WOA1`, bulk inserts workouts

So:

- `WOA1` is the per-workout binary format
- `.woa1.zip` is the current batch transport envelope

## Forward Compatibility Notes

If the format evolves, the safest strategy is:

- keep the outer magic `WOA1`
- bump major/minor version bytes
- introduce new internal block magics if block structure changes
- preserve little-endian encoding
- keep unknown future blocks skippable via explicit length fields

## Summary

`WOA1` is a four-block binary workout container:

- JSON metadata
- JSON sessions
- `WST3` dense workout stream
- `GPS2` reduced GPS track

It optimizes for:

- fast server import
- compact transport
- simple deterministic decode
- minimal dependency on FIT parsing in backend
