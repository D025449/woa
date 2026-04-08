export default class SegmentMatcher {

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

    // -----------------------------
    // Find nearest indices
    // -----------------------------
    static findNearbyIndices(workout, point, maxDist) {
        const indices = [];

        for (let i = 0; i < workout.length; i++) {
            if (this.distance(workout[i], point) < maxDist) {
                indices.push(i);
            }
        }

        return indices;
    }


    // new:
    static findProjectionCandidates(point, polyline, maxDist, startScanIndex = 0, maxHitCount = 100) {
        const results = [];

        for (let i = startScanIndex; i < polyline.length - 1; i++) {

            const a = polyline[i];
            const b = polyline[i + 1];

            const dx = b.lng - a.lng;
            const dy = b.lat - a.lat;

            if (dx === 0 && dy === 0) continue;

            const t =
                ((point.lng - a.lng) * dx + (point.lat - a.lat) * dy) /
                (dx * dx + dy * dy);

            // 👉 WICHTIG: nur echte Projektionen im Segment
            if (t < 0 || t > 1) continue;

            const proj = {
                lng: a.lng + t * dx,
                lat: a.lat + t * dy
            };

            const dist = this.distance(point, proj);

            if (dist < maxDist) {
                results.push({
                    index: i,
                    t,
                    dist
                });
                if (results.length >= maxHitCount) {
                    return results
                }
            }
        }

        return results;
    }

    // new
    static projectPointOnSegment(p, a, b) {
        const dx = b.lng - a.lng;
        const dy = b.lat - a.lat;

        if (dx === 0 && dy === 0) {
            return { t: 0, point: a };
        }

        const t =
            ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) /
            (dx * dx + dy * dy);

        const clamped = Math.max(0, Math.min(1, t));

        return {
            t: clamped,
            point: {
                lng: a.lng + clamped * dx,
                lat: a.lat + clamped * dy
            }
        };
    }
    // new 
    static projectPointOnPolyline(point, workouttrack, startScanIndex = 0) {
        let best = {
            dist: Infinity,
            index: -1,
            t: 0
        };

        for (let i = startScanIndex; i < workouttrack.length - 1; i++) {

            const { t, point: proj } =
                this.projectPointOnSegment(point, workouttrack[i], workouttrack[i + 1]);

            const d = this.distance(point, proj);

            if (d < best.dist) {
                best = {
                    dist: d,
                    index: i,
                    t
                };
            }
        }

        return best;
    }

    // -----------------------------
    // Find nearest indices V2
    // -----------------------------
    static findNearbyIndicesV2(workout, point, maxDist) {
        const indices = [];

        for (let i = 0; i < workout.length; i++) {
            if (this.distance(workout[i], point) < maxDist) {
                indices.push(i);
            }
        }

        return indices;
    }

    // -----------------------------
    // 🔥 VALIDATION (Polyline!)
    // -----------------------------
    static validateSegment(workout, segment, startIdx, endIdx, maxDist) {

        const checkPoints = [
            segment[Math.floor(segment.length * 0.25)],
            segment[Math.floor(segment.length * 0.5)],
            segment[Math.floor(segment.length * 0.75)]
        ];

        for (const sp of checkPoints) {

            let found = false;

            for (let i = startIdx; i <= endIdx; i++) {

                const dist = this.pointToPolylineDistance(
                    sp,
                    [workout[i], workout[Math.min(i + 1, endIdx)]]
                );

                if (dist < maxDist) {
                    found = true;
                    break;
                }
            }

            if (!found) return false;
        }

        return true;
    }

    // -----------------------------
    // MAIN
    // -----------------------------
    static findMatches(workout, segmentObj, options = {}) {

        const downsamplingFactor = workout.sampleRate ?? 1;
        
        const segment = segmentObj.track;
        const segmentId = segmentObj.id;

        const MAX_DIST = options.maxDist ?? 20;

        const matches = [];
        //let lastEnd = -1;
        let lastEndCandidate = {
            index: -1,
            t: 0,
            dist: 0
        };

        const startPoint = segment[0];
        const endPoint = segment[segment.length - 1];

        //const startCandidates = this.findNearbyIndices(workout, startPoint, MAX_DIST);
        const startCandidatesV2 = this.findProjectionCandidates(startPoint, workout.track, MAX_DIST, 0, 100);


        for (const startCandidate of startCandidatesV2) {
            if (startCandidate.index <= lastEndCandidate.index) continue;
            const endCandidates = this.findProjectionCandidates(endPoint, workout.track, MAX_DIST, startCandidate.index + 1, 1);
            if (endCandidates.length < 1) {
                continue;
            }
            const endCandidate = endCandidates[0];
            if (this.validateSegment(workout.track, segment, startCandidate.index, endCandidate.index, MAX_DIST)) {
                matches.push({
                    workout_id: workout.wid,
                    segment_id: segmentId,
                    start_offset: Math.round((startCandidate.index + startCandidate.t) * downsamplingFactor),
                    end_offset: Math.round((endCandidate.index + endCandidate.t) * downsamplingFactor),
                });
                lastEndCandidate = endCandidate;
            }

            /*for (let i = startCandidate.index + 1; i < workout.length; i++) {


                if (this.distance(workout[i], endPoint) < MAX_DIST) {

                    const endIdx = i;

                    if (this.validateSegment(workout, segment, startIdx, endIdx, MAX_DIST)) {

                        matches.push({
                            segment_id: segmentId,
                            start_offset: startIdx,
                            end_offset: endIdx
                        });

                        lastEnd = endIdx;
                        break;
                    }
                }
            }*/
        }


        /*for (const startIdx of startCandidates) {

            if (startIdx <= lastEnd) continue;

            for (let i = startIdx + 1; i < workout.length; i++) {

                if (this.distance(workout[i], endPoint) < MAX_DIST) {

                    const endIdx = i;

                    if (this.validateSegment(workout, segment, startIdx, endIdx, MAX_DIST)) {

                        matches.push({
                            segment_id: segmentId,
                            start_offset: startIdx,
                            end_offset: endIdx
                        });

                        lastEnd = endIdx;
                        break;
                    }
                }
            }
        }*/

        return matches;
    }
}