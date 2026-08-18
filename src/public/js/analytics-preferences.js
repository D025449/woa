export function createDefaultAnalyticsPreferences() {
  return {
    timeRange: { mode: "all" },
    grouping: "month",
    loadModel: {
      grouping: "month",
      seriesVisibility: {
        atl: true,
        ctl: true,
        tsb: true,
        tss: true,
        intensityDistribution: true
      }
    },
    powerCurve: {
      grouping: "year_month",
      seriesVisibility: {}
    }
  };
}

export function mergeAnalyticsPreferences(currentState, chartKey, patch) {
  const currentChart = currentState[chartKey];

  return {
    ...currentState,
    [chartKey]: {
      ...currentChart,
      ...patch,
      seriesVisibility: {
        ...currentChart.seriesVisibility,
        ...patch.seriesVisibility
      }
    }
  };
}
