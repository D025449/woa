const HEADER_BYTES = 16;
const SERIES_COUNT = 5;
const HEADER_OFFSET_LENGTH = 0;
const HEADER_OFFSET_START_TIME = 4;
const HEADER_OFFSET_VALID_GPS = 12;
const HEADER_OFFSET_FORMAT_VERSION = 13;
const STREAM_FORMAT_ABSOLUTE = 2;
const STREAM_FORMAT_CUMULATIVE_SI = 3; // cumulative with speed as m/s * 100
const STREAM_FORMAT_CUMULATIVE_SI_DISTANCE = 4; // + distance deltas (cm) as uint16
const STREAM_FORMAT_ABSOLUTE_COMPACT = 5; // compact absolute samples + optional distance deltas
const SPEED_SCALE_INTERNAL = 100; // store speed as m/s * 100
const ALTITUDE_SCALE_INTERNAL = 1000; // store altitude as m * 1000
const ALTITUDE_ABS_COMPACT_SCALE = 10; // compact absolute altitude storage in 0.1m
const MPS_TO_KMH = 3.6;
const FLAG_HAS_DISTANCE_DELTAS_CM = 1;

export default class Workout {

    constructor(buffer) {
        this.buffer = buffer;
        this.streamFormatVersion = Workout.readFormatVersion(buffer);
        this._initViews();
        this._computeDerived();
    }

    // =============================
    // EXPORT BUFFER (raw)
    // =============================
    toBuffer() {
        return this.buffer;
    }

    // =============================
    // EXPORT BUFFER (compressed)
    // =============================
    async toCompressedBuffer() {
        return Workout.compress(this.buffer);
    }


    // =============================
    // ENV DETECTION
    // =============================
    static isNode() {
        return typeof process !== "undefined" && process.versions?.node;
    }

    // =============================
    // INIT
    // =============================
    _initViews() {
        const view = new DataView(this.buffer);

        this.length = view.getUint32(HEADER_OFFSET_LENGTH);
        this.startTime = view.getFloat64(HEADER_OFFSET_START_TIME);
        this.validGps = view.getUint8(HEADER_OFFSET_VALID_GPS) === 1;

        this.streamFlags = view.getUint8(14) || 0;
        this.hasDistanceDeltas = (this.streamFlags & FLAG_HAS_DISTANCE_DELTAS_CM) !== 0;
        this.distanceDeltasCm = null;
        this.cumDistanceCm = null;
        this._initSeriesViewsByVersion();
        this._initDistanceSeries();
    }

    _initSeriesViewsByVersion() {
        if (this.streamFormatVersion === STREAM_FORMAT_ABSOLUTE_COMPACT) {
            let offset = HEADER_BYTES;

            this.absPower = new Uint16Array(this.buffer, offset, this.length); offset += this.length * 2;
            this.absHr = new Uint8Array(this.buffer, offset, this.length); offset += this.length;
            this.absCadence = new Uint8Array(this.buffer, offset, this.length); offset += this.length;
            this.absSpeed = new Uint16Array(this.buffer, offset, this.length); offset += this.length * 2;
            this.absAltitude = new Int16Array(this.buffer, offset, this.length);

            this.cumPower = new Uint32Array(this.length);
            this.cumHr = new Uint32Array(this.length);
            this.cumCadence = new Uint32Array(this.length);
            this.cumSpeed = new Uint32Array(this.length);
            this.cumAltitude = new Int32Array(this.length);

            let p = 0, hr = 0, cad = 0, speed = 0, alt = 0;
            for (let i = 0; i < this.length; i++) {
                p += this.absPower[i];
                hr += this.absHr[i];
                cad += this.absCadence[i];
                speed += this.absSpeed[i];
                alt += Math.round(this.absAltitude[i] * ALTITUDE_SCALE_INTERNAL / ALTITUDE_ABS_COMPACT_SCALE);
                this.cumPower[i] = p;
                this.cumHr[i] = hr;
                this.cumCadence[i] = cad;
                this.cumSpeed[i] = speed;
                this.cumAltitude[i] = alt;
            }
            return;
        }

        const BYTES = this.length * 4;
        let offset = HEADER_BYTES;

        this.cumPower = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumHr = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumCadence = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumSpeed = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumAltitude = new Int32Array(this.buffer, offset, this.length);
    }

