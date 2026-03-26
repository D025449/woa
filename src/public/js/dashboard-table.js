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
      mapView.highlightSegment({start,end});
    },
    createMarkArea: (start, end) => {
      //chartView.zoomToSegment(start, end);
      //mapView.highlightSegment({start,end});
    },
    onUpdateWorkout: (workout) => {
        chartView.updateWorkout(workout);
        mapView.renderTrack(workout);
    }
  });

  const tableView = createTableView("#file-table", {
    onRowOpen: async (e, row) => {
      if (e.target.closest("button")) return;

      chartView.showLoading();

      try {
        let workout = await loadWorkoutByRow(row);
        
        const d = row.getData();
        workout.startDate = d.start_time;

        chartView.updateWorkout(workout);
        mapView.renderTrack(workout);
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