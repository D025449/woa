export function formatDuration(seconds) {
  if (seconds == null) return "";

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSeconds(value) {
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getSegmentStyle(segment) {
  if (segment.segmenttype === 'manual') {
    return {
      color: 'rgba(255, 0, 0, 0.3)' // 🔴 rot
    };
  }

  if (segment.segmenttype === 'auto') {
    return {
      color: 'rgba(0, 123, 255, 0.3)' // 🔵 blau
    };
  }

  return {
    color: 'rgba(100, 100, 100, 0.2)' // fallback
  };
}

export function buildMarkAreas(workout) {
  //const { count, starts, ends, durations, powers, heartRates } = workout.intervals;
  const areas = [];

  /*for (let i = 0; i < count; i++) {
    areas[i] = [
      {
        xAxis: starts[i],

        label: {
          show: true,
          position: "insideTop",
          distance: 8,
          formatter: `${formatDuration(durations[i])}\n${powers[i]}W\n${heartRates[i]}bpm`
        }
      },
      {
        xAxis: ends[i]
      }
    ];
  }*/

  for (let i = 0; i < workout.segments.length; ++i) {
    const mi = workout.segments[i];
    areas.push(
      [
        {
          xAxis: mi.start_index,
          itemStyle: getSegmentStyle(mi),
          label: {
            show: true,
            position: "insideTop",
            distance: 8,
            formatter: `${formatDuration(mi.duration)}\n${mi.power}W\n${mi.heartrate}bpm\n${mi.speed}km/h`
          }
        },
        {
          xAxis: mi.end_index
        }
      ]);


  }


  return areas;
}

/*export async function storeSegments(wid, pendingSegments)
{
    if (pendingSegments.length === 0) {
      alert("No segments to save");
      return;
    }

    try {
      const res = await fetch(`/files/workouts/${wid}/segments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          segments: pendingSegments
        })
      });

      if (!res.ok) {
        throw new Error("Save failed");
      }

      const result = await res.json();

      console.log("Saved segments:", result);

      // 🔥 Reset pending state
      //pendingSegments = [];

      // Optional: neu laden (sauberer Zustand)
      //await reloadSegments();

      alert("Segments saved!");

    } catch (err) {
      console.error(err);
      alert("Failed to save segments");
    }
}*/

export function buildMarkAreasCP(interval) {
  const areas = new Array(1);

  areas[0] = [
    {
      xAxis: interval.startOffset,
      label: {
        show: true,
        position: "insideTop",
        distance: 8,
        formatter: `${formatDuration(interval.endOffset + 1 - interval.startOffset)}\n${interval.power}W\n${interval.heartRate}bpm`
      }
    },
    {
      xAxis: interval.endOffset
    }
  ];

  return areas;
}