    _initDistanceSeries() {
        let offset = HEADER_BYTES;
        if (this.streamFormatVersion === STREAM_FORMAT_ABSOLUTE_COMPACT) {
            offset += (this.length * 2); // power
            offset += this.length;       // hr
            offset += this.length;       // cadence
            offset += (this.length * 2); // speed
            offset += (this.length * 2); // altitude
        } else {
            offset += this.length * 4 * SERIES_COUNT;
        }

        if (!this.hasDistanceDeltas) {
            return;
        }

        this.distanceDeltasCm = new Uint16Array(this.buffer, offset, this.length);
        this.cumDistanceCm = new Uint32Array(this.length);

        let distSum = 0;
        for (let i = 0; i < this.length; i++) {
            distSum += this.distanceDeltasCm[i];
            this.cumDistanceCm[i] = distSum;
        }
    }

    // =============================
    // DERIVED VALUES
    // =============================
    _computeDerived() {
        this.elevationGainTotal = 0;
        this.normalizedPower = this._computeNormalizedPower();

        let prevAlt = null;

        for (let i = 0; i < this.length; i++) {
            const alt = this._altitudeInternalToMeters(this._getAltitudeAt(i));

            if (prevAlt != null) {
                const diff = alt - prevAlt;
                if (diff > 0) this.elevationGainTotal += diff;
            }

            prevAlt = alt;
        }
    }

    // =============================
    // FACTORY: FROM RECORDS
    // =============================
    static fromRecords(records, options = {}) {
        const length = records.length;

        const startTime = options.startTime ?? Date.now();
        const validGps = options.validGps ?? false;

        const hasDistanceSeries = records.some((r) => Number.isFinite(r?.distance));
        const DISTANCE_BYTES = hasDistanceSeries ? (length * 2) : 0;
        const CORE_BYTES = (length * 2) + length + length + (length * 2) + (length * 2); // u16,u8,u8,u16,i16
        const buffer = new ArrayBuffer(HEADER_BYTES + CORE_BYTES + DISTANCE_BYTES);
        const view = new DataView(buffer);

        // Header
        view.setUint32(HEADER_OFFSET_LENGTH, length);
        view.setFloat64(HEADER_OFFSET_START_TIME, startTime);
        view.setUint8(HEADER_OFFSET_VALID_GPS, validGps ? 1 : 0);
        view.setUint8(HEADER_OFFSET_FORMAT_VERSION, STREAM_FORMAT_ABSOLUTE_COMPACT);
        view.setUint8(14, hasDistanceSeries ? FLAG_HAS_DISTANCE_DELTAS_CM : 0);
        view.setUint8(15, 0);

        let offset = HEADER_BYTES;
        const absPower = new Uint16Array(buffer, offset, length); offset += length * 2;
        const absHr = new Uint8Array(buffer, offset, length); offset += length;
        const absCadence = new Uint8Array(buffer, offset, length); offset += length;
        const absSpeed = new Uint16Array(buffer, offset, length); offset += length * 2;
        const absAltitude = new Int16Array(buffer, offset, length); offset += length * 2;
        const distanceDeltasCm = hasDistanceSeries
            ? new Uint16Array(buffer, offset, length)
            : null;
        let prevDistanceCm = 0;

        for (let i = 0; i < length; i++) {
            const r = records[i];

            const p = Math.max(0, Math.min(0xffff, Math.round(r.power ?? 0)));
            const hr = Math.max(0, Math.min(0xff, Math.round(r.heart_rate ?? 0)));
            const cad = Math.max(0, Math.min(0xff, Math.round(r.cadence ?? 0)));
            const speed = Math.max(0, Math.min(0xffff, Math.round((r.speed ?? 0) * SPEED_SCALE_INTERNAL)));
            const altMeters = Number(r.altitude ?? 0);
            const altCompact = Math.round(altMeters * ALTITUDE_ABS_COMPACT_SCALE);
            if (altCompact < -32768 || altCompact > 32767) {
                throw new Error("Altitude out of range for compact Int16 (0.1m).");
            }

            absPower[i] = p;
            absHr[i] = hr;
            absCadence[i] = cad;
            absSpeed[i] = speed;
            absAltitude[i] = altCompact;

            if (distanceDeltasCm) {
                const distanceCm = Number.isFinite(r.distance)
                    ? Math.max(0, Math.round(r.distance * 100))
                    : prevDistanceCm;
                const delta = Math.max(0, distanceCm - prevDistanceCm);
                distanceDeltasCm[i] = Math.min(0xffff, delta);
                prevDistanceCm += distanceDeltasCm[i];
            }
        }

        return new Workout(buffer);
    }

