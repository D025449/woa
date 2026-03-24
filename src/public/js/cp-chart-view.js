//const chartDom = document.getElementById('cp-chart');
//const chart = echarts.init(chartDom);

// ✅ HIER registrieren (nur einmal!)


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



