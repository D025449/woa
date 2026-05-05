import MapSegment from "../../shared/MapSegment.js"
import { createTranslator, getCurrentLocale } from "./i18n.js";

export default class MapView {

  constructor(containerId, controller, handlers = {}) {
    this.controller = controller;
    this.t = createTranslator("segmentsPage.map");
    this.locale = getCurrentLocale();
    this.SEMI_TO_DEG = 18000 / 2147483648;
    this.handlers = handlers;
    this.baseLayerMode = "standard";
    this.baseLayer = null;
    this.baseLayerSlot = document.getElementById("segments-map-style-slot");
    this.baseLayerMenu = document.getElementById("segments-map-tools-menu");
    this.baseLayerButtons = new Map();

    this.map = L.map(containerId);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.hoverLayer = L.layerGroup().addTo(this.map);

    this.map.createPane('trackPane');
    this.map.createPane('segmentPane');

    this.map.getPane('trackPane').style.zIndex = 400;
    this.map.getPane('segmentPane').style.zIndex = 500;

    this.lookupResultLayer = L.layerGroup().addTo(this.map);

    this.hoverMarker = null;
    this.currentTrackPoints = [];
    this.segmentLayers = new Map();
    this.selectedSegmentId = null;

    this.lookupPoints = [];
    this.lookupMarkers = L.layerGroup().addTo(this.map);

    //this.initMapWithFallback();

    this.map.on("click", (e) => this.handleMapClick(e));
    //this.map.on("dblclick", (e) => this.handleMapDoubleClick(e));

    this.isSelecting = false;
    this.toggleBtn = document.getElementById("draw-segment-map-toggle");
    this.lookupBtn = document.getElementById("draw-segment-map-lookup");
    this.actionsMenu = document.getElementById("segments-map-tools-menu");

    this.setBaseLayer(this.baseLayerMode);
    this.initBaseLayerControls();
    this.initBaseLayerMenuBehaviour();

    this.toggleBtn?.addEventListener("click", () => {
      if (this.isSelecting) {
        this.disableSelectionMode();
      } else {
        this.enableSelectionMode();
      }
      this.closeActionsMenu();
    });

    this.lookupBtn?.addEventListener("click", async () => {
      await this.handleLookUpClick();
      this.closeActionsMenu();
    });

    document.addEventListener("click", (event) => {
      if (!this.actionsMenu?.open && !this.baseLayerMenu?.open) {
        return;
      }

      if (event.target?.closest?.("#segments-map-tools-menu")) {
        return;
      }

      this.closeActionsMenu();
      this.closeBaseLayerMenu();
    });

    this.syncSelectionUi();

    this.map.whenReady(async () => {
      console.log("Map ready");

      const bounds = this.map.getBounds();
      const segments = await this.loadSegmentsForViewport(bounds);

      //this.renderSegments(segments);
    });


    this.timeout = 0;

    this.map.on("moveend", () => {
      clearTimeout(this.timeout);

      this.timeout = setTimeout(async () => {
        const bounds = this.map.getBounds();
        this.loadSegmentsForViewport(bounds)
      }, 200);
    });


    this.restoreMapState(containerId);
    this.bindMapState(containerId);


  }

  restoreMapState(key = "map") {
    const state = this.controller.uiState.get(key);
    if (!state){
      this.initMapWithFallback();
      return;
    }

    this.map.setView(
      [state.lat, state.lng],
      state.zoom,
      { animate: false }
    );
  }

