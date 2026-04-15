export default class SegmentElevationView {

  constructor(containerId, panelId, statsId, handlers = {}) {
    this.container = document.getElementById(containerId);
    this.panel = document.getElementById(panelId);
    this.stats = document.getElementById(statsId);
    this.emptyState = document.getElementById("segment-elevation-empty");
    this.handlers = handlers;
    this.chart = this.container ? echarts.init(this.container) : null;
    this.currentSegment = null;

    this.initChart();
    this.registerEvents();
  }

  initChart() {
    if (!this.chart) return;

    this.chart.setOption({
      animation: false,
      grid: {
        left: 48,
        right: 16,
        top: 18,
        bottom: 28
      },
      tooltip: {
        trigger: "axis",
        confine: true,
        formatter: (params) => {
          const point = params?.[0];
          if (!point) return "";

          const [distanceKm, altitude] = point.data;
          return `${distanceKm.toFixed(2)} km<br/>${Math.round(altitude)} m`;
        }
      },
      xAxis: {
        type: "value",
        name: "km",
        nameLocation: "middle",
        nameGap: 24,
        axisLabel: {
          formatter: (value) => value.toFixed(1)
        }
      },
      yAxis: {
        type: "value",
        name: "m"
      },
      series: [
        {
          name: "Altitude",
          type: "line",
          showSymbol: false,
          smooth: true,
          lineStyle: {
            width: 2,
            color: "#2f6fed"
          },
          areaStyle: {
            color: "rgba(47, 111, 237, 0.18)"
          },
          data: []
        }
      ]
    });
  }

  registerEvents() {
    if (!this.chart) return;

    this.chart.on("mousemove", (params) => {
      if (params?.componentType !== "series") return;

      const point = this.currentSegment?.track?.[params.dataIndex];
      if (!point) return;

      this.handlers.onHoverPoint?.(point, params.dataIndex, this.currentSegment);
    });

    this.chart.on("globalout", () => {
      this.handlers.onLeave?.();
    });
  }

  updateSegment(segment) {
    if (!this.chart || !segment) return;
    this.currentSegment = segment;

    const data = this.buildProfileData(segment);
    const altitudeValues = data
      .map(([, altitude]) => altitude)
      .filter((altitude) => Number.isFinite(altitude));
    const hasElevation = altitudeValues.length > 0;

    if (!hasElevation) {
      this.hide();
      return;
    }

    this.panel?.classList.remove("d-none");
    this.emptyState?.classList.add("d-none");
    if (this.stats) {
      const distanceKm = (segment.distance ?? 0) / 1000;
      const ascent = Math.round(segment.ascent ?? 0);
      const avgGrade = distanceKm > 0
        ? ((segment.ascent ?? 0) / (distanceKm * 1000)) * 100
        : null;
      const profileMin = Math.min(...altitudeValues);
      const profileMax = Math.max(...altitudeValues);
      const parts = [
        `${distanceKm.toFixed(2)} km`,
        `${ascent} hm`
      ];

      if (Number.isFinite(avgGrade)) {
        parts.push(`${avgGrade.toFixed(1)} %`);
      }

      if (Number.isFinite(profileMin) && Number.isFinite(profileMax)) {
        parts.push(`${Math.round(profileMin)}-${Math.round(profileMax)} m`);
      }

      this.stats.textContent = parts.join(" · ");
    }

    const profileMin = Math.min(...altitudeValues);
    const profileMax = Math.max(...altitudeValues);
    const padding = Math.max(3, (profileMax - profileMin) * 0.08);

    this.chart.setOption({
      yAxis: {
        min: Math.floor(profileMin - padding),
        max: Math.ceil(profileMax + padding)
      },
      series: [{ data }]
    });

    this.resize();
  }

  buildProfileData(segment) {
    const track = Array.isArray(segment.track) ? segment.track : [];
    if (track.length === 0) return [];

    let distanceMeters = 0;
    const result = [];

    for (let i = 0; i < track.length; i++) {
      const point = track[i];
      const altitude = Number(point?.ele);

      if (i > 0) {
        distanceMeters += this.haversine(track[i - 1], point);
      }

      result.push([
        distanceMeters / 1000,
        Number.isFinite(altitude) ? altitude : null
      ]);
    }

    return result;
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
    const x =
      sinLat * sinLat +
      Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  hide() {
    this.currentSegment = null;
    this.panel?.classList.add("d-none");
    this.emptyState?.classList.remove("d-none");
    if (this.stats) {
      this.stats.textContent = "";
    }
    this.chart?.setOption({
      series: [{ data: [] }]
    });
    this.handlers.onLeave?.();
  }

  resize() {
    this.chart?.resize();
  }
}