    // =============================
    // FACTORY: FROM BUFFER
    // =============================
    static fromBuffer(buffer) {
        const version = this.readFormatVersion(buffer);

        if (version === STREAM_FORMAT_ABSOLUTE) {
            const cumulativeBuffer = this.convertAbsoluteBufferToCumulative(buffer);
            return new Workout(cumulativeBuffer);
        }

        if (
            version !== STREAM_FORMAT_CUMULATIVE_SI &&
            version !== STREAM_FORMAT_CUMULATIVE_SI_DISTANCE &&
            version !== STREAM_FORMAT_ABSOLUTE_COMPACT
        ) {
            throw new Error(`Unsupported workout stream format version: ${version}`);
        }

        return new Workout(buffer);
    }

    // =============================
    // FACTORY: FROM COMPRESSED
    // =============================
    static async fromCompressed(buffer) {
        const raw = await this.decompress(buffer);
        return this.fromBuffer(raw);
    }

    static readFormatVersion(buffer) {
        const view = new DataView(buffer);
        const version = view.getUint8(HEADER_OFFSET_FORMAT_VERSION);
        return version;
    }

    static convertAbsoluteBufferToCumulative(absBuffer) {
        const view = new DataView(absBuffer);
        const length = view.getUint32(HEADER_OFFSET_LENGTH);
        const startTime = view.getFloat64(HEADER_OFFSET_START_TIME);
        const validGps = view.getUint8(HEADER_OFFSET_VALID_GPS) === 1;

        const out = new ArrayBuffer(HEADER_BYTES + SERIES_COUNT * length * 4);
        const outView = new DataView(out);
        outView.setUint32(HEADER_OFFSET_LENGTH, length);
        outView.setFloat64(HEADER_OFFSET_START_TIME, startTime);
        outView.setUint8(HEADER_OFFSET_VALID_GPS, validGps ? 1 : 0);
        outView.setUint8(HEADER_OFFSET_FORMAT_VERSION, STREAM_FORMAT_CUMULATIVE_SI);

        const seriesBytes = length * 4;
        let inOffset = HEADER_BYTES;
        let outOffset = HEADER_BYTES;

        for (let s = 0; s < SERIES_COUNT; s++) {
            const isAltitudeSeries = s === 4;
            const absSeries = isAltitudeSeries
                ? new Int32Array(absBuffer, inOffset, length)
                : new Uint32Array(absBuffer, inOffset, length);
            const cumSeries = isAltitudeSeries
                ? new Int32Array(out, outOffset, length)
                : new Uint32Array(out, outOffset, length);
            let sum = 0;

            for (let i = 0; i < length; i++) {
                sum += absSeries[i];
                cumSeries[i] = sum;
            }

            inOffset += seriesBytes;
            outOffset += seriesBytes;
        }

        return out;
    }

    toAbsoluteBuffer() {
        const length = this.length;
        const out = new ArrayBuffer(HEADER_BYTES + SERIES_COUNT * length * 4);
        const view = new DataView(out);

        view.setUint32(HEADER_OFFSET_LENGTH, length);
        view.setFloat64(HEADER_OFFSET_START_TIME, this.startTime);
        view.setUint8(HEADER_OFFSET_VALID_GPS, this.validGps ? 1 : 0);
        view.setUint8(HEADER_OFFSET_FORMAT_VERSION, STREAM_FORMAT_ABSOLUTE);

        const writeAbsSeries = (sourceCum, targetOffset, signed = false) => {
            const target = signed
                ? new Int32Array(out, targetOffset, length)
                : new Uint32Array(out, targetOffset, length);
            if (length === 0) {
                return;
            }
            target[0] = sourceCum[0];
            for (let i = 1; i < length; i++) {
                target[i] = sourceCum[i] - sourceCum[i - 1];
            }
        };

        let offset = HEADER_BYTES;
        const step = length * 4;
        writeAbsSeries(this.cumPower, offset); offset += step;
        writeAbsSeries(this.cumHr, offset); offset += step;
        writeAbsSeries(this.cumCadence, offset); offset += step;
        writeAbsSeries(this.cumSpeed, offset); offset += step;
        writeAbsSeries(this.cumAltitude, offset, true);

        return out;
    }

    _speedInternalToKmh(value) {
        return (value / SPEED_SCALE_INTERNAL) * MPS_TO_KMH;
    }