  bindMapState(key = "map") {
    let timeout;

    const save = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const center = this.map.getCenter();
        const zoom = this.map.getZoom();

        this.controller.uiState.set(key, {
          lat: center.lat,
          lng: center.lng,
          zoom
        });
      }, 200);
    };

    this.map.on("move", save);
    this.map.on("zoomend", save);
  }


  enableSelectionMode() {
    this.isSelecting = true;
    this.resetLookupSelection();
    this.map.getContainer().style.cursor = "crosshair";
    this.syncSelectionUi();
  }

  disableSelectionMode() {
    this.isSelecting = false;
    this.resetLookupSelection();
    this.map.getContainer().style.cursor = "";
    this.syncSelectionUi();
  }

  resetLookupSelection() {
    this.lookupPoints = [];
    this.lookupMarkers.clearLayers();
    this.syncSelectionUi();
  }

  syncSelectionUi() {
    const hasTwoPoints = this.lookupPoints.length === 2;

    this.toggleBtn?.classList.toggle("btn-primary", this.isSelecting);
    this.toggleBtn?.classList.toggle("btn-outline-primary", !this.isSelecting);
    this.toggleBtn?.classList.toggle("active", this.isSelecting);

    if (this.lookupBtn) {
      this.lookupBtn.disabled = !this.isSelecting || !hasTwoPoints;
      this.lookupBtn.classList.toggle("btn-primary", this.isSelecting && hasTwoPoints);
      this.lookupBtn.classList.toggle("btn-outline-secondary", !this.isSelecting || !hasTwoPoints);
      this.lookupBtn.classList.toggle("active", this.isSelecting && hasTwoPoints);
    }
  }

  closeActionsMenu() {
    this.actionsMenu?.removeAttribute("open");
  }

  closeBaseLayerMenu() {
    this.baseLayerMenu?.removeAttribute("open");
  }

  handleMapClick(e) {
    if (this.isSelecting === false) {
      return;
    }

    const { lat, lng } = e.latlng;

    // max 2 Punkte speichern
    if (this.lookupPoints.length >= 2) {
      this.resetLookupSelection();
    }

    this.lookupPoints.push({ lat, lng });
    this.syncSelectionUi();


    L.marker([lat, lng])
      .addTo(this.lookupMarkers)
      .bindPopup(`Point ${this.lookupPoints.length}`)
      .openPopup();




  }

  async loadSegmentsForViewport(bounds) {
    const newSegs = await MapSegment.loadSegments(this.controller, bounds);
    this.renderAllSegments(newSegs);
    await this.controller.tryFocusRequestedSegment?.();
  }

  /*async load() {
    await MapSegment.query(this.controller);

  }*/

  async handleLookUpClick() {
    if (this.lookupPoints.length !== 2) {
      console.warn(this.t("warnTwoPoints"));
      return;
    }

    const [p1, p2] = this.lookupPoints;

    try {
      const res = await fetch("/segments/track-lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          start: p1,
          end: p2
        })
      });

      const data = await res.json();

      console.log(this.t("lookupResult"), data);

      if (data?.track) {
        await this.controller.mapSegments.push(data);
        this.renderAllSegments();
        this.handlers.onSegmentOpen?.({ type: 'end' }, data);
      }
      this.resetLookupSelection();

    } catch (err) {
      console.error(this.t("lookupFailed"), err);
    }
  }

  renderAllSegments(new_segs) {
    // alte Sachen entfernen
    if (new_segs) {
      new_segs.forEach(s => {
        if (!this.controller.favoriteOnly || this.controller.isFavoriteSegment(s.id)) {
          this.renderSegment(s);
        }
      });
    } else {
      this.lookupResultLayer.clearLayers();
      this.controller.getRenderableSegments().forEach(s => {
        this.renderSegment(s);
      });
      //this.map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
    }
  }

  refreshSegments() {
    this.segmentLayers.clear();
    this.lookupResultLayer.clearLayers();
    this.controller.getRenderableSegments().forEach(s => {
      this.renderSegment(s);
    });
  }

  renderSegment(segment) {
    const isSelected = this.selectedSegmentId === segment.id;


    // -------------------
    // Track zeichnen
    // -------------------
    const latlngs = segment.track.map(p => [p.lat, p.lng]);

    const polyline = L.polyline(latlngs, {
      color: isSelected ? "#1d4ed8" : "#475569",
      weight: isSelected ? 7 : 5,
      opacity: isSelected ? 0.95 : 0.72,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(this.lookupResultLayer);

    polyline.bindTooltip(this.buildSegmentTooltip(segment), {
      sticky: true,
      direction: "top",
      offset: [0, -6],
      opacity: 0.96,
      className: "segment-map-tooltip"
    });

    // -------------------
    // Start Marker
    // -------------------
    const startMarker = L.circleMarker([segment.start.lat, segment.start.lng], {
      radius: isSelected ? 8 : 6,
      weight: isSelected ? 3 : 2,
      color: "#ffffff",
      fillColor: isSelected ? "#16a34a" : "#22c55e",
      fillOpacity: 1
    }).addTo(this.lookupResultLayer);

    startMarker.bindTooltip(this.buildEndpointTooltip(this.t("start"), segment.start), {
      sticky: true,
      direction: "top",
      offset: [0, -8],
      opacity: 0.96,
      className: "segment-map-tooltip"
    });
    startMarker.bindPopup(`${this.t("start")}<br>${segment.id}: ${segment.start.name}<br>${this.t("altitude")} ${segment.start.altitude}`);
    //startMarker.bindPopup(`Start:<br>${start.name || ""}`);

    // -------------------
    // End Marker
    // -------------------
    const endMarker = L.circleMarker([segment.end.lat, segment.end.lng], {
      radius: isSelected ? 8 : 6,
      weight: isSelected ? 3 : 2,
      color: "#ffffff",
      fillColor: isSelected ? "#dc2626" : "#ef4444",
      fillOpacity: 1
    }).addTo(this.lookupResultLayer);

    endMarker.bindTooltip(this.buildEndpointTooltip(this.t("end"), segment.end), {
      sticky: true,
      direction: "top",
      offset: [0, -8],
      opacity: 0.96,
      className: "segment-map-tooltip"
    });
    endMarker.bindPopup(`${this.t("end")}<br>${segment.id}: ${segment.end.name}<br>${this.t("altitude")} ${segment.end.altitude}`);

    this.segmentLayers.set(segment.id, {
      polyline,
      startMarker,
      endMarker
    });

    polyline.on("click", async () => {
      this.selectSegment(segment);
      this.handlers.onSegmentOpen?.({ type: "line" }, segment);
    });

    startMarker.on("click", async () => {
      this.onSegmentStartClick(segment);
    });

    endMarker.on("click", async () => {
      this.onSegmentEndClick(segment);
    });


    //endMarker.bindPopup(`Ziel:<br>${end.name || ""}`);

    // -------------------
    // Map fitten
    // -------------------
    //this.map.fitBounds(polyline.getBounds(), { padding: [20, 20] });
  }

  selectSegment(segment) {
    this.selectedSegmentId = segment?.id ?? null;
    this.refreshSegments();
  }

  focusSegment(segment) {
    if (!segment?.track?.length) {
      return;
    }

    const latlngs = segment.track.map((point) => [point.lat, point.lng]);
    const bounds = L.latLngBounds(latlngs);
    this.map.fitBounds(bounds, { padding: [28, 28] });
  }

  formatSegmentDistance(distanceMeters) {
    if (typeof distanceMeters !== "number" || Number.isNaN(distanceMeters)) {
      return this.t("na");
    }

    return `${(distanceMeters / 1000).toFixed(2)} km`;
  }

  formatSegmentAltitudeRange(segment) {
    const startAltitude = segment?.start?.altitude;
    const endAltitude = segment?.end?.altitude;

    if (typeof startAltitude !== "number" || typeof endAltitude !== "number") {
      return this.t("na");
    }

    return this.t("altitudeRangeValue", { start: Math.round(startAltitude), end: Math.round(endAltitude) });
  }

  formatSegmentAverageGrade(segment) {
    const distance = segment?.distance;
    const ascent = segment?.ascent;

    if (
      typeof distance !== "number" ||
      Number.isNaN(distance) ||
      distance <= 0 ||
      typeof ascent !== "number" ||
      Number.isNaN(ascent)
    ) {
      return this.t("na");
    }

    return `${((ascent / distance) * 100).toFixed(1)}%`;
  }

  buildSegmentTooltip(segment) {
    const startName = segment?.start?.name || this.t("na");
    const endName = segment?.end?.name || this.t("na");
    const distance = this.formatSegmentDistance(segment?.distance);
    const altitudeRange = this.formatSegmentAltitudeRange(segment);
    const avgGrade = this.formatSegmentAverageGrade(segment);

    return `
      <div style="min-width: 220px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">${this.t("segment")}</div>
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">#${segment.id} · ${distance}</div>
        <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
          <span style="color:#64748b;">${this.t("start")}</span>
          <span style="font-weight:600; color:#0f172a; text-align:right;">${startName}</span>
        </div>
        <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
          <span style="color:#64748b;">${this.t("end")}</span>
          <span style="font-weight:600; color:#0f172a; text-align:right;">${endName}</span>
        </div>
        <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
          <span style="color:#64748b;">${this.t("altitudeRange")}</span>
          <span style="font-weight:600; color:#0f172a; text-align:right;">${altitudeRange}</span>
        </div>
        <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
          <span style="color:#64748b;">${this.t("avgGrade")}</span>
          <span style="font-weight:600; color:#0f172a; text-align:right;">${avgGrade}</span>
        </div>
      </div>
    `;
  }

  buildEndpointTooltip(label, point) {
    const name = point?.name || this.t("na");
    const altitude = typeof point?.altitude === "number"
      ? `${Math.round(point.altitude)} m`
      : this.t("na");

    return `
      <div style="min-width: 180px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">${label}</div>
        <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">${name}</div>
        <div style="font-size: 12px; color: #475569;">${this.t("altitude")}: <span style="font-weight:600; color:#0f172a;">${altitude}</span></div>
      </div>
    `;
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


  async onSegmentStartClick(segment) {
    this.selectSegment(segment);
    this.handlers.onSegmentOpen?.({ type: 'start' }, segment);



    // z. B.:
    this.lookupStart = segment.start;
  }

  async onSegmentEndClick(segment) {
    this.selectSegment(segment);
    this.handlers.onSegmentOpen?.({ type: 'end' }, segment);
    //this.lookupEnd = segment.end;
    // 🔥 direkt Request triggern
    //this.triggerSegmentLookup();
  }

  async initMapWithFallback() {

    // 1. Versuch: echte Geolocation
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          this.setMap(latitude, longitude);
        },
        async (err) => {
          console.warn(this.t("geoDenied"));

          // 2. Fallback via IP
          try {
            const res = await fetch("https://ipapi.co/json/");
            const data = await res.json();

            this.setMap(data.latitude, data.longitude, 10);
          } catch (e) {
            console.error(this.t("fallbackFailed"), e);

            // 3. Hard fallback (z. B. Frankfurt)
            this.setMap(50.1109, 8.6821, 10);
          }
        }
      );
    } else {
      console.warn(this.t("geoUnsupported"));

      try {
        const res = await fetch("https://ipapi.co/json/");
        const data = await res.json();

        this.setMap(data.latitude, data.longitude, 10);
      } catch (e) {
        this.setMap(50.1109, 8.6821, 10);
      }
    }
  }
  setMap(lat, lng, zoom = 13) {
    this.map.setView([lat, lng], zoom);
    L.marker([lat, lng]).addTo(this.map).bindPopup(this.t("yourLocation")).openPopup();
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

  moveMarkerToPoint(point) {
    if (!point) return;
    this.moveMarker(point.lat, point.lng);
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

  resize() {
    this.map.invalidateSize(false);
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
      button.className = "segments-map-actions-menu__item segments-map-actions-menu__item--secondary";
      button.dataset.mapStyle = layer.key;
      button.textContent = layer.label;
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
      this.closeBaseLayerMenu();
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

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (this.baseLayerMenu?.open) {
        this.closeBaseLayerMenu();
        event.preventDefault();
      }
    });
  }

  getBaseLayerDefinitions() {
    return [
      { key: "standard", label: this.controller.t("mapStyleStandard") },
      { key: "topo", label: this.controller.t("mapStyleTopo") },
      { key: "outdoor", label: this.controller.t("mapStyleOutdoor") }
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
    this.handlers.onBaseLayerChange?.(normalizedMode);
  }

  syncBaseLayerButtons() {
    this.baseLayerButtons.forEach((button, key) => {
      const isActive = key === this.baseLayerMode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }
}
