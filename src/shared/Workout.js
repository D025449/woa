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
            const alt = Math.round((r.altitude ?? 0)*1000);

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

    getSpeed() {
        const raw = this.toAbsolute(this.cumSpeed);
        return raw.map(v => v / 10);
    }

    getAltitude() {
        return this.toAbsolute(this.cumAltitude);
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
getAsStrideArray() {
    const n = this.length;

    const strideSize = 6; // index + 5 Werte
    const result = new Int32Array(n * strideSize);

    let offset = 0;

    for (let i = 0; i < n; i++) {
        const p = i === 0 ? this.cumPower[0] : this.cumPower[i] - this.cumPower[i - 1];
        const hr = i === 0 ? this.cumHr[0] : this.cumHr[i] - this.cumHr[i - 1];
        const cad = i === 0 ? this.cumCadence[0] : this.cumCadence[i] - this.cumCadence[i - 1];
        const speed = i === 0 ? this.cumSpeed[0] : this.cumSpeed[i] - this.cumSpeed[i - 1];
        const alt = i === 0 ? this.cumAltitude[0] : this.cumAltitude[i] - this.cumAltitude[i - 1];

        result[offset++] = i;      // 👈 Index zuerst
        result[offset++] = p | 0;
        result[offset++] = hr | 0;
        result[offset++] = cad | 0;
        result[offset++] = speed | 0;
        result[offset++] = alt | 0;
    }

    return {
        data: result,
        rowCount: n + 1
    };
}

}