    _altitudeInternalToMeters(value) {
        return value / ALTITUDE_SCALE_INTERNAL;
    }


    // =============================
    // INTERNAL
    // =============================
    _getAltitudeAt(i) {
        if (i === 0) return this.cumAltitude[0];
        return this.cumAltitude[i] - this.cumAltitude[i - 1];
    }

    _getPowerAt(i) {
        if (i === 0) return this.cumPower[0];
        return this.cumPower[i] - this.cumPower[i - 1];
    }

    _getSeriesValueAt(cumArray, i) {
        if (i === 0) return cumArray[0];
        return cumArray[i] - cumArray[i - 1];
    }

    _assertValidIndex(i) {
        if (!Number.isInteger(i) || i < 0 || i >= this.length) {
            throw new RangeError(`Invalid workout index: ${i}`);
        }
    }

    _assertValidRange(start, endExclusive) {
        if (!Number.isInteger(start) || !Number.isInteger(endExclusive)) {
            throw new RangeError(`Invalid workout range: ${start}..${endExclusive}`);
        }

        if (start < 0 || endExclusive < start || endExclusive > this.length) {
            throw new RangeError(`Invalid workout range: ${start}..${endExclusive}`);
        }
    }

    _getRangeAverageFromCum(cumArray, startIdx, endIdxInclusive) {
        const start = Math.max(0, Math.floor(startIdx));
        const end = Math.min(cumArray.length - 1, Math.floor(endIdxInclusive));

        if (end < start) {
            throw new Error("Invalid range");
        }

        const sum = cumArray[end] - (start > 0 ? cumArray[start - 1] : 0);
        const count = end - start + 1;

        return sum / count;
    }

    _computeNormalizedPower() {
        if (this.length === 0) return 0;

        if (this.length < 30) {
            let sumFourth = 0;

            for (let i = 0; i < this.length; i++) {
                const power = Math.max(0, this._getPowerAt(i));
                sumFourth += Math.pow(power, 4);
            }

            return Math.round(Math.pow(sumFourth / this.length, 1 / 4));
        }

        let windowSum = 0;
        let rollingCount = 0;
        let sumFourth = 0;

        for (let i = 0; i < this.length; i++) {
            windowSum += Math.max(0, this._getPowerAt(i));

            if (i >= 30) {
                windowSum -= Math.max(0, this._getPowerAt(i - 30));
            }

            if (i >= 29) {
                const rollingAverage = windowSum / 30;
                sumFourth += Math.pow(rollingAverage, 4);
                rollingCount += 1;
            }
        }

        return rollingCount > 0
            ? Math.round(Math.pow(sumFourth / rollingCount, 1 / 4))
            : 0;
    }

    // =============================
    // GETTER
    // =============================
    getStartTime() {
        return this.startTime;
    }

    isValidGps() {
        return this.validGps;
    }

    getElevationGainTotal() {
        return this.elevationGainTotal;
    }

    getNormalizedPower() {
        return this.normalizedPower;
    }

    // =============================
    // AVG (O(1))
    // =============================
    getAverages(start, end) {
        const s = Math.floor(start);
        const e = Math.floor(end);
        const duration = end - start;

        if (duration <= 0) throw new Error("Invalid range");

        const fracStart = start - s;
        const fracEnd = end - e;

        const calc = (cum) => {
            let sum = cum[e] - cum[s];

            const valStart = s > 0 ? cum[s] - cum[s - 1] : cum[0];
            const valEnd = cum[e] - cum[e - 1];

            sum -= valStart * fracStart;
            sum += valEnd * fracEnd;

            return sum / duration;
        };

        return {
            power: calc(this.cumPower),
            hr: calc(this.cumHr),
            cadence: calc(this.cumCadence),
            speed: this._speedInternalToKmh(calc(this.cumSpeed)),
            altitude: this._altitudeInternalToMeters(calc(this.cumAltitude))
        };
    }

    getCumBetween(start, end) {
        const s = Math.floor(start);
        const e = Math.floor(end);
        const duration = end - start;

        if (duration <= 0) throw new Error("Invalid range");

        const fracStart = start - s;
        const fracEnd = end - e;

        const calc = (cum) => {
            let sum = cum[e] - cum[s];

            const valStart = s > 0 ? cum[s] - cum[s - 1] : cum[0];
            const valEnd = cum[e] - cum[e - 1];

            sum -= valStart * fracStart;
            sum += valEnd * fracEnd;

            return sum;
        };

        return {
            power: calc(this.cumPower),
            hr: calc(this.cumHr),
            cadence: calc(this.cumCadence),
            speed: this._speedInternalToKmh(calc(this.cumSpeed)),
            altitude: this._altitudeInternalToMeters(calc(this.cumAltitude))
        };

    }

