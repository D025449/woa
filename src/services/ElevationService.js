export default class ElevationService {
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || "https://api.opentopodata.org/v1/srtm90m";
        this.batchSize = options.batchSize || 100;
        this.sleepMs = options.sleepMs || 200;

        // 🔥 Downsampling Config
        this.downsampleStep = options.downsampleStep || 1; // z. B. 5 = jeder 5. Punkt
        this.useDownsampling = this.downsampleStep > 1;
    }

    // -----------------------------
    // PUBLIC
    // -----------------------------
    async enrichTrack(track) {
        let workingTrack = track;

        if (this.useDownsampling) {
            workingTrack = this.downsampleTrack(track, this.downsampleStep);
        }

        const enriched = await this.fetchElevations(workingTrack);

        // 🔥 zurück auf original Track mappen
        if (this.useDownsampling) {
            return this.interpolateElevations(track, enriched);
        }

        return enriched;
    }

    // -----------------------------
    // FETCH
    // -----------------------------
    async fetchElevations(track) {
        const result = track.map(p => ({ ...p }));

        const chunks = this.chunkArray(track, this.batchSize);

        let globalIndex = 0;

        for (const chunk of chunks) {
            const elevations = await this.fetchBatch(chunk);

            for (let i = 0; i < chunk.length; i++) {
                result[globalIndex].ele = elevations[i];
                globalIndex++;
            }

            await this.sleep(this.sleepMs);
        }

        return result;
    }

    async fetchBatch(points) {
        const coords = points.map(p => `${p.lat},${p.lng}`).join("|");
        const url = `${this.apiUrl}?locations=${coords}`;

        try {
            const res = await fetch(url);
            const data = await res.json();

            return data.results.map(r => r.elevation ?? null);
        } catch (err) {
            console.error("Elevation fetch failed:", err);
            return points.map(() => null);
        }
    }

    // -----------------------------
    // DOWNSAMPLING
    // -----------------------------
    downsampleTrack(track, step) {
        const result = [];

        for (let i = 0; i < track.length; i += step) {
            result.push({
                ...track[i],
                _originalIndex: i
            });
        }

        // letzter Punkt sicherstellen
        if (track.length > 0 && result[result.length - 1]._originalIndex !== track.length - 1) {
            result.push({
                ...track[track.length - 1],
                _originalIndex: track.length - 1
            });
        }

        return result;
    }

    // -----------------------------
    // INTERPOLATION zurück
    // -----------------------------
    interpolateElevations(originalTrack, sampledTrack) {
        const result = originalTrack.map(p => ({ ...p }));

        let j = 0;

        for (let i = 0; i < originalTrack.length; i++) {

            while (
                j < sampledTrack.length - 1 &&
                sampledTrack[j + 1]._originalIndex < i
            ) {
                j++;
            }

            const p1 = sampledTrack[j];
            const p2 = sampledTrack[j + 1];

            if (!p2) {
                result[i].ele = p1.ele;
                continue;
            }

            const i1 = p1._originalIndex;
            const i2 = p2._originalIndex;

            const ratio = (i - i1) / (i2 - i1);

            result[i].ele =
                p1.ele != null && p2.ele != null
                    ? p1.ele + ratio * (p2.ele - p1.ele)
                    : p1.ele ?? p2.ele ?? null;
        }

        return result;
    }

    // -----------------------------
    // UTILS
    // -----------------------------
    chunkArray(arr, size) {
        const res = [];
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // -----------------------------
    // Höhenmeter
    // -----------------------------
    calculateAscent(track) {
        let ascent = 0;

        for (let i = 1; i < track.length; i++) {
            const diff = (track[i].ele ?? 0) - (track[i - 1].ele ?? 0);

            if (diff > ( 1 / this.downsampleStep )) ascent += diff;
        }

        return Math.round(ascent);
    }
}