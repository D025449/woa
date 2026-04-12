import MapSegment from "../../shared/MapSegment.js"

export default class MapView {

  constructor(containerId, controller, handlers = {}) {
    this.controller = controller;
    this.SEMI_TO_DEG = 18000 / 2147483648;
    this.handlers = handlers;

    this.map = L.map(containerId);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.hoverLayer = L.layerGroup().addTo(this.map);

    this.map.createPane('trackPane');
    this.map.createPane('segmentPane');

    this.map.getPane('trackPane').style.zIndex = 400;
    this.map.getPane('segmentPane').style.zIndex = 500;

    this.lookupResultLayer = L.layerGroup().addTo(this.map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18
    }).addTo(this.map);

    this.hoverMarker = null;
    this.currentTrackPoints = [];

    this.lookupPoints = [];
    this.lookupMarkers = L.layerGroup().addTo(this.map);

    //this.initMapWithFallback();

    this.map.on("click", (e) => this.handleMapClick(e));
    //this.map.on("dblclick", (e) => this.handleMapDoubleClick(e));

    this.isSelecting = false;
    const btn = document.getElementById("draw-segment-map-toggle");


    btn?.addEventListener("click", () => {
      const isActive = btn.classList.toggle("active");

      if (isActive) {
        this.enableSelectionMode();
      } else {
        this.disableSelectionMode();
      }
    });

    this.lookupBtn = document.getElementById("draw-segment-map-lookup");
    this.lookupBtn?.classList.remove("active");

    this?.lookupBtn?.addEventListener("click", async () => {
      await this.handleLookUpClick();
    });

    this.saveBtn = document.getElementById("save-map-segments");
    this.saveBtn?.classList.remove("active");
    this.saveBtn.disabled = true;

    this?.saveBtn?.addEventListener("click", async () => {
      await this.handleSaveClick();
    });

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
    this.lookupPoints = [];
    this.lookupMarkers.clearLayers();

    this.map.getContainer().style.cursor = "crosshair";
  }

  disableSelectionMode() {
    this.isSelecting = false;
    this.lookupPoints = [];
    this.lookupMarkers.clearLayers();

    this.map.getContainer().style.cursor = "";
  }

  handleMapClick(e) {
    if (this.isSelecting === false) {
      return;
    }

    const { lat, lng } = e.latlng;

    // max 2 Punkte speichern
    if (this.lookupPoints.length >= 2) {
      this.lookupPoints = [];
      this.lookupMarkers.clearLayers();
      this.lookupBtn?.classList.remove("active");
    }

    this.lookupPoints.push({ lat, lng });

    if (this.lookupPoints.length == 2) {
      this.lookupBtn?.classList.add("active");
    }


    L.marker([lat, lng])
      .addTo(this.lookupMarkers)
      .bindPopup(`Punkt ${this.lookupPoints.length}`)
      .openPopup();




  }

  async loadSegmentsForViewport(bounds) {
    const newSegs = await MapSegment.loadSegments(this.controller, bounds);
    this.renderAllSegments(newSegs);
  }

  /*async load() {
    await MapSegment.query(this.controller);

  }*/



  async handleSaveClick() {

    const segsToBeSaved = this.controller.mapSegments.filter(f => f?.rowstate !== 'DB');
    if (segsToBeSaved.length > 0) {
      await MapSegment.storeSegments(this.controller, segsToBeSaved);
      this.renderAllSegments();
    }

    this.saveBtn?.classList.remove("active");
    this.saveBtn.disabled = true;
    console.log("Save Clicked");
  }


  async handleLookUpClick() {
    if (this.lookupPoints.length !== 2) {
      console.warn("Bitte zuerst 2 Punkte setzen");
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

      console.log("Lookup result:", data);

      if (data?.track) {
        data.rowstate = 'CRE';
        await this.controller.mapSegments.push(data);
        this.renderAllSegments();
        //this.renderSegment(data);
      }

      // 👉 danach Selection Mode optional beenden
      this.disableSelectionMode();
      this.lookupBtn?.classList.remove("active");
      this.saveBtn?.classList.add("active");
      this.saveBtn.disabled = false;

    } catch (err) {
      console.error("Lookup failed:", err);
    }
  }

  renderAllSegments(new_segs) {
    // alte Sachen entfernen
    if (new_segs) {
      new_segs.forEach(s => {
        this.renderSegment(s);
      });
    } else {
      this.lookupResultLayer.clearLayers();
      this.controller.mapSegments.forEach(s => {
        this.renderSegment(s);
      });
      //this.map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
    }
  }

  renderSegment(segment) {


    // -------------------
    // Track zeichnen
    // -------------------
    const latlngs = segment.track.map(p => [p.lat, p.lng]);

    const polyline = L.polyline(latlngs, {
      color: "#1890ff",
      weight: 4,
      opacity: 0.9
    }).addTo(this.lookupResultLayer);

    // -------------------
    // Start Marker (grün)
    // -------------------
    const startMarker = L.circleMarker([segment.start.lat, segment.start.lng], {
      radius: 8,
      color: "#0f0",
      fillColor: "#0f0",
      fillOpacity: 1
    }).addTo(this.lookupResultLayer);

    startMarker.bindPopup(`🟢 Start<br>${segment.id}: ${segment.start.name}<br>Altitude ${segment.start.altitude}`);//.openPopup();
    //startMarker.bindPopup(`Start:<br>${start.name || ""}`);

    // -------------------
    // End Marker (rot)
    // -------------------
    const endMarker = L.circleMarker([segment.end.lat, segment.end.lng], {
      radius: 8,
      color: "#f00",
      fillColor: "#f00",
      fillOpacity: 1
    }).addTo(this.lookupResultLayer);

    endMarker.bindPopup(`🔴 Ziel<br>${segment.id}: ${segment.end.name}<br>Altitude ${segment.end.altitude}`);//.openPopup();

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
    this.handlers.onSegmentOpen?.({ type: 'start' }, segment);



    // z. B.:
    this.lookupStart = segment.start;
  }

  async onSegmentEndClick(segment) {
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
          console.warn("Geolocation abgelehnt → fallback");

          // 2. Fallback via IP
          try {
            const res = await fetch("https://ipapi.co/json/");
            const data = await res.json();

            this.setMap(data.latitude, data.longitude, 10);
          } catch (e) {
            console.error("Fallback failed", e);

            // 3. Hard fallback (z. B. Frankfurt)
            this.setMap(50.1109, 8.6821, 10);
          }
        }
      );
    } else {
      console.warn("Kein Geolocation Support → fallback");

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
    L.marker([lat, lng]).addTo(this.map).bindPopup("Dein Standort").openPopup();
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

