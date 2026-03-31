export default class FTPChartView {

  constructor(containerId, handlers = {}) {
    this.chart = echarts.init(document.getElementById(containerId));
    this.handlers = handlers;

    this.currentGrouping = 'year';

    this.registerChartInteractions();
    this.initGroupingControls();

    // initial load
    this.loadFTPData();
    this.loadCPLATLData();
  }

  // -----------------------------
  // GROUPING UI
  // -----------------------------
  initGroupingControls() {
    document.querySelectorAll('input[name="grouping0"]').forEach(el => {
      el.addEventListener('change', async (e) => {
        this.currentGrouping = e.target.value;
        await this.loadFTPData();
      });
    });
  }

  // -----------------------------
  // INTERACTIONS
  // -----------------------------
  registerChartInteractions() {
    this.chart.on('click', async (params) => {
      const d = params.data?.extra;

      if (!d || !d.fileId) return;

      await this.handlers?.onCPClick?.(d);
    });
  }

  // -----------------------------
  // DATA LOADING
  // -----------------------------
  async loadFTPData() {
    const res = await fetch(`/files/ftp?period=${this.currentGrouping}`);

    if (res.status === 401) {
      window.location.href = '/login';
      return;
    } else {
      const json = await res.json();
      this.renderChart(json);
    }
  }

  async loadCPLATLData() {
    const res = await fetch(`/files/ctl-atl`);

    if (res.status === 401) {
      window.location.href = '/login';
      return;
    } else {
      const json = await res.json();
      console.log(json);
    }
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  renderChart(apiData) {
    const { data, grouping } = apiData;

    const series = [];

    series.push({
      name: 'FTP',
      type: 'line',
      smooth: true,
      data: data.map(row => ({
        value: [
          this.mapToDate(grouping, row.grp),
          row.ftp ?? null
        ],
        extra: data
      }))
    });

    series.push({
      name: 'CP8',
      type: 'line',
      smooth: true,
      data: data.map(row => ({
        value: [
          this.mapToDate(grouping, row.grp),
          row.cp8 ?? null
        ],
        extra: data
      }))
    });

    series.push({
      name: 'CP15',
      type: 'line',
      smooth: true,
      data: data.map(row => ({
        value: [
          this.mapToDate(grouping, row.grp),
          row.cp15 ?? null
        ],
        extra: data
      }))
    });

    const option = {
      tooltip: {
        trigger: 'axis'
      },

      legend: {
        type: 'scroll'
      },

      xAxis: {
        type: 'time'
      },

      yAxis: {
        type: 'value',
        name: 'Power (W)'
      },

      dataZoom: [
        { type: 'inside' },
        { type: 'slider' }
      ],

      series
    };

    this.chart.setOption(option);
  }

  // -----------------------------
  // DATE HELPERS
  // -----------------------------
  mapToDate(grouping, value) {
    if (!value) return null;

    const str = value.toString();

    try {
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

        return this.getDateOfISOWeek(year, week);
      }

    } catch (e) {
      console.warn("Date parse failed:", value);
      return null;
    }
  }

  getDateOfISOWeek(year, week) {
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



export function createFTPChartView(containerId, handlers = {}) {
    const chart = echarts.init(document.getElementById(containerId));
    currentGrouping = 'year';
    registerChartInteractions(chart, handlers);

    // 🚀 initial load
    //loadData(chart, currentGrouping);
    loadFTPData(chart, currentGrouping);
    loadCPLATLData(chart, currentGrouping);



    document.querySelectorAll('input[name="grouping0"]').forEach(async el => {
        el.addEventListener('change', async (e) => {
            currentGrouping = e.target.value;
            await loadFTPData(chart, currentGrouping);
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


async function loadFTPData(chart, grouping) {
    const res = await fetch(`/files/ftp?period=${grouping}`);
    if (res.status === 401) {
        // Session abgelaufen → redirect
        window.location.href = '/login';
        return;
    }
    else {
        const json = await res.json();
        //console.log(json);
        renderChart(chart, json);
    }
}


async function loadCPLATLData(chart, grouping) {
    const res = await fetch(`/files/ctl-atl`);
    //const res = await fetch(`/files/ftp?period=${grouping}`);

    if (res.status === 401) {
        // Session abgelaufen → redirect
        window.location.href = '/login';
        return;
    }
    else {
        const json = await res.json();
        console.log(json);
        //renderChart(chart, json);
    }
}



// 🎨 Chart rendern
function renderChart(chart, apiData) {
    const { data, grouping } = apiData;

    //const durations = [5, 15, 60, 120, 240, 480, 900, 1800];
    const series = [];
    series.push({
        name: 'FTP',
        type: 'line',
        smooth: true,
        data: data.map(row => ({
            value: [
                mapToDate(grouping, row.grp),
                row.ftp ?? null
            ],
            extra: data
        }))
    });
    series.push({
        name: 'CP8',
        type: 'line',
        smooth: true,
        data: data.map(row => ({
            value: [
                mapToDate(grouping, row.grp),
                row.cp8 ?? null
            ],
            extra: data
        }))
    });    
    series.push({
        name: 'CP15',
        type: 'line',
        smooth: true,
        data: data.map(row => ({
            value: [
                mapToDate(grouping, row.grp),
                row.cp15 ?? null
            ],
            extra: data
        }))
    });  


    const option = {
        tooltip: {
            trigger: 'axis'
        },

        legend: {
            type: 'scroll'
        },

        xAxis: {
            type: 'time'
        },

        yAxis: {
            type: 'value',
            name: 'Power (W)'
        },

        dataZoom: [
            { type: 'inside' },
            { type: 'slider' }
        ],

        series
    };

    chart.setOption(option);
}



*/