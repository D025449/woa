import { createMapView } from "./map-view.js";
import { createChartView } from "./chart-view.js";
import { createTableView } from "./table-view.js";
import { loadWorkoutByRow, deleteWorkoutByRow } from "./workout-service.js";

document.addEventListener("DOMContentLoaded", () => {
  const mapView = createMapView("workout-map");
  const chartView = createChartView("workout-chart", {
    onChartHoverIndex: (idx) => {
      mapView.moveMarkerToIndex(idx);
    },
    onZoomSegment: (start, end) => {
      chartView.zoomToSegment(start, end);
    }
  });

  const tableView = createTableView("#file-table", {
    onRowOpen: async (e, row) => {
      if (e.target.closest("button")) return;

      chartView.showLoading();

      try {
        const workout = await loadWorkoutByRow(row);
        chartView.updateWorkout(workout);
        mapView.renderTrack(workout.track);
      } catch (err) {
        console.error(err);
      } finally {
        chartView.hideLoading();
      }
    },

    onRowDelete: async (row) => {
      await deleteWorkoutByRow(row);
    }
  });

  window.addEventListener("resize", () => chartView.resize());
});