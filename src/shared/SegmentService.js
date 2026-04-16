//import { ServerSideEncryption } from "@aws-sdk/client-s3";
import Utils from "./Utils.js";

export default class SegmentService {



    static async deleteSegment(workout, seg) {

        seg.rowstate = 'DEL';
        try {
            const res = await fetch(`/files/workouts/${workout.id}/segments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    segments: [seg]
                })
            });

            if (!res.ok) {
                throw new Error("Save failed");
            }
            const result = await res.json();


            //seg.id = result.segments[0].id;

            console.log("Deleted segments:", result);

        } catch (err) {
            console.error(err);
        }


        //this.handlers.onUpdateWorkout?.(this.currentWorkout);      
    }


    static async createAddNewSegment(workout, startEnd, segmenttype = 'manual') {

        const newSeg = workout.workoutObject.createNewSegment(startEnd, segmenttype = 'manual');
        if (newSeg) {
            await SegmentService.storeSegment(workout, newSeg);

            workout.segments ??= [];
            workout.segments.push(newSeg);

        }
        return workout;
    }

    static async createAddNewGpsSegment(workout, startEnd) {
        if (!workout?.validGps || !Array.isArray(workout.track) || workout.track.length === 0) {
            return null;
        }

        const newSeg = workout.workoutObject.createNewSegment(startEnd, 'manual');
        if (!newSeg) {
            return null;
        }

        const gpsTrack = SegmentService.reduced_track(workout, newSeg);
        if (!gpsTrack?.track?.length) {
            return null;
        }

        const res = await fetch(`/segments/track-lookup-v2`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                track: gpsTrack.track
            })
        });

        if (!res.ok) {
            throw new Error("GPS segment lookup failed");
        }

        return res.json();
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
            sampleRate = 1,
            precision = 5
        } = options;

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLng = Infinity;
        let maxLng = -Infinity;
        const slice = workout.workoutObject.getMetricsForRange(seg.start_offset, seg.end_offset);

        const subset = workout.track.slice(seg.start_offset / workout.sampleRateGPS, seg.end_offset / workout.sampleRateGPS);
        let reduced = [];
        for (let i = 0; i < subset.length; i += sampleRate) {
            const ss = subset[i];
            const lat = Number(ss.lat.toFixed(precision));
            const lng = Number(ss.lng.toFixed(precision));
            const ele = slice.altitude[i * workout.sampleRateGPS];
            const idx = ss.idx;
            // bbox
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            reduced.push({ idx, lat, lng, ele });
        }

        return {
            bbox: { minLat, maxLat, minLng, maxLng },
            track: reduced
        }
    }

    static async storeSegment(workout, seg) {

        if (workout?.validGps) {
            seg.gpstrack = SegmentService.reduced_track(workout, seg);
        };
        try {
            const res = await fetch(`/files/workouts/${workout.id}/segments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    segments: [seg]
                })
            });

            if (!res.ok) {
                throw new Error("Save failed");
            }
            const result = await res.json();

            seg.rowstate = 'DB';
            seg.id = result.segments[0].id;

            console.log("Saved segments:", result);

        } catch (err) {
            console.error(err);
            alert("Failed to save segments");
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
