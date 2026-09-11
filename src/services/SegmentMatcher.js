import {
    toCompactGpsTrack,
    matchCompactGpsSegmentBestEfforts,
    prepareCompactGpsSegmentDefinitions
} from "../shared/CompactGpsSegmentMatcher.js";

export default class SegmentMatcher {
    static getPointProgress(point, fallbackIndex = 0) {
        if (point?.sampleOffset != null && Number.isFinite(Number(point.sampleOffset))) {
            return Number(point.sampleOffset);
        }
        if (point?.slotIndex != null && Number.isFinite(Number(point.slotIndex))) {
            return Number(point.slotIndex);
        }
        return fallbackIndex;
    }

    static normalizeWorkoutSegments(workout = {}) {
        const rawSegments = Array.isArray(workout?.segments) && workout.segments.length
            ? workout.segments
            : (Array.isArray(workout?.track) && workout.track.length ? [workout.track] : []);

        return rawSegments
            .map((segment) => (Array.isArray(segment) ? segment : [])
                .map((point, index) => ({
                    lat: Number(point?.lat),
                    lng: Number(point?.lng),
                    slotIndex: Number.isFinite(Number(point?.slotIndex)) ? Number(point.slotIndex) : index,
                    sampleOffset: Number.isFinite(Number(point?.sampleOffset)) ? Number(point.sampleOffset) : null
                }))
                .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)))
            .filter((segment) => segment.length >= 2);
    }

    // -----------------------------
    // Haversine Distance
    // -----------------------------
    static distance(p1, p2) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;

        const lat1 = toRad(p1.lat);
        const lat2 = toRad(p2.lat);
        const dLat = toRad(p2.lat - p1.lat);
        const dLng = toRad(p2.lng - p1.lng);

        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLng / 2) ** 2;

        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // -----------------------------
    // Punkt → Liniensegment Distanz
    // -----------------------------
    static pointToSegmentDistance(p, a, b) {
        const dx = b.lng - a.lng;
        const dy = b.lat - a.lat;

        if (dx === 0 && dy === 0) {
            return this.distance(p, a);
        }

        const t =
            ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) /
            (dx * dx + dy * dy);

        const clamped = Math.max(0, Math.min(1, t));

        const proj = {
            lng: a.lng + clamped * dx,
            lat: a.lat + clamped * dy
        };

        return this.distance(p, proj);
    }

    // -----------------------------
    // Punkt → Polyline Distanz
    // -----------------------------
    static pointToPolylineDistance(point, polyline) {
        let min = Infinity;

        for (let i = 0; i < polyline.length - 1; i++) {
            const d = this.pointToSegmentDistance(
                point,
                polyline[i],
                polyline[i + 1]
            );

            if (d < min) min = d;
        }

        return min;
    }

    // Compatibility adapter for callers with object tracks. Matching itself is E5-only.
    static findMatches(workout, segmentObj) {
        const track = toCompactGpsTrack({
            segments: this.normalizeWorkoutSegments(workout),
            sampleRateSeconds: workout.sampleRate ?? 1
        });
        return matchCompactGpsSegmentBestEfforts(
            track, prepareCompactGpsSegmentDefinitions([segmentObj])
        ).matches.map((match) => ({
            workout_id: workout.wid,
            segment_id: match.segmentId,
            start_offset: match.startOffset,
            end_offset: match.endOffset
        }));
    }
}
