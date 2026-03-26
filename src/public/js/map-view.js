export function createMapView(containerId) {
  const SEMI_TO_DEG = 18000 / 2147483648;

  const map = L.map(containerId);
  const trackLayer = L.layerGroup().addTo(map);
  const hoverLayer = L.layerGroup().addTo(map);
  map.createPane('trackPane');
  map.createPane('segmentPane');

  map.getPane('trackPane').style.zIndex = 400;
  map.getPane('segmentPane').style.zIndex = 500;


  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18
  }).addTo(map);

  let hoverMarker = null;
  let currentTrackPoints = [];

  function highlightSegment(segment) {
    const coords = currentTrackPoints.slice(
      segment.start,
      segment.end
    );

    const bounds = L.latLngBounds(coords);

    // Zoom
    map.fitBounds(bounds, { padding: [20, 20] });

    // Highlight
    //segmentLayer.clearLayers();

    /*L.polyline(coords, {
      color: 'red',
      weight: 6,
      pane: 'segmentPane'
    }).addTo(segmentLayer);*/
  }


  function renderTrack(workout) {
    trackLayer.clearLayers();
    hoverLayer.clearLayers();
    hoverMarker = null;
    currentTrackPoints = [];

    /*let lat = track.baselat;
    let lng = track.baselong;

    currentTrackPoints.push({
      lat: lat * SEMI_TO_DEG,
      lng: lng * SEMI_TO_DEG,
      idx: 0
    });*/

    const track = workout.track;

    for (let i = 0; i < track.recCount; i++) {
      let lat = track.deltalat[i];
      let lng = track.deltalong[i];

      currentTrackPoints.push({
        lat: lat * SEMI_TO_DEG,
        lng: lng * SEMI_TO_DEG,
        idx: i + 1
      });
    }

    const latlngs = currentTrackPoints.map((p) => [p.lat, p.lng]);




    const polyline = L.polyline(latlngs, {
      color: "#ff4d4f",
      pane: 'trackPane',
      weight: 4,
      opacity: 0.9
    }).addTo(trackLayer);

    const markAreas = buildMarkAreas(workout);
    for (let i = 0; i < markAreas.length; i++) {
      const markArea = markAreas[i];
      const latlngs = markArea.map((p) => [p.lat, p.lng]);
      L.polyline(latlngs, {
        color: "Blue",
        pane: 'segmentPane',
        weight: 4,
        opacity: 0.9
      }).addTo(trackLayer);
    }

    map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
  }

  function buildMarkAreas(workout) {
    const { track, intervals, manualIntervals } = workout;
    const { count, starts, ends, durations, powers, heartRates } = intervals;
    const markAreas = [];
    //const areas = new Array(count);

    for (let i = 0; i < count; i++) {
      const currentTrackPoints = [];
      for (let n = starts[i]; n <= ends[i]; n++) {
        let lat = track.deltalat[n];
        let lng = track.deltalong[n];

        currentTrackPoints.push({
          lat: lat * SEMI_TO_DEG,
          lng: lng * SEMI_TO_DEG,
          idx: n
        });

      }
      markAreas.push(currentTrackPoints);
    }
    if (manualIntervals != null) {
      for (let i = 0; i < manualIntervals.length; ++i) {
        const mi = manualIntervals[i];
        const currentTrackPoints = [];
        for (let n = mi.start; n <= mi.end; n++) {
          let lat = track.deltalat[n];
          let lng = track.deltalong[n];

          currentTrackPoints.push({
            lat: lat * SEMI_TO_DEG,
            lng: lng * SEMI_TO_DEG,
            idx: n
          });

        }
        markAreas.push(currentTrackPoints);
      }
    }





    return markAreas;
  }

  function moveMarker(lat, lng) {
    if (!hoverMarker) {
      hoverMarker = L.circleMarker([lat, lng], {
        radius: 7,
        weight: 2,
        color: "#111",
        fillColor: "#ffd54f",
        fillOpacity: 1
      }).addTo(hoverLayer);
    } else {
      hoverMarker.setLatLng([lat, lng]);
    }
  }

  function moveMarkerToIndex(idx) {
    const p = currentTrackPoints[idx];
    if (!p) return;
    moveMarker(p.lat, p.lng);
  }

  function hideMarker() {
    if (hoverMarker) {
      hoverLayer.removeLayer(hoverMarker);
      hoverMarker = null;
    }
  }

  return {
    map,
    renderTrack,
    moveMarkerToIndex,
    hideMarker,
    highlightSegment,
    getTrackPoints: () => currentTrackPoints
  };
}