import { createTranslator } from "./i18n.js";

const COMPARISON_COLORS = ["#2563eb", "#d946ef", "#f59e0b"];

export default class SegmentElevationView {
  constructor(containerId, panelId, statsId, handlers = {}) {
    this.t = createTranslator("segmentsPage");
    this.container = document.getElementById(containerId);
    this.panel = document.getElementById(panelId);
    this.stats = document.getElementById(statsId);
    this.status = document.getElementById("segment-comparison-status");
    this.emptyState = document.getElementById("segment-elevation-empty");
    this.handlers = handlers;
    this.chart = this.container ? echarts.init(this.container) : null;
    this.currentSegment = null;
    this.comparisons = [];
    this.comparisonLoading = false;
    this.profileData = [];
    this.initChart();
    this.registerEvents();
  }

  initChart() {
    if (!this.chart) return;
    this.chart.setOption({
      animation: false,
      color: COMPARISON_COLORS,
      legend: {
        show: false,
        top: 0,
        left: 42,
        right: 12,
        type: "scroll",
        textStyle: { fontSize: 11 }
      },
      grid: { left: 52, right: 48, top: 18, bottom: 45 },
      tooltip: {
        trigger: "axis",
        confine: true,
        axisPointer: { type: "line", snap: false },
        formatter: (params) => this.formatTooltip(params)
      },
      xAxis: {
        type: "value",
        name: this.t("comparisonDistanceAxis"),
        nameLocation: "middle",
        nameGap: 25,
        min: 0,
        axisLabel: { formatter: (value) => Number(value).toFixed(1) }
      },
      yAxis: [
        {
          type: "value",
          name: this.t("comparisonPowerAxis"),
          position: "left",
          min: 0,
          splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.16)" } }
        },
        {
          type: "value",
          name: this.t("comparisonElevationAxis"),
          position: "right",
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: "#94a3b8" }
        }
      ],
      series: []
    });
  }

  registerEvents() {
    if (!this.chart) return;
    this.chart.on("mousemove", (params) => {
      if (params?.componentType !== "series") return;
      const point = this.pointAtDistance(Number(params?.data?.[0]));
      if (point) this.handlers.onHoverPoint?.(point, null, this.currentSegment);
    });
    this.chart.on("globalout", () => this.handlers.onLeave?.());
  }

  updateSegment(segment) {
    if (!this.chart || !segment) return;
    this.currentSegment = segment;
    this.profileData = this.buildProfileData(segment);
    this.render();
  }

  setComparisons(comparisons = []) {
    this.comparisons = Array.isArray(comparisons) ? comparisons.slice(0, 3) : [];
    this.render();
  }

  setComparisonLoading(loading) {
    this.comparisonLoading = !!loading;
    this.renderStatus();
  }

  render() {
    if (!this.chart || !this.currentSegment) return;
    const altitudeValues = this.profileData
      .map((point) => point[1])
      .filter((altitude) => Number.isFinite(altitude));
    const hasElevation = altitudeValues.length > 0;
    const hasComparisons = this.comparisons.some((comparison) => comparison.points?.length);

    if (!hasElevation && !hasComparisons && !this.comparisonLoading) {
      this.panel?.classList.add("d-none");
      this.emptyState?.classList.remove("d-none");
      this.renderStats([]);
      this.renderStatus();
      this.chart.setOption({ series: [] }, { replaceMerge: ["series"] });
      return;
    }

    this.panel?.classList.remove("d-none");
    this.emptyState?.classList.add("d-none");
    this.renderStats(altitudeValues);
    this.renderStatus();

    const series = [];
    if (hasElevation) {
      series.push({
        name: this.t("elevationLabel"),
        type: "line",
        yAxisIndex: 1,
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1.4, color: "rgba(100, 116, 139, 0.72)" },
        itemStyle: { color: "#64748b" },
        areaStyle: { color: "rgba(148, 163, 184, 0.16)" },
        data: this.profileData
      });
    }

    this.comparisons.forEach((comparison, index) => {
      const color = COMPARISON_COLORS[index];
      series.push({
        name: this.comparisonLabel(comparison),
        type: "line",
        yAxisIndex: 0,
        showSymbol: false,
        connectNulls: false,
        sampling: "lttb",
        lineStyle: { width: 2.2, color },
        itemStyle: { color },
        emphasis: { lineStyle: { width: 3 } },
        data: comparison.points.map((point) => [point.distanceKm, point.power, point.elapsedSeconds])
      });
    });

    const profileMin = hasElevation ? Math.min(...altitudeValues) : null;
    const profileMax = hasElevation ? Math.max(...altitudeValues) : null;
    const padding = hasElevation ? Math.max(3, (profileMax - profileMin) * 0.08) : 0;
    const segmentDistanceKm = Math.max(
      Number(this.currentSegment?.distance || 0) / 1000,
      ...series.flatMap((entry) => entry.data.map((point) => Number(point[0]) || 0))
    );

    this.chart.setOption({
      legend: {
        show: hasComparisons,
        data: this.comparisons.map((comparison) => this.comparisonLabel(comparison))
      },
      grid: { top: hasComparisons ? 42 : 18 },
      xAxis: { min: 0, max: segmentDistanceKm > 0 ? segmentDistanceKm : null },
      yAxis: [
        { show: hasComparisons, min: 0 },
        {
          show: hasElevation,
          min: hasElevation ? Math.floor(profileMin - padding) : null,
          max: hasElevation ? Math.ceil(profileMax + padding) : null
        }
      ],
      series
    }, { replaceMerge: ["series"] });
    this.resize();
  }

  comparisonLabel(comparison) {
    const rank = Number.isFinite(comparison?.rank) ? `#${comparison.rank} · ` : "";
    return `${rank}W-${comparison?.workoutId ?? ""}`;
  }

  formatTooltip(params = []) {
    const entries = Array.isArray(params) ? params : [];
    if (!entries.length) return "";
    const distanceKm = Number(entries[0]?.data?.[0]);
    const lines = [`<strong>${distanceKm.toFixed(2)} km</strong>`];
    for (const entry of entries) {
      const rawValue = entry?.data?.[1];
      if (rawValue == null) continue;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;
      const unit = entry.seriesName === this.t("elevationLabel") ? "m" : "W";
      lines.push(`${entry.marker}${entry.seriesName}: ${Math.round(value)} ${unit}`);
    }
    return lines.join("<br/>");
  }

  renderStats(altitudeValues) {
    if (!this.stats || !this.currentSegment) return;
    const distanceKm = Number(this.currentSegment.distance || 0) / 1000;
    const ascent = Math.round(Number(this.currentSegment.ascent || 0));
    const parts = [distanceKm > 0 ? `${distanceKm.toFixed(2)} km` : null];
    if (ascent > 0) parts.push(`${ascent} hm`);
    if (altitudeValues.length) {
      parts.push(`${Math.round(Math.min(...altitudeValues))}-${Math.round(Math.max(...altitudeValues))} m`);
    }
    this.stats.textContent = parts.filter(Boolean).join(" · ");
  }

  renderStatus() {
    if (!this.status) return;
    if (this.comparisonLoading) {
      this.status.textContent = this.t("comparisonLoading");
      this.status.classList.add("is-loading");
      return;
    }
    this.status.classList.remove("is-loading");
    this.status.textContent = this.comparisons.length
      ? this.t("comparisonCount", { count: this.comparisons.length })
      : this.t("comparisonHint");
  }

  buildProfileData(segment) {
    const track = Array.isArray(segment.track) ? segment.track : [];
    if (track.length === 0) return [];
    let distanceMeters = 0;
    const result = [];
    for (let index = 0; index < track.length; index += 1) {
      const point = track[index];
      const altitude = Number(point?.ele);
      if (index > 0) distanceMeters += this.haversine(track[index - 1], point);
      result.push([distanceMeters / 1000, Number.isFinite(altitude) ? altitude : null, index]);
    }
    return result;
  }

  pointAtDistance(distanceKm) {
    const track = this.currentSegment?.track;
    if (!Array.isArray(track) || !track.length || !Number.isFinite(distanceKm)) return null;
    const totalDistance = Number(this.currentSegment?.distance) / 1000
      || Number(this.profileData.at(-1)?.[0])
      || 0;
    const progress = totalDistance > 0 ? Math.max(0, Math.min(1, distanceKm / totalDistance)) : 0;
    return track[Math.min(track.length - 1, Math.round(progress * (track.length - 1)))];
  }

  haversine(a, b) {
    const toRad = (value) => (value * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
    const dLng = toRad((b.lng ?? 0) - (a.lng ?? 0));
    const lat1 = toRad(a.lat ?? 0);
    const lat2 = toRad(b.lat ?? 0);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const x = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  hide() {
    this.currentSegment = null;
    this.comparisons = [];
    this.comparisonLoading = false;
    this.profileData = [];
    this.panel?.classList.add("d-none");
    this.emptyState?.classList.remove("d-none");
    if (this.stats) this.stats.textContent = "";
    if (this.status) this.status.textContent = this.t("comparisonHint");
    this.chart?.setOption({ series: [] }, { replaceMerge: ["series"] });
    this.handlers.onLeave?.();
  }

  resize() {
    this.chart?.resize();
  }
}
