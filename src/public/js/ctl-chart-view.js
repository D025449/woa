import { buildChartDataZoom } from "./chart-data-zoom.js";
import {
  findSeriesTimeBounds,
  readZoomEventTimeRange
} from "./analytics-time-range.js?v=atlas-blue-22";
import {
  formatAnalysisPeriodValue,
  getISOWeekStartDate,
  resolveAnalysisPeriod
} from "./analytics-period.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import { POWER_DISTRIBUTION_ZONES } from "../../shared/PowerDistribution.js";
import { loadAnalyticsOverview } from "./analytics-overview-client.js?v=atlas-blue-19";

const LOAD_GRID_TOP = 58;
const DEFAULT_CHART_HEIGHT = 480;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function resolveLoadModelLayout(chartHeight) {
  const height = Math.max(300, Number(chartHeight) || DEFAULT_CHART_HEIGHT);
  const distributionHeight = clamp(Math.round(height * 0.15), 56, 90);
  const distributionTop = height - 31 - distributionHeight;
  const distributionTitleTop = distributionTop - 38;
  const loadHeight = Math.max(78, distributionTitleTop - 39 - LOAD_GRID_TOP);
  return {
    loadGrid: { top: LOAD_GRID_TOP, height: loadHeight },
    distributionGrid: { top: distributionTop, height: distributionHeight },
    distributionTitleTop,
    separatorTop: LOAD_GRID_TOP + loadHeight + 27
  };
}

export default class CTLChartView {

  constructor(containerId, handlers = {}) {
    this.chart = echarts.init(document.getElementById(containerId));
    this.handlers = handlers;
    this.t = createTranslator("analyticsPage");
    this.locale = getCurrentLocale();

    this.currentGrouping = handlers.preferences?.grouping || 'date';
    this.seriesVisibility = {
      atl: true,
      ctl: true,
      tsb: true,
      tss: true,
      ...handlers.preferences?.seriesVisibility
    };
    this.legendNameToKey = new Map([
      ['ATL', 'atl'],
      ['ATL_AVG', 'atl'],
      ['CTL', 'ctl'],
      ['TSB', 'tsb'],
      ['TSS', 'tss']
    ]);
    this.timeBounds = null;
    this.timeDomain = null;
    this.suppressTimeRangeEvent = false;
    this.periodSummaries = new Map();
    this.periodTimestamps = [];
    this.distributionSummaries = new Map();
    this.hasDistributionGrid = false;

    this.registerChartInteractions();
    this.loadCPLATLData();
  }

  // -----------------------------
  // INTERACTIONS
  // -----------------------------
  registerChartInteractions() {
    this.chart.on('datazoom', (event) => {
      if (this.suppressTimeRangeEvent) return;
      const range = readZoomEventTimeRange(event, this.timeDomain || this.timeBounds);
      if (range) this.handlers?.onTimeRangeChange?.(range);
    });

    this.chart.on('legendselectchanged', (params) => {
      for (const [name, key] of this.legendNameToKey) {
        if (typeof params.selected?.[name] === 'boolean') {
          this.seriesVisibility[key] = params.selected[name];
        }
      }
      this.handlers?.onPreferenceChange?.({
        seriesVisibility: { ...this.seriesVisibility }
      });
    });

    this.chart.on('click', async (params) => {
      const value = Array.isArray(params.data?.value) ? params.data.value[0] : null;
      if (!value) return;
      await this.handlers?.onPeriodClick?.({
        date: value,
        grouping: this.currentGrouping,
        seriesName: params.seriesName,
        data: params.data?.extra || null,
        preferHoveredPeriod: true
      });
    });

    this.chart.getZr().on('mousemove', (event) => {
      const point = [event.offsetX, event.offsetY];
      const axisIndex = this.chart.containPixel({ gridIndex: 0 }, point)
        ? 0
        : (this.hasDistributionGrid && this.chart.containPixel({ gridIndex: 1 }, point) ? 1 : null);
      if (axisIndex === null) return;
      const timestamp = this.chart.convertFromPixel({ xAxisIndex: axisIndex }, event.offsetX);
      if (Number.isFinite(Number(timestamp))) {
        this.handlers?.onPeriodHover?.({ date: Number(timestamp) });
      }
    });
    this.chart.getZr().on('globalout', () => this.handlers?.onPeriodHoverEnd?.());
  }

