export function createDefaultAnalyticsPreferences() {
  return {
    timeRange: { mode: "all" },
    loadModel: {
      grouping: "date",
      seriesVisibility: { atl: true, ctl: true, tsb: true, tss: true }
    },
    powerCurve: {
      grouping: "year",
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
