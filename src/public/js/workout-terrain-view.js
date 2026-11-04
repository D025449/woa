import { WORKOUT_ROUTE_COLOR } from "./segment-visibility.js";

export default class WorkoutTerrainView {
  constructor(container, owner) {
    this.container = container;
    this.owner = owner;
    this.map = null;
    this.ready = false;
    this.marker = null;
    this.timeout = null;
    this.labels = new Map();
  }

  open(center, zoom) {
    this.container.hidden = false;
    if (this.map) {
      this.map.resize();
      this.map.jumpTo({ center: [center.lng, center.lat], zoom: Math.max(0, zoom - 1) });
      this.render();
      this.renderManualGpsSelection();
      return;
    }
    try {
      const library = globalThis.maplibregl;
      if (!library || (typeof library.supported === "function" && !library.supported())) {
        throw new Error("WebGL unavailable");
      }
      this.map = new library.Map({
        container: this.container,
        center: [center.lng, center.lat],
        zoom: Math.max(0, zoom - 1),
        pitch: 60,
        maxPitch: 85,
        maxZoom: 18,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              maxzoom: 19,
              attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            },
            terrain: {
              type: "raster-dem",
              url: "https://tiles.mapterhorn.com/tilejson.json",
              encoding: "terrarium",
              tileSize: 512
            },
            hillshade: {
              type: "raster-dem",
              url: "https://tiles.mapterhorn.com/tilejson.json",
              encoding: "terrarium",
              tileSize: 512
            }
          },
          layers: [
            { id: "osm", type: "raster", source: "osm" },
            { id: "hills", type: "hillshade", source: "hillshade", paint: { "hillshade-shadow-color": "#473b24" } }
          ],
          terrain: { source: "terrain", exaggeration: 1 }
        }
      });
      this.map.addControl(new library.NavigationControl({ visualizePitch: true }), "top-right");
      this.timeout = globalThis.setTimeout(() => this.fail(), 20000);
      this.map.on("error", () => this.fail());
      this.map.on("load", () => {
        globalThis.clearTimeout(this.timeout);
        this.ready = true;
        this.map.addSource("workout", { type: "geojson", data: this.collection([]) });
        this.map.addLayer({
          id: "route", type: "line", source: "workout",
          filter: ["==", ["get", "kind"], "route"],
          paint: { "line-color": WORKOUT_ROUTE_COLOR, "line-width": 4 }
        });
        this.map.addLayer({
          id: "segments", type: "line", source: "workout",
          filter: ["==", ["get", "kind"], "segment"],
          paint: { "line-color": ["get", "color"], "line-width": 5 }
        });
        this.map.addLayer({
          id: "segment-hit", type: "line", source: "workout",
          filter: ["==", ["get", "kind"], "segment"],
          paint: { "line-color": "#ffffff", "line-width": 18, "line-opacity": 0.001 }
        });
        this.map.addLayer({
          id: "focus", type: "line", source: "workout",
          filter: ["==", ["get", "kind"], "focus"],
          paint: { "line-color": "#2563eb", "line-width": 8 }
        });
        this.map.addSource("manual-gps", { type: "geojson", data: this.collection([]) });
        this.map.addLayer({
          id: "manual-gps-line", type: "line", source: "manual-gps",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#2563eb", "line-width": 3, "line-dasharray": [2, 2] }
        });
        this.map.addLayer({
          id: "manual-gps-points", type: "circle", source: "manual-gps",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 6, "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff", "circle-color": ["get", "color"]
          }
        });
        this.map.on("click", (event) => {
          if (this.owner.manualGpsMode) {
            this.owner.handleMapClick({ latlng: event.lngLat });
            return;
          }
          const feature = this.map.queryRenderedFeatures(event.point, { layers: ["segment-hit"] })[0];
          const entry = this.owner.segmentOverlayEntries.find((item) => item.key === feature?.properties?.key);
          if (entry) {
            const selected = this.owner.selectSegmentOverlay(entry, event.lngLat);
            this.owner.handlers.onSegmentSelectionChange?.(selected);
          } else {
            this.owner.handleMapClick({});
          }
        });
        this.map.on("mousemove", "segment-hit", (event) => {
          if (this.owner.manualGpsMode) return;
          const entry = this.owner.segmentOverlayEntries.find((item) => item.key === event.features?.[0]?.properties?.key);
          this.map.getCanvas().style.cursor = "pointer";
          if (entry) {
            this.owner.hoverSegmentOverlay(entry.segment);
            this.owner.handlers.onSegmentHoverChange?.(entry.segment);
          }
        });
        this.map.on("mouseleave", "segment-hit", () => {
          this.map.getCanvas().style.cursor = this.owner.manualGpsMode ? "crosshair" : "";
          this.owner.clearSegmentHover();
          this.owner.handlers.onSegmentHoverChange?.(null);
        });
        this.render();
        this.renderManualGpsSelection();
        this.map.on("moveend", () => this.updateSegmentLabels());
        this.map.on("resize", () => this.updateSegmentLabels());
      });
      this.map.getCanvas().addEventListener("webglcontextlost", () => this.fail());
    } catch {
      this.fail();
    }
  }

  fail() {
    globalThis.clearTimeout(this.timeout);
    if (this.failed) return;
    this.failed = true;
    this.owner.setRenderer("2d");
    this.owner.showTerrainError();
    const map = this.map;
    this.map = null;
    this.ready = false;
    this.marker = null;
    this.labels.forEach((marker) => marker.remove());
    this.labels.clear();
    globalThis.setTimeout(() => map?.remove(), 0);
  }

  collection(features) {
    return { type: "FeatureCollection", features };
  }

  lineFeatures(segments, properties) {
    return segments.filter((points) => points.length >= 2).map((points) => ({
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates: points.map((point) => [point.lng, point.lat]) }
    }));
  }

  render() {
    if (!this.ready || !this.map) return;
    if (this.owner.renderer && this.owner.renderer !== "3d") return;
    const features = this.lineFeatures(this.owner.currentTrackSegments, { kind: "route" });
    for (const entry of this.owner.segmentOverlayEntries) {
      features.push(...this.lineFeatures(entry.coordinateSegments, {
        kind: "segment", color: entry.color, key: entry.key
      }));
    }
    const active = this.owner.hoveredSegmentOverlay || this.owner.selectedSegmentOverlay;
    if (active) features.push(...this.lineFeatures(active.coordinateSegments, { kind: "focus" }));
    this.map.getSource("workout")?.setData(this.collection(features));
    this.popup?.remove();
    this.popup = null;
    const selected = this.owner.selectedSegmentOverlay;
    if (selected) {
      const canvas = this.map.getCanvas();
      const points = selected.coordinateSegments.flat().filter((point) => {
        const projected = this.map.project([point.lng, point.lat]);
        return projected.x >= 24 && projected.x <= canvas.clientWidth - 24
          && projected.y >= 24 && projected.y <= canvas.clientHeight - 24;
      });
      const point = points[Math.floor(points.length / 2)];
      if (point) {
        this.popup = new globalThis.maplibregl.Popup({ closeButton: false, closeOnClick: false })
          .setLngLat([point.lng, point.lat])
          .setHTML(this.owner.buildSegmentTooltipContent(selected.segment))
          .addTo(this.map);
      }
    }
    this.moveMarker(this.owner.markerPosition);
    this.updateSegmentLabels();
  }

  measureCoordinatePath(points = []) {
    if (points.length < 2) return null;
    const projected = points.map((point) => this.map.project([point.lng, point.lat]));
    if (!projected.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
    const distances = projected.slice(1).map((point, index) => Math.hypot(
      point.x - projected[index].x, point.y - projected[index].y
    ));
    const length = distances.reduce((total, distance) => total + distance, 0);
    if (length <= 0) return null;
    let traversed = 0;
    for (let index = 0; index < distances.length; index += 1) {
      const distance = distances[index];
      if (distance > 0 && traversed + distance >= length / 2) {
        const ratio = (length / 2 - traversed) / distance;
        const start = points[index];
        const end = points[index + 1];
        const latlng = [start.lng + (end.lng - start.lng) * ratio, start.lat + (end.lat - start.lat) * ratio];
        return { length, point: this.map.project(latlng), latlng };
      }
      traversed += distance;
    }
    return null;
  }

  updateSegmentLabels() {
    if (!this.ready || !this.map || this.owner.renderer !== "3d") return;
    const canvas = this.map.getCanvas();
    const candidates = this.owner.getVisibleSegmentLabels(
      { x: canvas.clientWidth, y: canvas.clientHeight },
      (points) => this.measureCoordinatePath(points)
    );
    const visibleKeys = new Set();
    for (const candidate of candidates) {
      const key = candidate.entry.key;
      visibleKeys.add(key);
      let marker = this.labels.get(key);
      if (!marker) {
        const element = document.createElement("span");
        element.className = "workout-map-segment-label-anchor";
        marker = new globalThis.maplibregl.Marker({ element, anchor: "center" });
        this.labels.set(key, marker);
        marker.setLngLat(candidate.latlng).addTo(this.map);
      }
      const element = marker.getElement();
      element.style.width = `${candidate.width}px`;
      element.style.height = `${candidate.height}px`;
      element.innerHTML = this.owner.getSegmentLabelHtml(candidate);
      marker.setLngLat(candidate.latlng);
    }
    for (const [key, marker] of this.labels) {
      if (!visibleKeys.has(key)) {
        marker.remove();
        this.labels.delete(key);
      }
    }
  }

  moveMarker(position) {
    if (!this.ready || !this.map) return;
    if (!position) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      const element = document.createElement("span");
      element.className = "workout-terrain-position";
      this.marker = new globalThis.maplibregl.Marker({ element }).setLngLat(position).addTo(this.map);
    } else {
      this.marker.setLngLat(position);
    }
  }

  renderManualGpsSelection() {
    if (!this.ready || !this.map || !this.owner.manualGpsPoints) return;
    const editing = !!this.owner.manualGpsMode;
    this.map.getCanvas().style.cursor = editing ? "crosshair" : "";
    if (editing && !this.editing) {
      this.restoreDoubleClickZoom = this.map.doubleClickZoom.isEnabled();
      this.map.doubleClickZoom.disable();
    } else if (!editing && this.editing && this.restoreDoubleClickZoom) {
      this.map.doubleClickZoom.enable();
    }
    this.editing = editing;
    const points = editing ? this.owner.manualGpsPoints : [];
    const features = this.lineFeatures([points], { kind: "manual" });
    points.forEach((point, index) => {
      features.push({
        type: "Feature",
        properties: { color: index === 0 ? "#16a34a" : (index === points.length - 1 ? "#dc2626" : "#2563eb") },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] }
      });
    });
    this.map.getSource("manual-gps")?.setData(this.collection(features));
  }

  fit(points) {
    if (!this.map || !points.length) return;
    if (this.owner.renderer && this.owner.renderer !== "3d") return;
    const bounds = new globalThis.maplibregl.LngLatBounds();
    points.forEach((point) => bounds.extend([point.lng, point.lat]));
    this.map.fitBounds(bounds, { padding: 30, duration: 0, maxZoom: 17 });
  }
}