  // -----------------------------
  // DATA LOADING
  // -----------------------------
  async loadCPLATLData() {
    const overview = await loadAnalyticsOverview(this.currentGrouping);
    if (!overview) return;
    this.renderChart(
      this.currentGrouping,
      overview.loadModel,
      overview.powerDistribution
    );
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  renderChart(grouping0, apiData, distributionData = null) {
    const { data, grouping } = apiData;
    const resolveBarPeriod = (value) => {
      if (grouping !== "date") return resolveAnalysisPeriod(value, grouping);
      const startMs = typeof value === "number" ? value : Date.parse(value);
      return Number.isFinite(startMs)
        ? { startMs, endMs: startMs + (24 * 60 * 60 * 1000) }
        : null;
    };
    const getPeriodMidpoint = (value) => {
      const period = resolveBarPeriod(value);
      return period ? period.startMs + ((period.endMs - period.startMs) / 2) : value;
    };
    const getPeriodBarValue = (value, measurements) => {
      const period = resolveBarPeriod(value);
      if (!period) return [value, ...measurements, value, value];
      return [
        period.startMs + ((period.endMs - period.startMs) / 2),
        ...measurements,
        period.startMs,
        period.endMs - 1
      ];
    };
    const getPeriodPixelBounds = (api, startValue, endValue) => {
      const startX = api.coord([startValue, 0])[0];
      const endX = api.coord([endValue, 0])[0];
      if (!Number.isFinite(startX) || !Number.isFinite(endX)) return null;
      const rawWidth = Math.abs(endX - startX);
      const inset = rawWidth >= 8
        ? Math.min(3, Math.max(1, Math.round(rawWidth * 0.06)))
        : 0;
      return {
        x: Math.min(startX, endX) + inset,
        width: Math.max(1, rawWidth - (inset * 2))
      };
    };
    const renderTssBar = (params, api) => {
      const value = Number(api.value(1));
      if (!Number.isFinite(value)) return null;
      const xValue = api.value(0);
      const horizontal = getPeriodPixelBounds(api, api.value(2), api.value(3));
      if (!horizontal) return null;
      const bottom = api.coord([xValue, 0]);
      const top = api.coord([xValue, value]);
      const shape = echarts.graphic.clipRectByRect({
        x: horizontal.x,
        y: Math.min(top[1], bottom[1]),
        width: horizontal.width,
        height: Math.abs(bottom[1] - top[1])
      }, params.coordSys);
      return shape ? { type: 'rect', shape, style: api.style() } : null;
    };
    this.periodSummaries = new Map(data.map((row) => {
      const date = grouping === "date" ? row.date : this.mapToDate(grouping, row.date);
      return [Date.parse(date), {
        tss: Number(grouping === "date" ? row.tss : row.tss_sum) || 0,
        ctl: Number(grouping === "date" ? row.ctl : row.ctl_end) || 0,
        atl: Number(grouping === "date" ? row.atl : row.atl_avg) || 0,
        tsb: Number(grouping === "date" ? row.tsb : row.tsb_avg) || 0,
        activityCount: Number(row.activity_count) || 0,
        totalTimerTime: Number(row.total_timer_time) || 0,
        totalDistance: Number(row.total_distance) || 0
      }];
    }).filter(([timestamp]) => Number.isFinite(timestamp)));
    this.periodTimestamps = [...this.periodSummaries.keys()]
      .map(getPeriodMidpoint)
      .sort((left, right) => left - right);

    const series = [];
    let yAxis = [];

    if (grouping === 'date') {
      series.push({
        id: 'load-atl',
        name: 'ATL',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 0,
        data: data.map(row => ({
          value: [getPeriodMidpoint(row.date), row.atl ?? null]
        }))
      });

      series.push({
        id: 'load-ctl',
        name: 'CTL',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        data: data.map(row => ({
          value: [getPeriodMidpoint(row.date), row.ctl ?? null]
        }))
      });

      series.push({
        id: 'load-tsb',
        name: 'TSB',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 2,
        data: data.map(row => ({
          value: [getPeriodMidpoint(row.date), row.tsb ?? null]
        }))
      });

      series.push({
        id: 'load-tss',
        name: 'TSS',
        type: 'custom',
        coordinateSystem: 'cartesian2d',
        encode: { x: [0, 2, 3], y: 1 },
        renderItem: renderTssBar,
        yAxisIndex: 3,
        data: data.map(row => ({
          value: getPeriodBarValue(row.date, [row.tss ?? null])
        }))
      });

      yAxis = this.buildLoadYAxis();
    }

    if (["week", "month", "quarter", "year"].includes(grouping)) {
      series.push({
        id: 'load-atl',
        name: 'ATL_AVG',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 0,
        data: data.map(row => ({
          value: [
            getPeriodMidpoint(this.mapToDate(grouping, row.date)),
            row.atl_avg ?? null
          ]
        }))
      });

      series.push({
        id: 'load-ctl',
        name: 'CTL',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        data: data.map(row => ({
          value: [
            getPeriodMidpoint(this.mapToDate(grouping, row.date)),
            row.ctl_end ?? null
          ]
        }))
      });

      series.push({
        id: 'load-tsb',
        name: 'TSB',
        type: 'line',
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 2,
        data: data.map(row => ({
          value: [
            getPeriodMidpoint(this.mapToDate(grouping, row.date)),
            row.tsb_avg
          ]
        }))
      });

      series.push({
        id: 'load-tss',
        name: 'TSS',
        type: 'custom',
        coordinateSystem: 'cartesian2d',
        encode: { x: [0, 2, 3], y: 1 },
        renderItem: renderTssBar,
        yAxisIndex: 3,
        data: data.map(row => ({
          value: getPeriodBarValue(
            this.mapToDate(grouping, row.date),
            [row.tss_sum]
          )
        }))
      });

      yAxis = this.buildLoadYAxis();
    }

    const distributionRows = Array.isArray(distributionData?.data) ? distributionData.data : [];
    this.distributionSummaries = new Map(distributionRows.map((row) => [
      Date.parse(this.mapToDate(grouping, row.period)),
      row
    ]).filter(([timestamp]) => Number.isFinite(timestamp)));
    const showDistribution = distributionRows.some((row) => Number(row.activeSeconds) > 0);
    this.hasDistributionGrid = showDistribution;
    const layout = resolveLoadModelLayout(this.chart.getHeight?.());
    this.updateLayoutMarker(showDistribution, layout);
    if (showDistribution) {
      series.push({
        id: 'intensity-distribution',
        name: this.t("distributionLegend"),
        type: 'custom',
        coordinateSystem: 'cartesian2d',
        xAxisIndex: 1,
        yAxisIndex: 4,
        encode: { x: [0, 8, 9], y: [1, 2, 3, 4, 5, 6, 7] },
        renderItem: (params, api) => {
          const horizontal = getPeriodPixelBounds(api, api.value(8), api.value(9));
          if (!horizontal) return null;
          let cumulativePercent = 0;
          const children = [];
          POWER_DISTRIBUTION_ZONES.forEach((zone, zoneIndex) => {
            const percent = Number(api.value(zoneIndex + 1)) || 0;
            if (percent <= 0) return;
            const bottom = api.coord([api.value(0), cumulativePercent])[1];
            cumulativePercent += percent;
            const top = api.coord([api.value(0), cumulativePercent])[1];
            const shape = echarts.graphic.clipRectByRect({
              x: horizontal.x,
              y: top,
              width: horizontal.width,
              height: Math.max(0, bottom - top)
            }, params.coordSys);
            if (shape) children.push({
              type: 'rect',
              shape,
              style: { fill: zone.color }
            });
          });
          return { type: 'group', children };
        },
        data: distributionRows.map((row) => ({
          value: getPeriodBarValue(
            this.mapToDate(grouping, row.period),
            POWER_DISTRIBUTION_ZONES.map((zone) => Number(row.zonePercentages?.[zone.key]) || 0)
          ),
          distribution: row
        }))
      });
      yAxis.push({
        id: 'distribution-zones-axis',
        type: 'value',
        gridIndex: 1,
        min: 0,
        max: 100,
        interval: 50,
        axisLabel: { formatter: '{value} %', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.16)' } }
      });
    }

    const legendSelected = Object.fromEntries(
      [...this.legendNameToKey].map(([name, key]) => [name, this.seriesVisibility[key] !== false])
    );
    const loadLegend = {
      id: 'load-model-legend',
      type: 'scroll',
      top: 2,
      right: 24,
      left: 138,
      data: [...this.legendNameToKey.keys()],
      selected: legendSelected
    };
    const seriesTimeBounds = findSeriesTimeBounds(series);
    const periodTimeBounds = data.reduce((bounds, row) => {
      const value = grouping === "date" ? row.date : this.mapToDate(grouping, row.date);
      const period = resolveBarPeriod(value);
      if (!period) return bounds;
      return {
        start: Math.min(bounds.start, period.startMs),
        end: Math.max(bounds.end, period.endMs - 1)
      };
    }, { start: Infinity, end: -Infinity });
    const hasPeriodTimeBounds = Number.isFinite(periodTimeBounds.start)
      && Number.isFinite(periodTimeBounds.end);
    const chartTimeBounds = hasPeriodTimeBounds
      ? {
          start: Math.min(periodTimeBounds.start, seriesTimeBounds?.start ?? Infinity),
          end: Math.max(periodTimeBounds.end, seriesTimeBounds?.end ?? -Infinity)
        }
      : seriesTimeBounds;
    const sharedTimeAxis = {
      type: 'time',
      boundaryGap: [0, 0],
      ...(chartTimeBounds ? {
        min: chartTimeBounds.start,
        max: chartTimeBounds.end
      } : {})
    };
    const hiddenTimeAxisPresentation = {
      show: true,
      axisLine: { show: false },
      axisLabel: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisPointer: { show: true, snap: false }
    };
    const option = {
      tooltip: {
        trigger: 'axis',
        showContent: false,
        formatter: (params) => this.formatTooltip(params)
      },
      animation: false,
      title: showDistribution
        ? [
            { id: 'load-model-title', text: this.t("loadModelEyebrow"), left: 24, top: 4, textStyle: { fontSize: 14, fontWeight: 600 } },
            { id: 'distribution-title', text: this.t("distributionAxis"), left: 24, top: layout.distributionTitleTop, textStyle: { fontSize: 14, fontWeight: 600 } }
          ]
        : { text: this.t("loadModelEyebrow"), left: 24, top: 4, textStyle: { fontSize: 14, fontWeight: 600 } },
      legend: loadLegend,
      grid: showDistribution
        ? [
            { id: 'load-model-grid', left: 92, right: 92, ...layout.loadGrid },
            { id: 'distribution-grid', left: 92, right: 92, ...layout.distributionGrid }
          ]
        : { left: 92, right: 92, top: 58, bottom: 24 },
      xAxis: showDistribution
        ? [
            { id: 'load-time-axis', ...sharedTimeAxis, ...hiddenTimeAxisPresentation, gridIndex: 0 },
            {
              id: 'distribution-time-axis',
              ...sharedTimeAxis,
              gridIndex: 1,
              axisLabel: { show: false },
              axisTick: { show: false },
              axisPointer: { show: true, snap: false }
            }
          ]
        : { ...sharedTimeAxis, ...hiddenTimeAxisPresentation },
      yAxis,
      dataZoom: buildChartDataZoom({
        filterMode: "weakFilter",
        slider: { show: false }
      }).map((zoom) => ({
        ...zoom,
        xAxisIndex: showDistribution ? [0, 1] : 0
      })),
      axisPointer: showDistribution ? { link: [{ xAxisIndex: [0, 1] }] } : undefined,
      series
    };

    this.chart.clear();
    this.chart.setOption(option, { notMerge: true, lazyUpdate: false });
    this.timeBounds = chartTimeBounds;
    this.handlers?.onTimeBoundsChange?.(this.timeBounds);
  }

  updateLayoutMarker(showDistribution, layout) {
    const body = this.chart.getDom?.()?.parentElement;
    if (!body) return;
    body.classList.toggle("has-distribution", showDistribution);
    if (showDistribution) {
      body.style.setProperty("--analytics-load-separator-top", `${layout.separatorTop}px`);
    } else {
      body.style.removeProperty("--analytics-load-separator-top");
    }
  }

  setTimeRange(range, domain = this.timeBounds) {
    if (!range) return;
    this.timeDomain = domain;
    this.suppressTimeRangeEvent = true;
    if (domain) {
      this.chart.setOption({
        xAxis: this.hasDistributionGrid
          ? [
              { id: 'load-time-axis', min: domain.start, max: domain.end },
              { id: 'distribution-time-axis', min: domain.start, max: domain.end }
            ]
          : { min: domain.start, max: domain.end }
      });
    }
    this.chart.dispatchAction({
      type: 'dataZoom',
      batch: [
        {
          dataZoomId: 'chart-inside-zoom',
          startValue: range.start,
          endValue: range.end
        },
        {
          dataZoomId: 'chart-slider-zoom',
          startValue: range.start,
          endValue: range.end
        }
      ]
    }, { silent: true });
    queueMicrotask(() => {
      this.suppressTimeRangeEvent = false;
    });
  }

  async setGrouping(grouping) {
    if (!["week", "month", "quarter", "year"].includes(grouping)) return;
    if (this.currentGrouping === grouping) return;
    this.currentGrouping = grouping;
    await this.loadCPLATLData();
  }

  setSeriesVisibility(key, visible) {
    if (!(key in this.seriesVisibility) || typeof visible !== "boolean") return false;
    const legendName = [...this.legendNameToKey]
      .find(([, seriesKey]) => seriesKey === key)?.[0];
    if (!legendName) return false;
    this.seriesVisibility[key] = visible;
    const selected = { [legendName]: visible };
    this.chart.setOption({ legend: { id: 'load-model-legend', selected } });
    return true;
  }

  setSelectedPeriod(period) {
    const markAreaData = period
      ? [[{ xAxis: period.startMs }, { xAxis: period.endMs }]]
      : [];
    const buildMarker = (id, xAxisIndex, yAxisIndex) => ({
      id,
      type: 'line',
      xAxisIndex,
      yAxisIndex,
      data: [],
      silent: true,
      tooltip: { show: false },
      z: 0,
      markArea: {
        silent: true,
        label: { show: false },
        itemStyle: {
          color: 'rgba(23, 111, 190, 0.08)',
          borderColor: 'rgba(23, 111, 190, 0.48)',
          borderWidth: 1
        },
        data: markAreaData
      }
    });
    const series = [buildMarker('selected-load-period', 0, 0)];
    if (this.hasDistributionGrid) {
      series.push(buildMarker('selected-distribution-period', 1, 4));
    }
    this.chart.setOption({ series });
  }

  getPeriodTimestamps() {
    return this.periodTimestamps;
  }

  buildLoadYAxis() {
    const common = {
      type: "value",
      nameGap: 18,
      axisLabel: { margin: 8 }
    };

    return [
      { ...common, name: "ATL", position: "left" },
      { ...common, name: "CTL", position: "right" },
      { ...common, name: "TSB", position: "left", offset: 48 },
      {
        ...common,
        name: "TSS",
        position: "right",
        offset: 48,
        axisLabel: {
          ...common.axisLabel,
          formatter: (value) => this.formatCompactTssAxisValue(value)
        }
      }
    ];
  }

  formatCompactTssAxisValue(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || Math.abs(numericValue) < 1000) return `${value}`;

    const thousands = numericValue / 1000;
    return `${new Intl.NumberFormat(this.locale || "en", {
      maximumFractionDigits: Math.abs(thousands) < 10 ? 1 : 0
    }).format(thousands)}K`;
  }

