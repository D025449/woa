export default class Workout {

    constructor(buffer) {
        this.buffer = buffer;
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

        this.length = view.getUint32(0);
        this.startTime = view.getFloat64(4);
        this.validGps = view.getUint8(12) === 1;

        const HEADER = 16;
        const BYTES = this.length * 4;

        let offset = HEADER;

        this.cumPower = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumHr = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumCadence = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumSpeed = new Uint32Array(this.buffer, offset, this.length); offset += BYTES;
        this.cumAltitude = new Uint32Array(this.buffer, offset, this.length);
    }

    // =============================
    // DERIVED VALUES
    // =============================
    _computeDerived() {
        this.elevationGainTotal = 0;
        this.normalizedPower = this._computeNormalizedPower();

        let prevAlt = null;

        for (let i = 0; i < this.length; i++) {
            const alt = this._getAltitudeAt(i);

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

        const HEADER = 16;
        const ARRAYS = 5;
        const BYTES = length * 4;

        const buffer = new ArrayBuffer(HEADER + ARRAYS * BYTES);
        const view = new DataView(buffer);

        // Header
        view.setUint32(0, length);
        view.setFloat64(4, startTime);
        view.setUint8(12, validGps ? 1 : 0);

        let offset = HEADER;

        const cumPower = new Uint32Array(buffer, offset, length); offset += BYTES;
        const cumHr = new Uint32Array(buffer, offset, length); offset += BYTES;
        const cumCadence = new Uint32Array(buffer, offset, length); offset += BYTES;
        const cumSpeed = new Uint32Array(buffer, offset, length); offset += BYTES;
        const cumAltitude = new Uint32Array(buffer, offset, length);

        let pSum = 0, hrSum = 0, cadSum = 0, speedSum = 0, altSum = 0;

        for (let i = 0; i < length; i++) {
            const r = records[i];

            const p = r.power ?? 0;
            const hr = r.heart_rate ?? 0;
            const cad = r.cadence ?? 0;
            const speed = r.speed != null ? Math.round(r.speed * 10) : 0;
            const alt = Math.round((r.altitude ?? 0) * 1000);

            pSum += p;
            hrSum += hr;
            cadSum += cad;
            speedSum += speed;
            altSum += alt;

            cumPower[i] = pSum;
            cumHr[i] = hrSum;
            cumCadence[i] = cadSum;
            cumSpeed[i] = speedSum;
            cumAltitude[i] = altSum;
        }

        return new Workout(buffer);
    }

    // =============================
    // FACTORY: FROM BUFFER
    // =============================
    static fromBuffer(buffer) {
        return new Workout(buffer);
    }

    // =============================
    // FACTORY: FROM COMPRESSED
    // =============================
    static async fromCompressed(buffer) {
        const raw = await this.decompress(buffer);
        return new Workout(raw);
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
            speed: calc(this.cumSpeed) / 10,
            altitude: calc(this.cumAltitude)
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
            speed: calc(this.cumSpeed) / 10,
            altitude: calc(this.cumAltitude)
        };

    }

    // =============================
    // ABSOLUTE VALUES
    // =============================
    toAbsolute(cumArray) {
        const length = cumArray.length;
        const result = new Uint32Array(length);

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
        return this._getSeriesValueAt(this.cumSpeed, i) / 10;
    }

    getAltitudeAt(i) {
        this._assertValidIndex(i);
        return this._getSeriesValueAt(this.cumAltitude, i);
    }

    getMetricsAt(i) {
        this._assertValidIndex(i);
        return {
            power: this._getSeriesValueAt(this.cumPower, i),
            hr: this._getSeriesValueAt(this.cumHr, i),
            cadence: this._getSeriesValueAt(this.cumCadence, i),
            speed: this._getSeriesValueAt(this.cumSpeed, i) / 10,
            altitude: this._getSeriesValueAt(this.cumAltitude, i)
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
            speed: this._sliceAbsoluteSeries(this.cumSpeed, start, endExclusive, 10),
            altitude: this._sliceAbsoluteSeries(this.cumAltitude, start, endExclusive)
        };
    }

    _sliceAbsoluteSeries(cumArray, start, endExclusive, scale = 1) {
        const length = endExclusive - start;
        const result = new Array(length);

        for (let sourceIndex = start, targetIndex = 0; sourceIndex < endExclusive; sourceIndex++, targetIndex++) {
            result[targetIndex] = this._getSeriesValueAt(cumArray, sourceIndex) / scale;
        }

        return result;
    }

    getSpeed() {
        const raw = this.toAbsolute(this.cumSpeed);
        return raw.map(v => v / 10);
    }

    getAltitude() {
        return this.toAbsolute(this.cumAltitude);
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
        const speeds = this.smoothSeriesCentered(this.cumSpeed, smoothing.speed ?? 30, 10);
        const altitudes = this.smoothSeriesCentered(this.cumAltitude, smoothing.altitude ?? 10);

        const strideSize = 6; // index + 5 Werte
        const result = new Int32Array(n * strideSize);

        let offset = 0;

        for (let i = 0; i < n; i++) {
            result[offset++] = i;      // 👈 Index zuerst
            result[offset++] = powers[i] | 0;
            result[offset++] = heartRates[i] | 0;
            result[offset++] = cadences[i] | 0;
            result[offset++] = speeds[i] | 0;
            result[offset++] = altitudes[i] | 0;
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