    // =============================
    // ABSOLUTE VALUES
    // =============================
    toAbsolute(cumArray) {
        const length = cumArray.length;
        const ResultType = cumArray.constructor;
        const result = new ResultType(length);

        if (length === 0) return result;

        result[0] = cumArray[0];

        for (let i = 1; i < length; i++) {
            result[i] = cumArray[i] - cumArray[i - 1];
        }

        return result;
    }

    getPower() { return this.toAbsolute(this.cumPower); }
    getHr() { return this.toAbsolute(this.cumHr); }
    getCadence() { return this.toAbsolute(this.cumCadence); }

    getPowerAt(i) {
        this._assertValidIndex(i);
        return this._getSeriesValueAt(this.cumPower, i);
    }

    getHrAt(i) {
        this._assertValidIndex(i);
        return this._getSeriesValueAt(this.cumHr, i);
    }

    getCadenceAt(i) {
        this._assertValidIndex(i);
        return this._getSeriesValueAt(this.cumCadence, i);
    }

    getSpeedAt(i) {
        this._assertValidIndex(i);
        return this._speedInternalToKmh(this._getSeriesValueAt(this.cumSpeed, i));
    }

    getAltitudeAt(i) {
        this._assertValidIndex(i);
        return this._altitudeInternalToMeters(this._getSeriesValueAt(this.cumAltitude, i));
    }

    hasDistanceSeries() {
        return !!this.hasDistanceDeltas;
    }

    getDistanceAt(i) {
        this._assertValidIndex(i);
        if (!this.cumDistanceCm) {
            return null;
        }
        return this.cumDistanceCm[i] / 100;
    }

    getMetricsAt(i) {
        this._assertValidIndex(i);
        return {
            power: this._getSeriesValueAt(this.cumPower, i),
            hr: this._getSeriesValueAt(this.cumHr, i),
            cadence: this._getSeriesValueAt(this.cumCadence, i),
            speed: this._speedInternalToKmh(this._getSeriesValueAt(this.cumSpeed, i)),
            altitude: this._altitudeInternalToMeters(this._getSeriesValueAt(this.cumAltitude, i))
        };
    }

    getMetricsForRange(start, endExclusive) {
        this._assertValidRange(start, endExclusive);

        const length = endExclusive - start;

        return {
            start,
            endExclusive,
            length,
            power: this._sliceAbsoluteSeries(this.cumPower, start, endExclusive),
            hr: this._sliceAbsoluteSeries(this.cumHr, start, endExclusive),
            cadence: this._sliceAbsoluteSeries(this.cumCadence, start, endExclusive),
            speed: this._sliceSpeedSeries(start, endExclusive),
            altitude: this._sliceAbsoluteSeries(this.cumAltitude, start, endExclusive, ALTITUDE_SCALE_INTERNAL)
        };
    }

    _sliceSpeedSeries(start, endExclusive) {
        const length = endExclusive - start;
        const result = new Array(length);

        for (let sourceIndex = start, targetIndex = 0; sourceIndex < endExclusive; sourceIndex++, targetIndex++) {
            result[targetIndex] = this._speedInternalToKmh(this._getSeriesValueAt(this.cumSpeed, sourceIndex));
        }

        return result;
    }

    _sliceAbsoluteSeries(cumArray, start, endExclusive, scale = 1, multiplier = 1) {
        const length = endExclusive - start;
        const result = new Array(length);

        for (let sourceIndex = start, targetIndex = 0; sourceIndex < endExclusive; sourceIndex++, targetIndex++) {
            result[targetIndex] = (this._getSeriesValueAt(cumArray, sourceIndex) / scale) * multiplier;
        }

        return result;
    }

    getSpeed() {
        const raw = this.toAbsolute(this.cumSpeed);
        return raw.map(v => this._speedInternalToKmh(v));
    }

    getAltitude() {
        return this._sliceAbsoluteSeries(this.cumAltitude, 0, this.length, ALTITUDE_SCALE_INTERNAL);
    }

