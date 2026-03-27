//import { ServerSideEncryption } from "@aws-sdk/client-s3";


export class SegmentService {


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



        workout.segments ??= [];
        workout.segments.push({
            id: globalThis.crypto.randomUUID(),
            start_index: startIndex,
            end_index: endIndex,
            duration: endIndex - startIndex,
            power: power,
            heartrate: heartrate,
            cadence: cadence,
            speed: speed,
            altimeters: altimeters,
            segmenttype: segmenttype,
            rowstate: 'CRE'
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
                    start_index: it.start,
                    end_index: it.end,
                    duration: it.duration,
                    power: it.avgPower ?? 0,
                    heartrate: it.avgHeartRate ?? 0,
                    cadence: it.avgCadence ?? 0,
                    speed: it.avgSpeed ?? 0,
                    altimeters: it.altimeters ?? 0,
                    segmenttype: segmenttype,
                    rowstate: 'CRE',
                    position: i
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

    static async storeSegments(workout) {
        const new_segments = workout.segments.filter(s => s.rowstate === 'CRE');
        if (new_segments.length === 0) {
            //lert("No segments to save");
            return;
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

            // 🔥 Reset pending state
            //pendingSegments = [];

            // Optional: neu laden (sauberer Zustand)
            //await reloadSegments();

            //alert("Segments saved!");

        } catch (err) {
            console.error(err);
            alert("Failed to save segments");
        }

    }


}