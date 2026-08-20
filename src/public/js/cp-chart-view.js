
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
import { loadAnalyticsOverview } from "./analytics-overview-client.js?v=atlas-blue-19";

function formatCPDuration(durationSeconds) {
  return durationSeconds < 60
    ? `CP${durationSeconds}S`
    : `CP${durationSeconds / 60}`;
}

const FALLBACK_SERIES_COLORS = [
  '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272',
  '#fc8452', '#9a60b4', '#ea7ccc', '#2f4554', '#61a0a8'
];

export default class CPChartView {

  constructor(containerId, handlers = {}) {
    this.chart = echarts.init(document.getElementById(containerId));
    this.handlers = handlers;
    this.t = createTranslator("analyticsPage");
    this.locale = getCurrentLocale();

    this.currentGrouping = handlers.preferences?.grouping || 'year';
    this.seriesVisibility = {
      ...handlers.preferences?.seriesVisibility
    };
    this.legendNameToKey = new Map();
    this.timeBounds = null;
    this.timeDomain = null;
    this.suppressTimeRangeEvent = false;
    this.periodSummaries = new Map();
    this.lastSeriesClickTime = 0;

    this.registerChartInteractions();
    // initial load
    this.loadData();
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
      this.lastSeriesClickTime = Date.now();
      const d = params.data?.extra || null;
      const value = Array.isArray(params.data?.value) ? params.data.value[0] : null;
      if (!value) return;
      await this.handlers?.onPeriodClick?.({
        date: value,
        grouping: this.currentGrouping,
        seriesName: params.seriesName,
        data: d
      });
    });

    this.chart.getZr().on('mousemove', (event) => {
      const point = [event.offsetX, event.offsetY];
      if (!this.chart.containPixel({ gridIndex: 0 }, point)) return;
      const timestamp = this.chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
      if (Number.isFinite(Number(timestamp))) {
        this.handlers?.onPeriodHover?.({ date: Number(timestamp) });
      }
    });
    this.chart.getZr().on('click', (event) => {
      const point = [event.offsetX, event.offsetY];
      if (!this.chart.containPixel({ gridIndex: 0 }, point)) return;
      const timestamp = Number(this.chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX));
      if (!Number.isFinite(timestamp)) return;
      setTimeout(() => {
        if (Date.now() - this.lastSeriesClickTime < 100) return;
        void this.handlers?.onPeriodClick?.({
          date: timestamp,
          grouping: this.currentGrouping,
          data: null,
          preferHoveredPeriod: true
        });
      }, 0);
    });
    this.chart.getZr().on('globalout', () => this.handlers?.onPeriodHoverEnd?.());
  }

  // -----------------------------
  // DATA LOADING
  // -----------------------------
  async loadData() {
    const overview = await loadAnalyticsOverview(this.currentGrouping);
    if (!overview) return;
    this.renderChart(overview.powerCurve);
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  renderChart(apiData) {
    const { data, grouping } = apiData;

    this.periodSummaries = new Map(Object.entries(data).map(([group, values]) => [
      Date.parse(this.mapToDate(grouping, group)),
      values
    ]).filter(([timestamp]) => Number.isFinite(timestamp)));

    const durations = Array.isArray(apiData.durations)
      ? apiData.durations.map(Number).filter(Number.isFinite)
      : [];

    this.legendNameToKey = new Map(
      durations.map((duration) => [formatCPDuration(duration), `cp${duration}`])
    );
    this.legendNameToKey.set('FTP', 'eftp');

    const series = durations.map(d => ({
      name: formatCPDuration(d),
      type: 'line',
      showSymbol: false,
      sampling: 'lttb',
      yAxisIndex: (d <= 60) ? 1 : 0,
      data: Object.entries(data).map(([grp, values]) => ({
        value: [
          this.getPeriodMidpoint(grouping, grp),
          values[`CP${d}`]?.power ?? null
        ],
        extra: values[`CP${d}`]
      }))
    }));

    series.push({
      name: 'FTP',
      type: 'line',
      showSymbol: false,
      sampling: 'lttb',
      symbol: 'none',
      yAxisIndex: 0,
      lineStyle: {
        type: 'dashed',
        width: 3
      },
      data: Object.entries(data).map(([grp, values]) => ({
        value: [
          this.getPeriodMidpoint(grouping, grp),
          values.eFTP?.power ?? null
        ],
        extra: values.eFTP
      }))
    });

    const option = {
      animation: false,
      title: {
        text: this.t("powerCurveEyebrow"),
        left: 24,
        top: 4,
        textStyle: { fontSize: 14, fontWeight: 600 }
      },
      tooltip: {
        trigger: 'axis',
        showContent: false,
        formatter: (params) => this.formatTooltip(params)
      },

      legend: {
        id: 'critical-power-legend',
        type: 'scroll',
        top: 2,
        right: 24,
        left: 138,
        selected: Object.fromEntries(
          [...this.legendNameToKey].map(([name, key]) => [
            name,
            this.seriesVisibility[key] !== false
          ])
        )
      },

      yAxis: [
        { type: "value", name: "Low Power", position: "left" },
        { type: "value", name: "High Power", position: "right" }
      ],

      xAxis: {
        type: 'time',
        axisPointer: { show: true, snap: false }
      },

      grid: {
        left: 92,
        right: 92,
        top: 58,
        bottom: 68
      },

      dataZoom: buildChartDataZoom(),

      series
    };

    this.chart.setOption(option, true);
    this.timeBounds = findSeriesTimeBounds(series);
    this.handlers?.onTimeBoundsChange?.(this.timeBounds);
  }

  formatTooltip(params) {
    const items = Array.isArray(params) ? params : [];
    const firstItem = items[0];
    const periodLabel = formatAnalysisPeriodValue(
      firstItem?.data?.value?.[0] ?? firstItem?.value?.[0],
      this.currentGrouping,
      this.locale
    ) || firstItem?.axisValueLabel || '';
    const lines = [periodLabel];
    items.filter((item) => Number.isFinite(Number(item.value?.[1]))).forEach((item) => {
      lines.push(`${item.marker}${item.seriesName}: ${Number(item.value[1]).toFixed(1)} W`);
    });
    return lines.join('<br>');
  }

  setTimeRange(range, domain = this.timeBounds) {
    if (!range) return;
    this.timeDomain = domain;
    this.suppressTimeRangeEvent = true;
    if (domain) {
      this.chart.setOption({
        xAxis: { min: domain.start, max: domain.end }
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
    if (!["year_week", "year_month", "year_quarter", "year"].includes(grouping)) return;
    if (this.currentGrouping === grouping) return;
    this.currentGrouping = grouping;
    await this.loadData();
  }

  setSeriesVisibility(key, visible) {
    if (typeof visible !== "boolean") return false;
    const legendName = [...this.legendNameToKey]
      .find(([, seriesKey]) => seriesKey === key)?.[0];
    if (!legendName) return false;
    this.seriesVisibility[key] = visible;
    this.chart.setOption({ legend: { selected: { [legendName]: visible } } });
    return true;
  }

  getPeriodMidpoint(grouping, group) {
    const sharedGrouping = {
      year_week: "week",
      year_month: "month",
      year_quarter: "quarter"
    }[grouping] || grouping;
    const period = resolveAnalysisPeriod(this.mapToDate(grouping, group), sharedGrouping);
    return period ? period.startMs + ((period.endMs - period.startMs) / 2) : null;
  }

  setSelectedPeriod(period) {
    const markAreaData = period
      ? [[{ xAxis: period.startMs }, { xAxis: period.endMs }]]
      : [];
    this.chart.setOption({
      series: [{
        id: 'selected-power-period',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
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
      }]
    });
  }

  // -----------------------------
  // DATE MAPPING
  // -----------------------------
  mapToDate(grouping, value) {
    if (!value) return null;

    const str = value.toString();

    try {
      if (grouping === 'year') {
        return `${str}-01-01`;
      }

      if (grouping === 'year_month') {
        const year = str.slice(0, 4);
        const month = str.slice(4, 6);
        return `${year}-${month}-01`;
      }

      if (grouping === 'year_quarter') {
        const year = str.slice(0, 4);
        const quarter = parseInt(str.slice(4, 5), 10);
        const month = (quarter - 1) * 3 + 1;
        return `${year}-${String(month).padStart(2, '0')}-01`;
      }

      if (grouping === 'year_week') {
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

  getVisiblePeriodMetrics(period) {
    const summary = this.getPeriodSummary(period);
    if (!summary) return [];

    return [...this.legendNameToKey].flatMap(([label, key]) => {
      if (this.seriesVisibility[key] === false) return [];
      const metric = key === "eftp" ? summary.eFTP : summary[`CP${key.slice(2)}`];
      return Number.isFinite(Number(metric?.power))
        ? [[label, Number(metric.power), metric]]
        : [];
    });
  }

  getPeriodWorkoutHighlights(period) {
    const summary = this.getPeriodSummary(period);
    if (!summary) return [];

    return [...this.legendNameToKey].flatMap(([label, key], seriesIndex) => {
      if (key === "eftp") return [];
      const metric = summary[`CP${key.slice(2)}`];
      const fileId = Number(metric?.fileId);
      if (!Number.isInteger(fileId) || fileId <= 0) return [];
      const visualColor = this.chart.getVisual?.({ seriesIndex }, 'color');
      return [{
        fileId,
        label,
        color: typeof visualColor === 'string'
          ? visualColor
          : FALLBACK_SERIES_COLORS[seriesIndex % FALLBACK_SERIES_COLORS.length]
      }];
    });
  }

  // -----------------------------
  // PUBLIC API
  // -----------------------------
  resize() {
    this.chart.resize();
  }

  showLoading() {
    this.chart.showLoading();
  }

  hideLoading() {
    this.chart.hideLoading();
  }
}

/*

let currentGrouping = 'year';

// 🎛️ Grouping wechseln



export function createCPChartView(containerId, handlers = {}) {
    const chart = echarts.init(document.getElementById(containerId));
    currentGrouping = 'year';
    registerChartInteractions(chart, handlers);

    // 🚀 initial load
    loadData(chart, currentGrouping);

    document.querySelectorAll('input[name="grouping"]').forEach(el => {
        el.addEventListener('change', (e) => {
            currentGrouping = e.target.value;
            loadData(chart, currentGrouping);
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
        if (grouping === 'year') {
            return `${str}-01-01`;
        }

        if (grouping === 'year_month') {
            const year = str.slice(0, 4);
            const month = str.slice(4, 6);
            return `${year}-${month}-01`;
        }

        if (grouping === 'year_quarter') {
            const year = str.slice(0, 4);
            const quarter = parseInt(str.slice(4, 5), 10);
            const month = (quarter - 1) * 3 + 1;
            return `${year}-${String(month).padStart(2, '0')}-01`;
        }

        if (grouping === 'year_week') {
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

// 🔥 Daten laden
async function loadData(chart, grouping) {
    const res = await fetch(`/files/cp-best-efforts?grouping=${grouping}`);
    if (res.status === 401) {
        // Session abgelaufen → redirect
        window.location.href = '/login';
        return;
    }
    else {
        const json = await res.json();
        renderChart(chart, json);
    }
}


// 🎨 Chart rendern
function renderChart(chart, apiData) {
    const { data, grouping } = apiData;

    const durations = [5, 15, 60, 120, 240, 480, 900, 1800];

    const series = durations.map(d => ({
        name: `CP${d}`,
        type: 'line',
        smooth: true,
        yAxisIndex: (d <= 60)?1:0,
        data: Object.entries(data).map(([grp, values]) => ({
            value: [
                mapToDate(grouping, grp),
                values[`CP${d}`]?.power ?? null
            ],
            extra: values[`CP${d}`]
        }))
    }));



    const option = {
        tooltip: {
            trigger: 'axis'
        },

        legend: {
            type: 'scroll'
        },

        yAxis : [
            { type: "value", name: "Low Power", position: "left" },
            { type: "value", name: "High Power", position: "right" }
        ],

        xAxis: {
            type: 'time'
        },



        dataZoom: [
            { type: 'inside' },
            { type: 'slider' }
        ],

        series
    };

    chart.setOption(option);
}*/
