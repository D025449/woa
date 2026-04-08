
import Utils from '../../shared/Utils.js'

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
    color: 'rgba( 17, 230, 42, 0.2)' // fallback
  };
}

export function buildMarkAreas(workout) {
  return workout.segments
    .filter(s => s.rowstate !== 'DEL')
    .map(s => {
      const area = [
        {
          xAxis: s.start_offset,
          segmentId: s.id,
          itemStyle: getSegmentStyle(s),
          label: {
            show: true,
            position: "insideTop",
            distance: 8,
            formatter: Utils.formatSegment(s)
          }
        },
        {
          xAxis: s.end_offset
        }
      ];

      return area;
    });
}

/*export function buildMarkAreas(workout) {
  const areas = [];


  workout.segments.filter(f=> f.rowstate !== 'DEL').forEach( mi => {
    areas.push(
      [
        {
          xAxis: mi.start_offset,
          segmentId: mi.id,
          itemStyle: getSegmentStyle(mi),
          label: {
            show: true,
            position: "insideTop",
            distance: 8,
            formatter: Utils.formatSegment(mi)
          }
        },
        {
          xAxis: mi.end_offset
        }
      ]);


  });


  return areas;
}*/

export function buildMarkAreasSegment(segment) {
  const areas = new Array(1);

  areas[0] = [
    {
      xAxis: segment.start_offset,
      label: {
        show: true,
        position: "insideTop",
        distance: 8,
        formatter: `${Utils.formatDuration(segment.end_offset + 1 - segment.start_offset)}\n${segment.avg_power}W\n${segment.avg_heart_rate}bpm`
      }
    },
    {
      xAxis: segment.end_offset
    }
  ];

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
        formatter: `${Utils.formatDuration(interval.endOffset + 1 - interval.startOffset)}\n${interval.power}W\n${interval.heartRate}bpm`
      }
    },
    {
      xAxis: interval.endOffset
    }
  ];

  return areas;
}