    smoothSeriesCentered(cumArray, windowSize = 1, scale = 1) {
        const size = Math.max(1, Math.floor(windowSize));
        const out = new Int32Array(cumArray.length);

        if (size <= 1) {
            for (let i = 0; i < cumArray.length; i++) {
                out[i] = Math.round(this._getSeriesValueAt(cumArray, i) / scale);
            }
            return out;
        }

        const halfLeft = Math.floor((size - 1) / 2);
        const halfRight = size - 1 - halfLeft;

        for (let i = 0; i < cumArray.length; i++) {
            const start = Math.max(0, i - halfLeft);
            const end = Math.min(cumArray.length - 1, i + halfRight);

            out[i] = Math.round(this._getRangeAverageFromCum(cumArray, start, end) / scale);
        }

        return out;
    }

    // =============================
    // COMPRESS
    // =============================
    async compress() {
        return Workout.compress(this.buffer);
    }

    static async compress(buffer) {

        // 🔥 Node fast path
        if (this.isNode()) {
            const { brotliCompressSync, constants } = await import("zlib");

            return brotliCompressSync(Buffer.from(buffer), {
                params: {
                    [constants.BROTLI_PARAM_QUALITY]: 5
                }
            });
        }

        // Browser
        if (typeof CompressionStream !== "undefined") {
            const cs = new CompressionStream("brotli");
            const stream = new Blob([buffer]).stream().pipeThrough(cs);
            return new Response(stream).arrayBuffer();
        }

        throw new Error("Compression not supported");
    }

    // =============================
    // DECOMPRESS
    // =============================
    static async decompress(buffer) {

        // 🔥 Node fast path
        if (this.isNode()) {
            const { brotliDecompressSync } = await import("zlib");

            const result = brotliDecompressSync(buffer);

            return result.buffer.slice(
                result.byteOffset,
                result.byteOffset + result.byteLength
            );
        }

        // Browser
        if (typeof DecompressionStream !== "undefined") {
            const ds = new DecompressionStream("brotli");
            const stream = new Blob([buffer]).stream().pipeThrough(ds);
            return new Response(stream).arrayBuffer();
        }

        throw new Error("Decompression not supported");
    }

    // =============================
    // STRIDE ARRAY EXPORT (mit Index)
    // =============================
    getAsStrideArray(options = {}) {
        const n = this.length;
        const smoothing = options?.smoothing ?? {};

        const powers = this.smoothSeriesCentered(this.cumPower, smoothing.power ?? 10);
        const heartRates = this.smoothSeriesCentered(this.cumHr, smoothing.hr ?? 10);
        const cadences = this.smoothSeriesCentered(this.cumCadence, smoothing.cadence ?? 30);
        const speeds = this.smoothSeriesCentered(this.cumSpeed, smoothing.speed ?? 30);
        const altitudes = this.smoothSeriesCentered(this.cumAltitude, smoothing.altitude ?? 10);

        const strideSize = 7; // index + 5 Werte + DistanceKm
        const result = new Float64Array(n * strideSize);

        let offset = 0;

        for (let i = 0; i < n; i++) {
            result[offset++] = i;      // 👈 Index zuerst
            result[offset++] = powers[i];
            result[offset++] = heartRates[i];
            result[offset++] = cadences[i];
            result[offset++] = this._speedInternalToKmh(speeds[i]);
            result[offset++] = this._altitudeInternalToMeters(altitudes[i]);
            const distanceM = this.getDistanceAt(i);
            result[offset++] = Number.isFinite(distanceM) ? distanceM / 1000 : 0;
        }

        return {
            data: result,
            rowCount: n + 1
        };
    }



    createNewSegment(startEnd, segmenttype = 'manual') {



        let startIndex = startEnd.startIndex;
        let endIndex = startEnd.endIndex;
        if (endIndex < startIndex) {
            const aaa = endIndex;
            endIndex = startIndex;
            startIndex = aaa;
        }
        if ((endIndex - startIndex) < 2) {
            return null;
        }
        const duration = endIndex - startIndex;

        const avgs = this.getAverages(startIndex, endIndex);
        const cum = this.getCumBetween(startIndex, endIndex);
        return {
            id: globalThis.crypto.randomUUID(),
            start_offset: startIndex,
            end_offset: endIndex,
            duration: duration,
            avg_power: Math.round(avgs.power),
            avg_heart_rate: Math.round(avgs.hr),
            avg_cadence: Math.round(avgs.cadence),
            avg_speed: Math.round(avgs.speed*10)/10,
            altimeters: Math.round(cum.altimeters),
            segmenttype: segmenttype,
            rowstate: 'CRE',
            segmentname: ''
        };
    }


}
