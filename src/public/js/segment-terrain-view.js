import WorkoutTerrainView from "./workout-terrain-view.js";

export default class SegmentTerrainView extends WorkoutTerrainView {
  constructor(container, owner) {
    super(container, owner);
    this.navigationControlPosition = "top-left";
    this.attributionControlPosition = "bottom-left";
  }

  bindInteractions() {
    this.map.addSource("segment-endpoints", { type: "geojson", data: this.collection([]) });
    this.map.addLayer({
      id: "segment-endpoints", type: "circle", source: "segment-endpoints",
      paint: {
        "circle-radius": ["case", ["get", "selected"], 8, 6],
        "circle-color": ["match", ["get", "endpoint"], "start", "#16a34a", "#dc2626"],
        "circle-stroke-width": 2, "circle-stroke-color": "#ffffff"
      }
    });
    this.map.on("click", (event) => this.handleClick(event));
    this.map.on("mousemove", (event) => {
      if (this.owner.isSelecting) return;
      this.showTooltip(this.findHit(event.point), event.lngLat);
    });
    this.map.getCanvas().addEventListener("mouseleave", () => this.showTooltip(null));
    this.map.on("moveend", () => this.owner.handleTerrainMove());
    this.map.on("movestart", () => {
      this.projectedHitGeometry = null;
      this.showTooltip(null);
    });
    this.map.on("render", () => { this.projectedHitGeometry = null; });
    this.map.on("resize", () => { this.projectedHitGeometry = null; });
    this.owner.handleTerrainMove();
  }

  findHit(point) {
    return this.findProjectedHit(point, this.owner.controller.getRenderableSegments());
  }

  findProjectedHit(point, segments) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    this.projectedHitGeometry ||= segments.map((segment) => ({
      segment,
      endpoints: ["start", "end"].map((endpoint) => ({ endpoint, point: this.projectHitPoint(segment[endpoint]) })),
      points: this.owner.getSegmentRenderTrack(segment).map((coordinate) => this.projectHitPoint(coordinate))
    }));
    let endpointHit = null;
    let endpointDistance = Infinity;
    for (const geometry of this.projectedHitGeometry) {
      const radius = geometry.segment.id === this.owner.selectedSegmentId ? 10 : 8;
      for (const endpoint of geometry.endpoints) {
        if (!endpoint.point) continue;
        const distance = Math.hypot(point.x - endpoint.point.x, point.y - endpoint.point.y);
        if (distance <= radius && distance < endpointDistance) {
          endpointDistance = distance;
          endpointHit = { segment: geometry.segment, endpoint: endpoint.endpoint };
        }
      }
    }
    if (endpointHit) return endpointHit;
    const closest = this.findClosestProjectedLine(point, this.projectedHitGeometry);
    return closest ? { segment: closest.segment, endpoint: undefined } : null;
  }

  handleClick(event) {
    if (this.owner.isSelecting) {
      this.owner.handleMapClick({ latlng: event.lngLat });
      return;
    }
    const hit = this.findHit(event.point);
    if (!hit) return;
    if (hit.endpoint === "start") this.owner.onSegmentStartClick(hit.segment);
    else if (hit.endpoint === "end") this.owner.onSegmentEndClick(hit.segment);
    else {
      this.owner.selectSegment(hit.segment);
      this.owner.handlers.onSegmentOpen?.({ type: "line" }, hit.segment);
    }
    this.showTooltip(hit, event.lngLat);
  }

  showTooltip(hit, position) {
    if (!this.map) return;
    this.map.getCanvas().style.cursor = this.owner.isSelecting ? "crosshair" : (hit ? "pointer" : "");
    this.popup?.remove();
    this.popup = null;
    if (!hit || this.owner.isSelecting) return;
    const html = hit.endpoint
      ? this.owner.buildEndpointTooltip(this.owner.t(hit.endpoint), hit.segment[hit.endpoint])
      : this.owner.buildSegmentTooltip(hit.segment);
    this.popup = new globalThis.maplibregl.Popup({ closeButton: false, closeOnClick: false })
      .setLngLat(position).setHTML(html).addTo(this.map);
  }

  render() {
    this.projectedHitGeometry = null;
    if (!this.ready || !this.map || this.owner.renderer !== "3d") return;
    const segments = this.owner.controller.getRenderableSegments();
    const features = [];
    const endpoints = [];
    for (const segment of segments) {
      const selected = this.owner.selectedSegmentId === segment.id;
      const properties = { kind: "segment", key: String(segment.id), color: selected ? "#1d4ed8" : "#475569" };
      const track = this.owner.getSegmentRenderTrack(segment);
      features.push(...this.lineFeatures([track], properties));
      if (selected) features.push(...this.lineFeatures([track], { kind: "focus" }));
      for (const endpoint of ["start", "end"]) {
        const point = segment[endpoint];
        if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) continue;
        endpoints.push({
          type: "Feature", properties: { ...properties, endpoint, selected },
          geometry: { type: "Point", coordinates: [point.lng, point.lat] }
        });
      }
    }
    this.map.getSource("workout")?.setData(this.collection(features));
    this.map.getSource("segment-endpoints")?.setData(this.collection(endpoints));
    this.showTooltip(null);
    this.moveMarker(this.owner.markerPosition);
    this.updateSegmentLabels();
  }

  getDraftSelection() {
    return { editing: this.owner.isSelecting, points: this.owner.lookupPoints };
  }

  getLabelCandidates() {
    const canvas = this.map.getCanvas();
    const candidates = [];
    const segments = [...this.owner.controller.getRenderableSegments()].sort((first, second) =>
      Number(second.id === this.owner.selectedSegmentId) - Number(first.id === this.owner.selectedSegmentId));
    for (const segment of segments) {
      const measurement = this.measureCoordinatePath(this.owner.getSegmentRenderTrack(segment));
      const text = `S-${segment.id}`;
      const width = Math.max(38, text.length * 7 + 16);
      const height = 22;
      if (!measurement || measurement.length < Math.max(64, width)) continue;
      const { x, y } = measurement.point;
      if (x < width / 2 || y < height / 2 || x > canvas.clientWidth - width / 2
        || y > canvas.clientHeight - height / 2) continue;
      if (candidates.some((other) => Math.abs(x - other.point.x) < (width + other.width) / 2 + 5
        && Math.abs(y - other.point.y) < height + 5)) continue;
      candidates.push({ ...measurement, entry: { key: String(segment.id) }, text, width, height });
    }
    return candidates;
  }

  getLabelHtml(candidate) {
    return `<span class="segments-terrain-label">${this.owner.escapeHtml(candidate.text)}</span>`;
  }
}