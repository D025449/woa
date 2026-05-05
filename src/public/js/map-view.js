export default class MapView {

  constructor(containerId) {
    this.SEMI_TO_DEG = 18000 / 2147483648;
    this.baseLayerMode = "standard";
    this.baseLayer = null;
    this.baseLayerSlot = document.getElementById("dashboard-map-style-slot");
    this.baseLayerMenu = document.getElementById("dashboard-map-style-menu");
    this.baseLayerButtons = new Map();

    this.map = L.map(containerId);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.hoverLayer = L.layerGroup().addTo(this.map);

    this.map.createPane('trackPane');
    this.map.createPane('segmentPane');

    this.map.getPane('trackPane').style.zIndex = 400;
    this.map.getPane('segmentPane').style.zIndex = 500;

    this.hoverMarker = null;
    this.currentTrackPoints = [];
    this.currentTrackSampleRate = 1;

    this.setBaseLayer(this.baseLayerMode);
    this.initBaseLayerControls();
    this.initBaseLayerMenuBehaviour();
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

  setInitialState(state = {}) {
    if (state?.baseLayerMode) {
      this.setBaseLayer(state.baseLayerMode);
    } else {
      this.syncBaseLayerButtons();
    }
  }

  initBaseLayerControls() {
    if (!this.baseLayerSlot) {
      return;
    }

    this.baseLayerSlot.innerHTML = "";
    this.baseLayerButtons.clear();

    this.getBaseLayerDefinitions().forEach((layer) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dashboard-series-toggle";
      button.dataset.mapStyle = layer.key;
      button.innerHTML = `
        <span class="dashboard-series-toggle__identity">
          <span class="dashboard-series-toggle__label">${layer.label}</span>
        </span>
        <span class="dashboard-series-toggle__state" aria-hidden="true">✓</span>
      `;
      this.baseLayerSlot.appendChild(button);
      this.baseLayerButtons.set(layer.key, button);
    });

    this.baseLayerSlot.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-map-style]");
      if (!button) {
        return;
      }

      const nextMode = button.dataset.mapStyle;
      if (!nextMode) {
        return;
      }

      this.setBaseLayer(nextMode);
      this.baseLayerMenu?.removeAttribute("open");
    });

    this.syncBaseLayerButtons();
  }

  initBaseLayerMenuBehaviour() {
    if (!this.baseLayerMenu) {
      return;
    }

    this.baseLayerMenu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (this.baseLayerMenu?.contains(target)) {
        return;
      }

      this.baseLayerMenu?.removeAttribute("open");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (this.baseLayerMenu?.open) {
        this.baseLayerMenu.removeAttribute("open");
        event.preventDefault();
      }
    });
  }

  getBaseLayerDefinitions() {
    const i18n = window.__I18N?.messages?.dashboardNewPage || {};
    return [
      { key: "standard", label: i18n.mapStyleStandard || "Standard" },
      { key: "topo", label: i18n.mapStyleTopo || "Topo" },
      { key: "outdoor", label: i18n.mapStyleOutdoor || "Outdoor" }
    ];
  }

  getTileLayerConfig(mode) {
    if (mode === "topo") {
      return {
        url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        options: {
          maxZoom: 17,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
        }
      };
    }

    if (mode === "outdoor") {
      return {
        url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
        options: {
          maxZoom: 20,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, style: &copy; <a href="https://www.cyclosm.org/">CyclOSM</a>'
        }
      };
    }

    return {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    };
  }

  setBaseLayer(mode = "standard") {
    const normalizedMode = ["standard", "topo", "outdoor"].includes(mode) ? mode : "standard";
    const { url, options } = this.getTileLayerConfig(normalizedMode);

    if (this.baseLayer) {
      this.map.removeLayer(this.baseLayer);
    }

    this.baseLayer = L.tileLayer(url, options).addTo(this.map);
    this.baseLayerMode = normalizedMode;
    this.syncBaseLayerButtons();
    this.onBaseLayerChange?.(normalizedMode);
  }

  syncBaseLayerButtons() {
    this.baseLayerButtons.forEach((button, key) => {
      const isActive = key === this.baseLayerMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }
}
