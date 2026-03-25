//const chartDom = document.getElementById('cp-chart');
//const chart = echarts.init(chartDom);

// ✅ HIER registrieren (nur einmal!)


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


/*async function loadData(chart, grouping) {
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
}*/

/*async function loadFTPData(chart, grouping) {
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
}*/


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

        /*yAxis: {
            type: 'value',
            name: 'ATL (W)'
        },*/

        yAxis,

        dataZoom: [
            { type: 'inside' },
            { type: 'slider' }
        ],

        series
    };

    chart.setOption(option, true);
}



