export function createMapView(containerId) {
  const SEMI_TO_DEG = 18000 / 2147483648;

  const map = L.map(containerId);
  const trackLayer = L.layerGroup().addTo(map);
  const hoverLayer = L.layerGroup().addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18
  }).addTo(map);

  let hoverMarker = null;
  let currentTrackPoints = [];

  function renderTrack(track) {
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
      weight: 4,
      opacity: 0.9
    }).addTo(trackLayer);

    map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
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
    getTrackPoints: () => currentTrackPoints
  };
}