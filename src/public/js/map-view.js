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
    this.currentTrackSampleRate = 1;
  }

  // -----------------------------
  // SEGMENT HIGHLIGHT
  // -----------------------------
  highlightSegment(segment) {
    const startIdx = this.mapSourceIndexToTrackIndex(segment.start, "floor");
    const endIdx = this.mapSourceIndexToTrackIndex(segment.end, "ceil");
    const coords = this.currentTrackPoints.slice(startIdx, endIdx + 1);

    if (coords.length === 0) return;

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
    this.currentTrackPoints = [];
    this.currentTrackSampleRate = 1;

    if (workout?.validGps) {

      this.currentTrackPoints = workout.track ?? [];
      this.currentTrackSampleRate = Math.max(1, Number(workout.sampleRateGPS) || 1);

      if (this.currentTrackPoints.length === 0) {
        return;
      }

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

        if (latlngs.length === 0) continue;

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
          const startIdx = this.mapSourceIndexToTrackIndex(seg.start_offset, "floor");
          const endIdx = this.mapSourceIndexToTrackIndex(seg.end_offset, "ceil");
          const currentTrackPoints = this.currentTrackPoints.slice(startIdx, endIdx + 1);

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
    const trackIdx = this.mapSourceIndexToTrackIndex(idx, "nearest");
    const p = this.currentTrackPoints[trackIdx];
    if (!p) return;

    this.moveMarker(p.lat, p.lng);
  }

  mapSourceIndexToTrackIndex(idx, mode = "nearest") {
    if (!Number.isFinite(idx) || this.currentTrackPoints.length === 0) {
      return 0;
    }

    const sampleRate = this.currentTrackSampleRate > 0
      ? this.currentTrackSampleRate
      : 1;

    let mappedIdx;

    if (mode === "floor") {
      mappedIdx = Math.floor(idx / sampleRate);
    } else if (mode === "ceil") {
      mappedIdx = Math.ceil(idx / sampleRate);
    } else {
      mappedIdx = Math.round(idx / sampleRate);
    }

    return Math.max(0, Math.min(this.currentTrackPoints.length - 1, mappedIdx));
  }

  hideMarker() {
    if (this.hoverMarker) {
      this.hoverLayer.removeLayer(this.hoverMarker);
      this.hoverMarker = null;
    }
  }

  resize() {
    if (!this.map) {
      return;
    }

    this.map.invalidateSize(false);
  }

  // -----------------------------
  // GETTER
  // -----------------------------
  getTrackPoints() {
    return this.currentTrackPoints;
  }
}