  formatDuration(seconds) {
    const totalSeconds = Math.round(Number(seconds) || 0);
    if (totalSeconds < 60) return `${totalSeconds} s`;
    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')} h`;
  }

  formatTooltip(params) {
    const items = Array.isArray(params) ? params : [];
    const distributionItems = items.filter((item) => item.data?.distribution);
    const firstItem = distributionItems[0] || items[0];
    const periodLabel = formatAnalysisPeriodValue(
      firstItem?.data?.value?.[0] ?? firstItem?.value?.[0],
      this.currentGrouping,
      this.locale
    ) || firstItem?.axisValueLabel || '';
    if (distributionItems.length > 0) {
      const distribution = distributionItems[0].data.distribution;
      const lines = [periodLabel];
      POWER_DISTRIBUTION_ZONES.forEach((zone) => {
        const percent = Number(distribution.zonePercentages?.[zone.key]) || 0;
        if (percent <= 0) return;
        const seconds = Number(distribution.zoneSeconds?.[zone.key]) || 0;
        const marker = `<span style="display:inline-block;margin-right:4px;border-radius:50%;width:10px;height:10px;background:${zone.color}"></span>`;
        lines.push(`${marker}${zone.key.toUpperCase()}: ${percent.toFixed(1)} % · ${this.formatDuration(seconds)}`);
      });
      lines.push(`${this.t("distributionActive")}: ${this.formatDuration(distribution.activeSeconds)}`);
      if (Number(distribution.zeroSeconds) > 0) {
        lines.push(`${this.t("distributionCoasting")}: ${this.formatDuration(distribution.zeroSeconds)}`);
      }
      if (Number(distribution.unclassifiedSeconds) > 0) {
        lines.push(`${this.t("distributionWithoutFtp")}: ${this.formatDuration(distribution.unclassifiedSeconds)}`);
      }
      return lines.join('<br>');
    }

    const lines = [periodLabel];
    items.filter((item) => Number.isFinite(Number(item.value?.[1]))).forEach((item) => {
      lines.push(`${item.marker}${item.seriesName}: ${Number(item.value[1]).toFixed(1)}`);
    });
    return lines.join('<br>');
  }

