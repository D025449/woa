
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
          sid: s.sid,
          isGPSSegment: !!s.isGPSSegment,
          itemStyle: getSegmentStyle(s),
          label: {
            show: false,
            position: "insideTop",
            distance: 8,
            color: "#0f172a",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 14,
            formatter: Utils.formatSegmentLabel(s)
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
      segmentId: segment.id,
      label: {
        show: false,
        position: "insideTop",
        distance: 8,
        color: "#0f172a",
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 14,
        formatter: Utils.formatSegmentLabel(segment)
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
