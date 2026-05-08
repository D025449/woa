export default class FlyoverView {

  constructor({
    modalElementId,
    mapElementId,
    summaryElementId,
    playToggleButtonId = "dashboard-3d-play-toggle",
    presetSelectId = null,
    presetStorageKey = null,
    apiKey = "",
    t = (key) => key,
    hasRenderableTrack = null,
    buildSummary = null,
    resolvePlaybackDurationMs = null
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.t = t;
    this.modalElement = document.getElementById(modalElementId);
    this.mapElement = document.getElementById(mapElementId);
    this.summaryElement = document.getElementById(summaryElementId);
    this.playToggleButton = document.getElementById(playToggleButtonId);
    this.presetSelect = presetSelectId ? document.getElementById(presetSelectId) : null;
    this.presetStorageKey = presetStorageKey || null;
    this.modal = this.modalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.modalElement)
      : null;
    this.map = null;
    this.currentWorkout = null;
    this.pendingRender = false;
    this.modalResizeTimer = null;
    this.resizeObserver = null;
    this.lastRenderedTrackFeature = null;
    this.didFinishInitialIdle = false;
    this.playbackTrackPoints = [];
    this.playbackFrame = null;
    this.playbackStartTime = 0;
    this.playbackDurationMs = 0;
    this.isPlaying = false;
    this.lastCameraBearing = 18;
    this.playbackProgress = 0;
    this.lastWorkoutIdentity = null;
    this.isRenderReady = false;
    this.wantsPlayback = false;
    this.playbackEnsureTimer = null;
    this.terrainEnabled = true;
    this.hasTerrainFailure = false;
    this.hasRenderableTrack = typeof hasRenderableTrack === "function"
      ? hasRenderableTrack
      : (item) => !!item?.validGps && Array.isArray(item?.track) && item.track.length > 1;
    this.buildSummary = typeof buildSummary === "function"
      ? buildSummary
      : (item) => this.buildDefaultSummary(item);
    this.resolvePlaybackDurationMs = typeof resolvePlaybackDurationMs === "function"
      ? resolvePlaybackDurationMs
      : (item, points) => this.buildDefaultPlaybackDurationMs(item, points);
    this.cameraPresets = this.createCameraPresets();
    this.cameraPresetKey = this.readStoredPreset();

    this.playToggleButton?.addEventListener("click", () => {
      this.togglePlayback();
    });

    if (this.presetSelect) {
      this.presetSelect.value = this.cameraPresetKey;
      this.presetSelect.addEventListener("change", () => {
        this.setCameraPreset(this.presetSelect.value);
      });
    }

    this.modalElement?.addEventListener("shown.bs.modal", () => {
      this.isRenderReady = false;
      this.updatePlaybackUi();
      this.ensureMap();
      this.runModalResizeSequence();
    });

    this.modalElement?.addEventListener("hide.bs.modal", () => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && this.modalElement?.contains(activeElement)) {
        activeElement.blur();
      }
    });

    this.modalElement?.addEventListener("hidden.bs.modal", () => {
      if (this.modalResizeTimer) {
        window.clearTimeout(this.modalResizeTimer);
        this.modalResizeTimer = null;
      }
      this.resetPlaybackState({ clearTrack: true });
      this.destroyMap();
    });

    if (typeof globalThis.ResizeObserver === "function" && this.mapElement) {
      this.resizeObserver = new globalThis.ResizeObserver(() => {
        if (!this.modalElement?.classList.contains("show")) {
          return;
        }

        this.map?.resize?.();
        this.applyViewportToTrack();
      });
      this.resizeObserver.observe(this.mapElement);
    }
  }

  createCameraPresets() {
    return {
      standard: {
        followDistanceMeters: 6.2,
        lookAheadMeters: 0,
        baseAltitudeMeters: 4.6,
        slopeAltitudeMeters: 5.4,
        verticalFieldOfViewRadians: 0.82,
        fallbackZoom: 16.1,
        fallbackPitch: 80
      },
      action: {
        followDistanceMeters: 0.08,
        lookAheadMeters: 0,
        baseAltitudeMeters: 0.04,
        slopeAltitudeMeters: 0.12,
        verticalFieldOfViewRadians: 1.52,
        fallbackZoom: 14.1,
        fallbackPitch: 86
      },
      cinematic: {
        followDistanceMeters: 9.5,
        lookAheadMeters: 32,
        baseAltitudeMeters: 5.8,
        slopeAltitudeMeters: 6.5,
        verticalFieldOfViewRadians: 0.68,
        fallbackZoom: 16.8,
        fallbackPitch: 76
      },
      drone: {
        followDistanceMeters: 14,
        lookAheadMeters: 28,
        baseAltitudeMeters: 8.5,
        slopeAltitudeMeters: 8,
        verticalFieldOfViewRadians: 0.74,
        fallbackZoom: 17.3,
        fallbackPitch: 72
      }
    };
  }

  getCameraPreset() {
    return this.cameraPresets[this.cameraPresetKey] || this.cameraPresets.standard;
  }

  setCameraPreset(nextKey) {
    if (!this.cameraPresets[nextKey]) {
      return;
    }

    this.cameraPresetKey = nextKey;
    if (this.presetSelect && this.presetSelect.value !== nextKey) {
      this.presetSelect.value = nextKey;
    }

    if (this.presetStorageKey) {
      try {
        globalThis.localStorage?.setItem(this.presetStorageKey, nextKey);
      } catch {
        // ignore storage issues
      }
    }
  }

  readStoredPreset() {
    if (!this.presetStorageKey) {
      return "standard";
    }

    try {
      const value = globalThis.localStorage?.getItem(this.presetStorageKey);
      return this.cameraPresets?.[value] ? value : "standard";
    } catch {
      return "standard";
    }
  }

  isConfigured() {
    return !!this.apiKey;
  }

  hasTerrainSupport() {
    return !!globalThis.maplibregl && this.isConfigured();
  }

  setWorkout(workout) {
    const nextIdentity = workout?.id ?? workout?.wid ?? workout?.start_time ?? null;
    if (nextIdentity !== this.lastWorkoutIdentity) {
      this.lastWorkoutIdentity = nextIdentity;
      this.resetPlaybackState({ clearTrack: true });
    }

    this.currentWorkout = workout || null;
    if (this.modalElement?.classList.contains("show")) {
      this.requestRenderCurrentWorkout();
    } else {
      this.updateSummary();
    }
  }

  open() {
    this.updateSummary();
    this.modal?.show();
  }

  ensureMap() {
    if (this.map || !this.mapElement || !globalThis.maplibregl || !this.isConfigured()) {
      return;
    }

    this.didFinishInitialIdle = false;

    this.map = new globalThis.maplibregl.Map({
      container: this.mapElement,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${encodeURIComponent(this.apiKey)}`,
      center: [8.65, 49.55],
      zoom: 10,
      pitch: 60,
      bearing: 18,
      attributionControl: true
    });

    this.map.addControl(new globalThis.maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.on("error", (event) => {
      this.handleMapError(event);
    });

    this.map.on("load", () => {
      if (!this.map) {
        return;
      }

      if (this.terrainEnabled && !this.map.getSource("maptiler-terrain")) {
        this.map.addSource("maptiler-terrain", {
          type: "raster-dem",
          tiles: [
            `https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(this.apiKey)}`
          ],
          tileSize: 256,
          maxzoom: 14,
          encoding: "mapbox"
        });
      }

      if (this.terrainEnabled) {
        this.map.setTerrain({
          source: "maptiler-terrain",
          exaggeration: 1.18
        });
      }

      this.map.addSource("workout-3d-track", {
        type: "geojson",
        data: this.emptyCollection()
      });

      this.map.addLayer({
        id: "workout-3d-track-line",
        type: "line",
        source: "workout-3d-track",
        layout: {
          "line-join": "round",
          "line-cap": "round"
        },
        paint: {
          "line-color": "#7c3aed",
          "line-width": 5.5,
          "line-opacity": 0.98
        }
      });

      this.map.addSource("workout-3d-points", {
        type: "geojson",
        data: this.emptyCollection()
      });

      this.map.addLayer({
        id: "workout-3d-points-circles",
        type: "circle",
        source: "workout-3d-points",
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "pointType"], "start"],
            7,
            6
          ],
          "circle-color": [
            "case",
            ["==", ["get", "pointType"], "start"],
            "#0f766e",
            "#2563eb"
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });

      this.map.addSource("workout-3d-playhead", {
        type: "geojson",
        data: this.emptyCollection()
      });

      this.map.addLayer({
        id: "workout-3d-playhead-circle",
        type: "circle",
        source: "workout-3d-playhead",
        paint: {
          "circle-radius": 7,
          "circle-color": "#facc15",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#111827"
        }
      });

      this.pendingRender = false;
      this.renderCurrentWorkout();
    });

    this.map.once("idle", () => {
      this.didFinishInitialIdle = true;
      if (this.modalElement?.classList.contains("show")) {
        this.map?.resize?.();
        this.requestRenderCurrentWorkout();
      }
    });
  }

  destroyMap() {
    this.clearPlaybackEnsureTimer();
    if (!this.map) {
      return;
    }

    try {
      this.map.remove();
    } catch {
      // ignore teardown errors on modal close
    }

    this.map = null;
    this.lastRenderedTrackFeature = null;
    this.isRenderReady = false;
  }

  handleMapError(event) {
    const message = String(event?.error?.message || event?.message || "");
    const sourceId = String(event?.sourceId || event?.source?.id || "");
    const isTerrainError = sourceId.includes("maptiler-terrain")
      || message.includes("terrain-rgb")
      || message.includes("Failed to fetch");

    if (!isTerrainError || !this.terrainEnabled || this.hasTerrainFailure) {
      return;
    }

    this.hasTerrainFailure = true;
    this.disableTerrain();
  }

  disableTerrain() {
    this.terrainEnabled = false;

    try {
      this.map?.setTerrain?.(null);
    } catch {
      // ignore terrain teardown issues and keep the 3D map running flat
    }
  }

  runModalResizeSequence() {
    this.map?.resize?.();
    this.requestRenderCurrentWorkout();

    if (this.modalResizeTimer) {
      window.clearTimeout(this.modalResizeTimer);
    }

    this.modalResizeTimer = window.setTimeout(() => {
      this.modalResizeTimer = null;
      this.map?.resize?.();
      this.requestRenderCurrentWorkout();
    }, 80);

    if (!this.didFinishInitialIdle) {
      window.setTimeout(() => {
        if (!this.modalElement?.classList.contains("show")) {
          return;
        }

        this.map?.resize?.();
        this.requestRenderCurrentWorkout();
      }, 220);
    }
  }

  requestRenderCurrentWorkout() {
    if (!this.map?.isStyleLoaded?.()) {
      this.pendingRender = true;
      this.updateSummary();
      return;
    }

    this.pendingRender = false;
    this.renderCurrentWorkout();
  }

  renderCurrentWorkout() {
    if (!this.map?.isStyleLoaded?.()) {
      this.pendingRender = true;
      this.updateSummary();
      return;
    }

    const trackFeature = this.buildTrackFeature(this.currentWorkout);
    this.lastRenderedTrackFeature = trackFeature;
    const pointsFeatureCollection = this.buildPointsFeatureCollection(this.currentWorkout);
    this.playbackTrackPoints = this.buildPlaybackTrackPoints(this.currentWorkout);
    const trackSource = this.map.getSource("workout-3d-track");
    const pointsSource = this.map.getSource("workout-3d-points");

    trackSource?.setData(trackFeature ? trackFeature : this.emptyCollection());
    pointsSource?.setData(pointsFeatureCollection);
    this.updatePlayheadPoint(this.playbackTrackPoints[0] || null);

    this.applyViewportToTrack();

    this.isRenderReady = true;
    this.updatePlaybackUi();
    this.updateSummary();

  }

  buildPlaybackTrackPoints(workout) {
    const track = Array.isArray(workout?.track) ? workout.track : [];
    const sampled = [];
    const step = track.length > 2400 ? 6 : track.length > 1200 ? 4 : track.length > 500 ? 2 : 1;

    for (let index = 0; index < track.length; index += step) {
      const point = track[index];
      const lng = Number(point?.lng);
      const lat = Number(point?.lat);
      const alt = Number(point?.alt ?? point?.altitude ?? point?.ele);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        continue;
      }

      sampled.push({
        lng,
        lat,
        alt: Number.isFinite(alt) ? alt : null
      });
    }

    const last = track[track.length - 1];
    if (last) {
      const lng = Number(last?.lng);
      const lat = Number(last?.lat);
      const alt = Number(last?.alt ?? last?.altitude ?? last?.ele);
      const tail = sampled[sampled.length - 1];
      if (Number.isFinite(lng) && Number.isFinite(lat) && (!tail || tail.lng !== lng || tail.lat !== lat)) {
        sampled.push({
          lng,
          lat,
          alt: Number.isFinite(alt) ? alt : null
        });
      }
    }

    return sampled;
  }

  applyViewportToTrack() {
    if (!this.map || !this.lastRenderedTrackFeature?.geometry?.coordinates?.length) {
      return;
    }

    const container = this.map.getContainer?.();
    const width = container?.clientWidth || 0;
    const height = container?.clientHeight || 0;
    if (width < 40 || height < 40) {
      return;
    }

    const bounds = this.lastRenderedTrackFeature.geometry.coordinates.reduce((acc, coord) => {
      acc.extend(coord);
      return acc;
    }, new globalThis.maplibregl.LngLatBounds(
      this.lastRenderedTrackFeature.geometry.coordinates[0],
      this.lastRenderedTrackFeature.geometry.coordinates[0]
    ));

    this.map.fitBounds(bounds, {
      padding: { top: 44, right: 44, bottom: 44, left: 44 },
      pitch: 60,
      bearing: 18,
      duration: 0
    });
  }

  togglePlayback() {
    if (this.isPlaying) {
      this.wantsPlayback = false;
      this.clearPlaybackEnsureTimer();
      this.pausePlayback();
      this.updatePlaybackUi();
      return;
    }

    this.wantsPlayback = true;
    this.ensurePlaybackRunning();
  }

  startPlayback() {
    if (!this.map) {
      return;
    }

    if (this.playbackTrackPoints.length < 2) {
      this.playbackTrackPoints = this.buildPlaybackTrackPoints(this.currentWorkout);
      this.updatePlayheadPoint(this.playbackTrackPoints[0] || null);
    }

    if (this.playbackTrackPoints.length < 2) {
      return;
    }

    if (this.playbackProgress >= 1 || this.playbackProgress < 0) {
      this.playbackProgress = 0;
    }

    if (this.playbackFrame) {
      window.cancelAnimationFrame(this.playbackFrame);
      this.playbackFrame = null;
    }

    this.isPlaying = true;
    this.wantsPlayback = false;
    this.clearPlaybackEnsureTimer();
    this.playbackDurationMs = this.resolvePlaybackDurationMs(this.currentWorkout, this.playbackTrackPoints);
    this.playbackStartTime = performance.now() - (this.playbackProgress * this.playbackDurationMs);
    this.updatePlaybackUi();

    const tick = (now) => {
      if (!this.isPlaying) {
        return;
      }

      if (!Array.isArray(this.playbackTrackPoints) || this.playbackTrackPoints.length < 2) {
        this.stopPlayback({ resetPlayhead: true });
        return;
      }

      const elapsed = now - this.playbackStartTime;
      const progress = Math.min(1, elapsed / this.playbackDurationMs);
      this.playbackProgress = progress;
      this.applyPlaybackProgress(progress);

      if (progress >= 1) {
        this.stopPlayback({ resetPlayhead: false });
        this.updatePlaybackUi();
        return;
      }

      this.playbackFrame = window.requestAnimationFrame(tick);
    };

    this.playbackFrame = window.requestAnimationFrame(tick);
  }

  pausePlayback() {
    this.isPlaying = false;
    if (this.playbackFrame) {
      window.cancelAnimationFrame(this.playbackFrame);
      this.playbackFrame = null;
    }
  }

  ensurePlaybackRunning() {
    if (this.isPlaying) {
      this.wantsPlayback = false;
      this.clearPlaybackEnsureTimer();
      return;
    }

    if (!this.wantsPlayback) {
      this.clearPlaybackEnsureTimer();
      return;
    }

    if (!this.map || !this.isRenderReady) {
      this.queuePlaybackEnsure();
      return;
    }

    if (this.playbackTrackPoints.length < 2) {
      this.playbackTrackPoints = this.buildPlaybackTrackPoints(this.currentWorkout);
      this.updatePlayheadPoint(this.playbackTrackPoints[0] || null);
    }

    if (this.playbackTrackPoints.length < 2) {
      this.queuePlaybackEnsure();
      return;
    }

    this.startPlayback();

    if (!this.isPlaying) {
      this.queuePlaybackEnsure();
    }
  }

  queuePlaybackEnsure() {
    if (this.playbackEnsureTimer) {
      return;
    }

    this.playbackEnsureTimer = window.setTimeout(() => {
      this.playbackEnsureTimer = null;
      this.ensurePlaybackRunning();
    }, 120);
  }

  clearPlaybackEnsureTimer() {
    if (!this.playbackEnsureTimer) {
      return;
    }

    window.clearTimeout(this.playbackEnsureTimer);
    this.playbackEnsureTimer = null;
  }

  stopPlayback({ resetPlayhead = true } = {}) {
    this.wantsPlayback = false;
    this.clearPlaybackEnsureTimer();
    this.pausePlayback();

    if (resetPlayhead) {
      this.playbackProgress = 0;
      this.updatePlayheadPoint(this.playbackTrackPoints[0] || null);
    } else if (this.playbackProgress >= 1) {
      this.playbackProgress = 0;
    }

    this.updatePlaybackUi();
  }

  resetPlaybackState({ clearTrack = false } = {}) {
    this.wantsPlayback = false;
    this.clearPlaybackEnsureTimer();
    this.pausePlayback();
    this.playbackProgress = 0;
    this.playbackStartTime = 0;
    this.playbackDurationMs = 0;
    this.lastCameraBearing = 18;
    this.isRenderReady = false;
    if (clearTrack) {
      this.playbackTrackPoints = [];
      this.lastRenderedTrackFeature = null;
      this.updatePlayheadPoint(null);
    } else {
      this.updatePlayheadPoint(this.playbackTrackPoints[0] || null);
    }
    this.updatePlaybackUi();
  }

  applyPlaybackProgress(progress) {
    if (!this.map || this.playbackTrackPoints.length < 2) {
      return;
    }

    const scaled = progress * (this.playbackTrackPoints.length - 1);
    const index = Math.floor(scaled);
    const nextIndex = Math.min(index + 1, this.playbackTrackPoints.length - 1);
    const localT = scaled - index;
    const current = this.playbackTrackPoints[index];
    const next = this.playbackTrackPoints[nextIndex];
    if (!current || !next) {
      this.stopPlayback({ resetPlayhead: true });
      return;
    }

    const lng = current.lng + (next.lng - current.lng) * localT;
    const lat = current.lat + (next.lat - current.lat) * localT;
    const bearing = this.computeBearing(current, next);
    const smoothedBearing = this.smoothBearing(this.lastCameraBearing, bearing, 0.14);
    this.lastCameraBearing = smoothedBearing;
    this.updatePlayheadPoint({ lng, lat });
    const preset = this.getCameraPreset();
    const riderPoint = { lng, lat, alt: current.alt ?? null };
    const cameraPoint = this.projectPoint(riderPoint, smoothedBearing + 180, preset.followDistanceMeters);
    const slopeFactor = this.computeSlopeFactor(current, next);
    const lookAtPoint = preset.lookAheadMeters > 0
      ? this.projectPoint(riderPoint, smoothedBearing, preset.lookAheadMeters)
      : riderPoint;
    this.applyFollowCamera(cameraPoint, riderPoint, lookAtPoint, smoothedBearing, slopeFactor, preset);
  }

  computeBearing(from, to) {
    if (!from || !to) {
      return 18;
    }

    const lng1 = from.lng * Math.PI / 180;
    const lat1 = from.lat * Math.PI / 180;
    const lng2 = to.lng * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  smoothBearing(previous, next, factor = 0.15) {
    const delta = ((((next - previous) % 360) + 540) % 360) - 180;
    return (previous + delta * factor + 360) % 360;
  }

  projectPoint(point, bearingDegrees, distanceMeters) {
    const earthRadius = 6378137;
    const angularDistance = distanceMeters / earthRadius;
    const bearing = bearingDegrees * Math.PI / 180;
    const lat1 = point.lat * Math.PI / 180;
    const lng1 = point.lng * Math.PI / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
    );

    const lng2 = lng1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
      lat: lat2 * 180 / Math.PI,
      lng: lng2 * 180 / Math.PI
    };
  }

  applyFollowCamera(cameraPoint, riderPoint, lookAtPoint, bearing, slopeFactor = 0, preset = this.getCameraPreset()) {
    if (!this.map) {
      return;
    }

    if (typeof this.map.setVerticalFieldOfView === "function" && Number.isFinite(preset.verticalFieldOfViewRadians)) {
      try {
        this.map.setVerticalFieldOfView(preset.verticalFieldOfViewRadians);
      } catch {
        // ignore FOV errors and continue with the current camera setup
      }
    }

    const terrainAtCamera = this.readTerrainElevation(cameraPoint);
    const terrainAtRider = this.readTerrainElevation(riderPoint);
    const terrainAtLookAhead = this.readTerrainElevation(lookAtPoint);

    if (typeof this.map.getFreeCameraOptions === "function" && typeof globalThis.maplibregl?.MercatorCoordinate?.fromLngLat === "function") {
      try {
        const freeCamera = this.map.getFreeCameraOptions();
        const cameraAltitude = (terrainAtCamera ?? terrainAtRider ?? 0) + preset.baseAltitudeMeters + slopeFactor * preset.slopeAltitudeMeters;
        freeCamera.position = globalThis.maplibregl.MercatorCoordinate.fromLngLat(
          [cameraPoint.lng, cameraPoint.lat],
          cameraAltitude
        );

        if (typeof freeCamera.lookAtPoint === "function") {
          freeCamera.lookAtPoint(
            [lookAtPoint.lng, lookAtPoint.lat],
            (terrainAtLookAhead ?? terrainAtRider ?? 0) + 0.05
          );
        }

        this.map.setFreeCameraOptions(freeCamera);
        return;
      } catch {
        // Fallback below keeps the experience usable if free camera fails.
      }
    }

    this.map.jumpTo({
      center: [cameraPoint.lng, cameraPoint.lat],
      zoom: preset.fallbackZoom,
      pitch: preset.fallbackPitch,
      bearing
    });
  }

  computeSlopeFactor(from, to) {
    const fromAlt = Number(from?.alt);
    const toAlt = Number(to?.alt);
    if (!Number.isFinite(fromAlt) || !Number.isFinite(toAlt)) {
      return 0;
    }

    const climb = Math.max(0, toAlt - fromAlt);
    return Math.max(0, Math.min(1, climb / 6));
  }

  readTerrainElevation(point) {
    if (!this.map || !point || typeof this.map.queryTerrainElevation !== "function") {
      return null;
    }

    try {
      const value = this.map.queryTerrainElevation([point.lng, point.lat]);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  updatePlayheadPoint(point) {
    const source = this.map?.getSource?.("workout-3d-playhead");
    if (!source) {
      return;
    }

    if (!point) {
      source.setData(this.emptyCollection());
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [point.lng, point.lat]
        }
      }]
    });
  }

  updatePlaybackUi() {
    if (!this.playToggleButton) {
      return;
    }

    const canPlay = this.isRenderReady && this.playbackTrackPoints.length > 1;
    this.playToggleButton.disabled = !canPlay;
    this.playToggleButton.setAttribute("aria-pressed", this.isPlaying ? "true" : "false");
    const playIcon = this.playToggleButton.querySelector(".dashboard-3d-modal__play-icon--play");
    const pauseIcon = this.playToggleButton.querySelector(".dashboard-3d-modal__play-icon--pause");
    const label = this.playToggleButton.querySelector(".dashboard-3d-modal__play-label");

    playIcon?.classList.toggle("d-none", this.isPlaying);
    pauseIcon?.classList.toggle("d-none", !this.isPlaying);
    if (label) {
      label.textContent = this.isPlaying
        ? this.t("map3dPause")
        : !canPlay
          ? this.t("messages.loading")
          : this.t("map3dPlay");
    }
  }

  buildTrackFeature(workout) {
    const coordinates = Array.isArray(workout?.track)
      ? workout.track
          .map((point) => {
            const lng = Number(point?.lng);
            const lat = Number(point?.lat);
            const ele = Number(point?.alt ?? point?.altitude ?? point?.ele);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
              return null;
            }

            return Number.isFinite(ele) ? [lng, lat, ele] : [lng, lat];
          })
          .filter(Boolean)
      : [];

    if (coordinates.length < 2) {
      return null;
    }

    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates
      }
    };
  }

  buildPointsFeatureCollection(workout) {
    const track = Array.isArray(workout?.track) ? workout.track : [];
    const start = track[0];
    const end = track[track.length - 1];
    const features = [];

    if (start && Number.isFinite(Number(start.lng)) && Number.isFinite(Number(start.lat))) {
      features.push({
        type: "Feature",
        properties: { pointType: "start" },
        geometry: {
          type: "Point",
          coordinates: [Number(start.lng), Number(start.lat)]
        }
      });
    }

    if (end && Number.isFinite(Number(end.lng)) && Number.isFinite(Number(end.lat))) {
      features.push({
        type: "Feature",
        properties: { pointType: "end" },
        geometry: {
          type: "Point",
          coordinates: [Number(end.lng), Number(end.lat)]
        }
      });
    }

    return {
      type: "FeatureCollection",
      features
    };
  }

  updateSummary() {
    if (!this.summaryElement) {
      return;
    }

    if (!this.isConfigured()) {
      this.summaryElement.textContent = this.t("messages.map3dKeyMissing");
      return;
    }

    if (!this.hasRenderableTrack(this.currentWorkout)) {
      this.summaryElement.textContent = this.t("messages.map3dNoGps");
      return;
    }

    this.summaryElement.textContent = this.buildSummary(this.currentWorkout);
  }

  buildDefaultSummary(item) {
    const distanceKm = Number(item?.total_distance) > 0
      ? `${(Number(item.total_distance) / 1000).toFixed(1)} km`
      : null;
    const duration = Number(item?.total_timer_time);
    const durationText = Number.isFinite(duration) && duration > 0
      ? this.formatDuration(duration)
      : null;

    return [item?.description || item?.filename || this.t("map3dTitle"), distanceKm, durationText]
      .filter(Boolean)
      .join(" · ");
  }

  buildDefaultPlaybackDurationMs(item, points) {
    const pointCount = Array.isArray(points) ? points.length : 0;
    return Math.min(100000, Math.max(40000, pointCount * 107));
  }

  formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return [hours, minutes, secs]
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
      .join(":");
  }

  emptyCollection() {
    return {
      type: "FeatureCollection",
      features: []
    };
  }
}