  // -----------------------------
  // DATE MAPPING
  // -----------------------------
  mapToDate(grouping, value) {
    if (!value) return null;

    const str = value.toString();

    try {
      if (grouping === 'date') return str;

      if (grouping === 'year') {
        return `${str}-01-01`;
      }

      if (grouping === 'month') {
        const year = str.slice(0, 4);
        const month = str.slice(4, 6);
        return `${year}-${month}-01`;
      }

      if (grouping === 'quarter') {
        const year = str.slice(0, 4);
        const quarter = parseInt(str.slice(4, 5), 10);
        const month = (quarter - 1) * 3 + 1;
        return `${year}-${String(month).padStart(2, '0')}-01`;
      }

      if (grouping === 'week') {
        const year = parseInt(str.slice(0, 4), 10);
        const week = parseInt(str.slice(4, 6), 10);

        return getISOWeekStartDate(year, week);
      }

    } catch (e) {
      console.warn("Date parse failed:", value);
      return null;
    }
  }

  getPeriodSummary(period) {
    if (!period) return null;
    for (const [timestamp, summary] of this.periodSummaries) {
      if (timestamp >= period.startMs && timestamp < period.endMs) return summary;
    }
    return null;
  }

  getPeriodDistribution(period) {
    if (!period) return null;
    for (const [timestamp, distribution] of this.distributionSummaries) {
      if (timestamp >= period.startMs && timestamp < period.endMs) return distribution;
    }
    return null;
  }

