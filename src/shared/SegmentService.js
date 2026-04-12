//import { ServerSideEncryption } from "@aws-sdk/client-s3";
import Utils from "./Utils.js";

export default class SegmentService {


    static createAddNewSegment(workout, startEnd, segmenttype = 'manual') {
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

        const { series, STRIDE } = workout;

        let power = 0;
        let heartrate = 0;
        let speed = 0;
        let altimeters = 0;
        let cadence = 0;
        let cnt = 0;
        for (let i = startIndex * STRIDE; i < endIndex * STRIDE; i += STRIDE) {
            power += series[i + 1];
            heartrate += series[i + 2];
            cadence += series[i + 3];
            speed += series[i + 4];
            altimeters += series[i + 5];
            ++cnt;
        }
        altimeters = series[(endIndex - 1) * STRIDE + 5] - series[startIndex * STRIDE + 5];
        power = Math.round(power / cnt);
        heartrate = Math.round(heartrate / cnt);
        speed /= cnt;
        speed *= 10;
        speed = Math.round(speed);
        speed /= 10;
        cadence = Math.round(cadence / cnt);

        const duration = endIndex - startIndex;



        workout.segments ??= [];
        workout.segments.push({
            id: globalThis.crypto.randomUUID(),
            start_offset: startIndex,
            end_offset: endIndex,
            duration: duration,
            avg_power: power,
            avg_heart_rate: heartrate,
            avg_cadence: cadence,
            avg_speed: speed,
            altimeters: altimeters,
            segmenttype: segmenttype,
            rowstate: 'CRE',
            segmentname: ''
        });

        return workout;

    }

    static createSgmentsFromIntervals(intervals, segmenttype = 'auto') {
        const res = [];
        const len = intervals.length;

        for (let i = 0; i < len; i++) {
            const it = intervals[i];
            res.push(
                {
                    id: globalThis.crypto.randomUUID(),
                    start_offset: it.start ?? it.start_offset,
                    end_offset: it.end ?? it.end_offset,
                    duration: it.duration,
                    avg_power: it.avgPower ?? 0,
                    avg_heart_rate: it.avgHeartRate ?? 0,
                    avg_cadence: it.avgCadence ?? 0,
                    avg_speed: it.avgSpeed ?? 0,
                    altimeters: it.altimeters ?? 0,
                    segmenttype: segmenttype,
                    rowstate: 'CRE',
                    position: i,
                    segmentname: it.segmentname ?? ''
                });
        }

        return res;
    }



    static async fetchSegments(workout) {
        workout.segments ??= [];
        const res = await fetch(`/files/workouts/${workout.id}/segments`);

        if (!res.ok) {
            throw new Error("Failed to load segments");
        }

        const json = await res.json();
        const backendSegments = json.data.map(s => ({
            rowstate: 'DB', ...s
        })); // <- wichtig


        const existingIds = new Set(workout.segments.map(s => s.id));

        const mapped = backendSegments
            .filter(s => !existingIds.has(s.id));

        workout.segments.push(...mapped);

    }

    static reduced_track(workout, seg, options = {}) {
        const {
            sampleRate = 5,
            precision = 5
        } = options;

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLng = Infinity;
        let maxLng = -Infinity;

        const subset = workout.track.slice(seg.start_offset, seg.end_offset);
        let reduced = [];
        for (let i = 0; i < subset.length; i += sampleRate) {
            const ss = subset[i];
            const lat = Number(ss.lat.toFixed(precision));
            const lng = Number(ss.lng.toFixed(precision));
            const idx = ss.idx;
            // bbox
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            reduced.push({ idx, lat, lng });
        }

        return { 
            bbox: { minLat, maxLat, minLng, maxLng },
            track: reduced
        }
    }


    static async storeSegments(workout) {
        const new_segments = workout.segments.filter(s => s.rowstate !== 'DB');
        if (new_segments.length === 0) {
            //lert("No segments to save");
            return;
        }
        if (workout?.validGps) {
            new_segments.filter(s => s.segmenttype == 'manual' && s?.segmentname !== '').forEach(s => {
                s.gpstrack = SegmentService.reduced_track(workout, s);
            });
        }

        try {
            const res = await fetch(`/files/workouts/${workout.id}/segments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    segments: new_segments
                })
            });

            if (!res.ok) {
                throw new Error("Save failed");
            }



            const result = await res.json();

            console.log("Saved segments:", result);

            workout.segments.forEach(seg => {
                seg.rowstate = 'DB';
            });

        } catch (err) {
            console.error(err);
            alert("Failed to save segments");
        }

    }


}