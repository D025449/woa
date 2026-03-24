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

export function buildMarkAreas(intervals) {
  const { count, starts, ends, durations, powers, heartRates } = intervals;
  const areas = new Array(count);

  for (let i = 0; i < count; i++) {
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
  }

  return areas;
}

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