  // -----------------------------
  // PUBLIC API
  // -----------------------------
  resize() {
    this.chart.resize();
    if (!this.hasDistributionGrid) return;
    const layout = resolveLoadModelLayout(this.chart.getHeight?.());
    this.updateLayoutMarker(true, layout);
    this.chart.setOption({
      title: [
        { id: 'load-model-title', top: 4 },
        { id: 'distribution-title', top: layout.distributionTitleTop }
      ],
      grid: [
        { id: 'load-model-grid', ...layout.loadGrid },
        { id: 'distribution-grid', ...layout.distributionGrid }
      ]
    });
  }

  showLoading() {
    this.chart.showLoading();
  }

  hideLoading() {
    this.chart.hideLoading();
  }
}



/*
let currentGrouping = 'date';

// 🎛️ Grouping wechseln



export function createCTLChartView(containerId, handlers = {}) {
    const chart = echarts.init(document.getElementById(containerId));
    currentGrouping = 'date';
    registerChartInteractions(chart, handlers);
    loadCPLATLData(chart, currentGrouping);



    document.querySelectorAll('input[name="grouping1"]').forEach(async el => {
        el.addEventListener('change', async (e) => {
            currentGrouping = e.target.value;
            await loadCPLATLData(chart, currentGrouping);
        });
    });

    return {
        chart,
        resize: () => chart.resize(),
        showLoading: () => chart.showLoading(),
        hideLoading: () => chart.hideLoading()
        //updateWorkout,
        //zoomToSegment
    };



}

function registerChartInteractions(chart, handlers) {
    chart.on('click', async (params) => {
        const d = params.data?.extra;

        if (!d || !d.fileId) return;
        await handlers?.onCPClick(d);

        //await loadWorkoutFromCP(d);
    });
}





// 🔁 Mapping (wie vorher besprochen)
function mapToDate(grouping, value) {
    if (!value) return null;

    const str = value.toString();

    try {
        if (grouping === 'date') {
            return str;
        }

        if (grouping === 'year') {
            return `${str}-01-01`;
        }

        if (grouping === 'month') {
            const year = str.slice(0, 4);
            const month = str.slice(4, 6);
            return `${year}-${month}-01`;
        }

        if (grouping === 'quarter') {
            const year = str.slice(0, 4);
            const quarter = parseInt(str.slice(4, 5), 10);
            const month = (quarter - 1) * 3 + 1;
            return `${year}-${String(month).padStart(2, '0')}-01`;
        }

        if (grouping === 'week') {
            const year = parseInt(str.slice(0, 4), 10);
            const week = parseInt(str.slice(4, 6), 10);

            return getDateOfISOWeek(year, week);
        }

    } catch (e) {
        console.warn("Date parse failed:", value);
        return null;
    }
}

function getDateOfISOWeek(year, week) {
    if (!year || !week) return null;

    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();

    const ISOweekStart = new Date(simple);

    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    return ISOweekStart.toISOString().split('T')[0];
}

async function loadCPLATLData(chart, grouping) {
    const res = await fetch(`/files/ctl-atl?period=${grouping}`);
    //const res = await fetch(`/files/ftp?period=${grouping}`);

    if (res.status === 401) {
        // Session abgelaufen → redirect
        window.location.href = '/login';
        return;
    }
    else {
        const json = await res.json();
        console.log(json);
        renderChart(chart, grouping, json);
    }
}


// 🎨 Chart rendern
function renderChart(chart, grouping0, apiData) {
    const { data, grouping } = apiData;


    //const durations = [5, 15, 60, 120, 240, 480, 900, 1800];
    const series = [];
    let yAxis = [];
    if (grouping === 'date') {
        series.push({
            name: 'ATL',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 0,
            data: data.map(row => ({
                value: [
                    row.date,
                    row.atl ?? null
                ]
            }))
        });
        series.push({
            name: 'CTL',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 1,
            data: data.map(row => ({
                value: [
                    row.date,
                    row.ctl ?? null
                ]
            }))
        });

        series.push({
            name: 'TSB',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 2,
            data: data.map(row => ({
                value: [
                    row.date,
                    row.tsb ?? null
                ]
            }))
        });
        series.push({
            name: 'TSS',
            type: 'bar',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 3,
            data: data.map(row => ({
                value: [
                    row.date,
                    row.tss ?? null
                ]
            }))
        });


        yAxis = [
            { type: "value", name: "ATL", position: "left" },
            { type: "value", name: "CTL", position: "right" },
            { type: "value", name: "TSB", position: "left", offset: 60 },
            { type: "value", name: "TSS", position: "right", offset: 60 }               
        ]
    }
    if (grouping === 'week' || grouping === 'month') {
        series.push({
            name: 'ATL_AVG',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 0,
            data: data.map(row => ({
                value: [
                    mapToDate(grouping, row.date),
                    row.atl_avg ?? null
                ]
            }))
        });
        series.push({
            name: 'CTL',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 1,
            data: data.map(row => ({
                value: [
                    mapToDate(grouping, row.date),
                    row.ctl_end ?? null
                ]
            }))
        });

        series.push({
            name: 'TSB',
            type: 'line',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 2,
            data: data.map(row => ({
                value: [
                    mapToDate(grouping, row.date),
                    row.tsb_avg
                ]
            }))
        });

        series.push({
            name: 'TSS',
            type: 'bar',
            showSymbol: false,
            sampling: "lttb",
            yAxisIndex: 3,
            data: data.map(row => ({
                value: [
                    mapToDate(grouping, row.date),
                    row.tss_sum
                ]
            }))
        });


        yAxis = [
            { type: "value", name: "ATL", position: "left" },
            { type: "value", name: "CTL", position: "right" },
            { type: "value", name: "TSB", position: "left", offset: 60 },
            { type: "value", name: "TSS", position: "right", offset: 60 }            
        ]
    }


    const option = {
        tooltip: {
            trigger: 'axis'
        },

        animation: false,


        legend: {
            type: 'scroll'
        },

        xAxis: {
            type: 'time'
        },

        yAxis,

        dataZoom: [
            { type: 'inside' },
            { type: 'slider' }
        ],

        series
    };

    chart.setOption(option, true);
}

*/
