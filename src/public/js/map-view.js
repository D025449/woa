export default class MapView {

  constructor(containerId) {
    this.SEMI_TO_DEG = 18000 / 2147483648;

    this.map = L.map(containerId);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.hoverLayer = L.layerGroup().addTo(this.map);

    this.map.createPane('trackPane');
    this.map.createPane('segmentPane');

    this.map.getPane('trackPane').style.zIndex = 400;
    this.map.getPane('segmentPane').style.zIndex = 500;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18
    }).addTo(this.map);

    this.hoverMarker = null;
    this.currentTrackPoints = [];
  }

  // -----------------------------
  // SEGMENT HIGHLIGHT
  // -----------------------------
  highlightSegment(segment) {
    const coords = this.currentTrackPoints.slice(
      segment.start,
      segment.end
    );

    const bounds = L.latLngBounds(coords);

    this.map.fitBounds(bounds, { padding: [20, 20] });
  }

  // -----------------------------
  // TRACK RENDERING
  // -----------------------------
  renderTrack(workout) {
    this.trackLayer.clearLayers();
    this.hoverLayer.clearLayers();
    this.hoverMarker = null;

    if (workout?.validgps) {

      this.currentTrackPoints = workout.track;

      const latlngs = this.currentTrackPoints.map((p) => [p.lat, p.lng]);

      const polyline = L.polyline(latlngs, {
        color: "#ff4d4f",
        pane: 'trackPane',
        weight: 4,
        opacity: 0.9
      }).addTo(this.trackLayer);

      const markAreas = this.buildMarkAreas(workout);

      for (let i = 0; i < markAreas.length; i++) {
        const markArea = markAreas[i];

        const latlngs = markArea.currentTrackPoints.map((p) => [p.lat, p.lng]);

        L.polyline(latlngs, {
          color: markArea.segmenttype === 'auto' ? "Blue" : "Purple",
          pane: 'segmentPane',
          weight: 4,
          opacity: 0.9
        }).addTo(this.trackLayer);
      }

      this.map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
    }

  }

  // -----------------------------
  // BUILD SEGMENTS
  // -----------------------------
  buildMarkAreas(workout) {
    const { track, segments } = workout;
    const markAreas = [];

    if (segments != null) {
      segments
        .filter(f => f.rowstate !== 'DEL')
        .forEach(seg => {

          const currentTrackPoints = this.currentTrackPoints.slice(seg.start_offset, seg.end_offset);

          markAreas.push({
            currentTrackPoints,
            segmenttype: seg.segmenttype
          });
        });
    }

    return markAreas;
  }

  // -----------------------------
  // MARKER
  // -----------------------------
  moveMarker(lat, lng) {
    if (!this.hoverMarker) {
      this.hoverMarker = L.circleMarker([lat, lng], {
        radius: 7,
        weight: 2,
        color: "#111",
        fillColor: "#ffd54f",
        fillOpacity: 1
      }).addTo(this.hoverLayer);
    } else {
      this.hoverMarker.setLatLng([lat, lng]);
    }
  }

  moveMarkerToIndex(idx) {
    const p = this.currentTrackPoints[idx];
    if (!p) return;

    this.moveMarker(p.lat, p.lng);
  }

  hideMarker() {
    if (this.hoverMarker) {
      this.hoverLayer.removeLayer(this.hoverMarker);
      this.hoverMarker = null;
    }
  }

  // -----------------------------
  // GETTER
  // -----------------------------
  getTrackPoints() {
    return this.currentTrackPoints;
  }
}

