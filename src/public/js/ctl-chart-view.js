import { buildChartDataZoom } from "./chart-data-zoom.js";
import {
  findSeriesTimeBounds,
  readZoomEventTimeRange
} from "./analytics-time-range.js";
import {
  formatAnalysisPeriodValue,
  getISOWeekStartDate
} from "./analytics-period.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import { POWER_DISTRIBUTION_ZONES } from "../../shared/PowerDistribution.js";

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
      intensityDistribution: true,
      ...handlers.preferences?.seriesVisibility
    };
    this.legendNameToKey = new Map([
      ['ATL', 'atl'],
      ['ATL_AVG', 'atl'],
      ['CTL', 'ctl'],
      ['TSB', 'tsb'],
      ['TSS', 'tss'],
      [this.t("distributionLegend"), 'intensityDistribution']
    ]);
    this.timeBounds = null;
    this.timeDomain = null;
    this.suppressTimeRangeEvent = false;
    this.periodSummaries = new Map();
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
        data: params.data?.extra || null
      });
    });
  }

  // -----------------------------
  // DATA LOADING
  // -----------------------------
  async loadCPLATLData() {
    const [res, distributionRes] = await Promise.all([
      fetch(`/files/ctl-atl?period=${this.currentGrouping}`),
      fetch(`/files/power-distribution?grouping=${this.currentGrouping}`)
    ]);

    if (res.status === 401 || distributionRes.status === 401) {
      window.location.href = '/login';
      return;
    }
    if (!res.ok || !distributionRes.ok) {
      throw new Error(`Analytics load failed (${res.status}/${distributionRes.status})`);
    }
    const [json, distributionJson] = await Promise.all([res.json(), distributionRes.json()]);
    this.renderChart(this.currentGrouping, json, distributionJson);
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  renderChart(grouping0, apiData, distributionData = null) {
    const { data, grouping } = apiData;
    this.periodSummaries = new Map(data.map((row) => {
      const date = grouping === "date" ? row.date : this.mapToDate(grouping, row.date);
      return [Date.parse(date), {
        tss: Number(grouping === "date" ? row.tss : row.tss_sum) || 0,
        ctl: Number(grouping === "date" ? row.ctl : row.ctl_end) || 0,
        atl: Number(grouping === "date" ? row.atl : row.atl_avg) || 0,
        tsb: Number(grouping === "date" ? row.tsb : row.tsb_avg) || 0
      }];
    }).filter(([timestamp]) => Number.isFinite(timestamp)));

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
          value: [row.date, row.atl ?? null]
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
          value: [row.date, row.ctl ?? null]
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
          value: [row.date, row.tsb ?? null]
        }))
      });

      series.push({
        id: 'load-tss',
        name: 'TSS',
        type: 'bar',
        showSymbol: false,
        yAxisIndex: 3,
        data: data.map(row => ({
          value: [row.date, row.tss ?? null]
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
            this.mapToDate(grouping, row.date),
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
            this.mapToDate(grouping, row.date),
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
            this.mapToDate(grouping, row.date),
            row.tsb_avg
          ]
        }))
      });

      series.push({
        id: 'load-tss',
        name: 'TSS',
        type: 'bar',
        showSymbol: false,
        yAxisIndex: 3,
        data: data.map(row => ({
          value: [
            this.mapToDate(grouping, row.date),
            row.tss_sum
          ]
        }))
      });

      yAxis = this.buildLoadYAxis();
    }

    const distributionRows = Array.isArray(distributionData?.data) ? distributionData.data : [];
    const showDistribution = distributionRows.some((row) => Number(row.activeSeconds) > 0);
    const distributionPeriodMilliseconds = {
      week: 7 * 24 * 60 * 60 * 1000,
      month: 28 * 24 * 60 * 60 * 1000,
      quarter: 90 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000
    }[grouping] || (7 * 24 * 60 * 60 * 1000);
    this.hasDistributionGrid = showDistribution;
    if (showDistribution) {
      series.push({
        id: 'intensity-distribution',
        name: this.t("distributionLegend"),
        type: 'custom',
        coordinateSystem: 'cartesian2d',
        xAxisIndex: 1,
        yAxisIndex: 4,
        encode: { x: 0, y: [1, 2, 3, 4, 5, 6, 7] },
        renderItem: (params, api) => {
          const x = api.coord([api.value(0), 0])[0];
          const width = Math.min(30, Math.max(7, api.size([distributionPeriodMilliseconds, 0])[0] * 0.55));
          let cumulativePercent = 0;
          const children = [];
          POWER_DISTRIBUTION_ZONES.forEach((zone, zoneIndex) => {
            const percent = Number(api.value(zoneIndex + 1)) || 0;
            if (percent <= 0) return;
            const bottom = api.coord([api.value(0), cumulativePercent])[1];
            cumulativePercent += percent;
            const top = api.coord([api.value(0), cumulativePercent])[1];
            const shape = echarts.graphic.clipRectByRect({
              x: x - (width / 2),
              y: top,
              width,
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
          value: [
            this.mapToDate(grouping, row.period),
            ...POWER_DISTRIBUTION_ZONES.map((zone) => Number(row.zonePercentages?.[zone.key]) || 0)
          ],
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
        name: this.t("distributionAxis"),
        nameGap: 12,
        axisLabel: { formatter: '{value} %', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.16)' } }
      });
    }

    const legendData = [
      ...new Set(series
        .map((item) => item.name))
    ];
    const option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params) => this.formatTooltip(params)
      },
      animation: false,
      legend: {
        type: 'scroll',
        data: legendData,
        selected: Object.fromEntries(
          [...this.legendNameToKey].map(([name, key]) => [
            name,
            this.seriesVisibility[key] !== false
          ])
        )
      },
      grid: showDistribution
        ? [
            { id: 'load-model-grid', left: 92, right: 92, top: 58, height: 260 },
            { id: 'distribution-grid', left: 92, right: 92, top: 350, height: 72 }
          ]
        : { left: 92, right: 92, top: 58, bottom: 24 },
      xAxis: showDistribution
        ? [
            { id: 'load-time-axis', type: 'time', gridIndex: 0, show: false },
            { id: 'distribution-time-axis', type: 'time', gridIndex: 1, axisLabel: { fontSize: 10 }, axisTick: { show: false } }
          ]
        : { type: 'time', show: false },
      yAxis,
      dataZoom: buildChartDataZoom({
        filterMode: "filter",
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
    this.timeBounds = findSeriesTimeBounds(series);
    this.handlers?.onTimeBoundsChange?.(this.timeBounds);
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
    this.chart.setOption({ legend: { selected: { [legendName]: visible } } });
    return true;
  }

  getPeriodTimestamps() {
    return [...this.periodSummaries.keys()];
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
      { ...common, name: "TSS", position: "right", offset: 48 }
    ];
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
