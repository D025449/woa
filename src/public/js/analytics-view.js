import { createMapView } from "./map-view.js";
import { createCPChartView } from "./cp-chart-view.js";
import { createFTPChartView } from "./ftp-chart-view.js";
import { createCTLChartView } from "./ctl-chart-view.js";
import { createChartView } from "./chart-view.js";
//import { createTableView } from "./table-view.js";

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
  const CPChartView = createCPChartView('cp-chart', {
    onCPClick: async (row) => {
      const workout = await loadWorkoutByRow(row);
      chartView.updateWorkoutCP(workout, row);
      mapView.renderTrack(workout.track);


    }
  }
  );

  const FTPChartView = createFTPChartView('ftp-chart', {
    onCPClick: async (row) => {
      //const workout = await loadWorkoutByRow(row);
      //chartView.updateWorkoutCP(workout, row);
      //mapView.renderTrack(workout.track);


    }
  }
  );

    const CTLChartView = createCTLChartView('ctl-chart', {
    onCPClick: async (row) => {
      //const workout = await loadWorkoutByRow(row);
      //chartView.updateWorkoutCP(workout, row);
      //mapView.renderTrack(workout.track);


    }
  }
  );

  /*const tableView = createTableView("#file-table", {
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
  });*/

  window.addEventListener("resize", () => chartView.resize());
  window.addEventListener("resize", () => CPChartView.resize());
  window.addEventListener("resize", () => FTPChartView.resize());
  window.addEventListener("resize", () => CTLChartView.resize());

});