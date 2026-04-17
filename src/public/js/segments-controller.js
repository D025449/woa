import MapView from "./segment-map-view.js";
import ChartView from "./segment-chart-view.js";
import TableView from "./segment-table-view.js";
import SegmentElevationView from "./segment-elevation-view.js";
import WorkoutService from "./workout-service.js";
import MapSegment from "../../shared/MapSegment.js";
import UIStateManager from "./UIStateManager.js"

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("segmentController");
    this.selectedSegment = null;
    this.mapSegments = [];
    this.focusSegmentId = new URLSearchParams(window.location.search).get("focusSegmentId");
    this.restoredSegmentId = this.uiState.get("selectedSegmentId");
    this.focusApplied = false;
    this.initViews();
    this.registerEvents();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initViews() {


    this.mapView = new MapView("workout-map", this,
      {
        onSegmentOpen: async (e, segment) => {
          this.selectSegment(segment);
          await this.tableView.loadSegment(e, segment);
        }
      }

    );

    this.chartView = new ChartView("workout-chart", {
      onChartHoverIndex: (idx) => {
        this.mapView.moveMarkerToIndex(idx);
      },

      onZoomSegment: (start, end) => {
        this.chartView.zoomToSegment(start, end);
        this.mapView.highlightSegment({ start, end });
      },

      createMarkArea: (start, end) => {
        // bewusst unverändert gelassen
      },

      onUpdateWorkout: (workout) => {
        //this.chartView.updateWorkout(workout);
        //this.mapView.renderTrack(workout);
      }
    });

    this.tableView = new TableView("#segment-table", {

      onRowOpen: async (e, row) => {
        if (e.target.closest("button")) return;

        this.chartView.showLoading();

        try {
          const segment = row.getData();
          let workout = await WorkoutService.loadWorkoutByRow(segment.wid);
          this.chartView.updateWorkout(workout, segment);
          //this.mapView.renderTrack(workout);

        } catch (err) {
          console.error(err);

        } finally {
          this.chartView.hideLoading();
        }
      },

      onRowDelete: async (row) => {
        await WorkoutService.deleteWorkoutByRow(row);
      }

    });

    this.elevationView = new SegmentElevationView(
      "segment-elevation-chart",
      "segment-elevation-panel",
      "segment-elevation-stats",
      {
        onHoverPoint: (point) => {
          this.mapView.moveMarkerToPoint(point);
        },
        onLeave: () => {
          this.mapView.hideMarker();
        }
      }
    );

    this.deleteButton = document.getElementById("delete-selected-segment");
    this.segmentHeader = document.getElementById("segment-header");
    this.updateDeleteButton();
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.deleteButton?.addEventListener("click", () => this.deleteSelectedSegment());
  }

  onResize() {
    this.chartView.resize();
    this.elevationView.resize();
  }

  selectSegment(segment) {
    this.selectedSegment = segment;
    this.uiState.set("selectedSegmentId", segment?.id ?? null);
    this.mapView.selectSegment(segment);
    this.elevationView.updateSegment(segment);
    this.updateDeleteButton();
  }

  clearSelectedSegment() {
    this.selectedSegment = null;
    this.uiState.remove("selectedSegmentId");
    this.tableView.clear();
    this.elevationView.hide();
    if (this.segmentHeader) {
      this.segmentHeader.textContent = "Segments";
    }
    this.mapView.selectSegment(null);
    this.mapView.hideMarker();
    this.updateDeleteButton();
  }

  updateDeleteButton() {
    if (!this.deleteButton) return;

    const hasSelection = !!this.selectedSegment;
    this.deleteButton.classList.toggle("d-none", !hasSelection);
    this.deleteButton.disabled = !hasSelection;
  }

  async deleteSelectedSegment() {
    const segment = this.selectedSegment;
    if (!segment) return;

    const label = `${segment.start?.name ?? "Start"} - ${segment.end?.name ?? "End"}`;
    const ok = window.confirm(`Segment wirklich loeschen?\n\n${label}`);
    if (!ok) return;

    try {
      if (segment.rowstate === "DB") {
        await MapSegment.deleteSegment(segment.id);
      }

      this.mapSegments = this.mapSegments.filter((entry) => entry.id !== segment.id);
      this.mapView.controller.mapSegments = this.mapSegments;
      this.mapView.refreshSegments();
      this.clearSelectedSegment();
    } catch (err) {
      console.error(err);
      window.alert("Failed to delete segment");
    }
  }

  async tryFocusRequestedSegment() {
    const targetSegmentId = this.focusSegmentId || this.restoredSegmentId;

    if (!targetSegmentId || this.focusApplied) {
      return;
    }

    let segment = this.mapSegments.find(
      (entry) => String(entry.id) === String(targetSegmentId)
    );

    if (!segment) {
      segment = await MapSegment.getSegmentById(targetSegmentId);
      if (!segment) {
        if (!this.focusSegmentId) {
          this.uiState.remove("selectedSegmentId");
        }
        this.focusApplied = true;
        return;
      }

      const alreadyPresent = this.mapSegments.some(
        (entry) => String(entry.id) === String(segment.id)
      );

      if (!alreadyPresent) {
        this.mapSegments.push(segment);
        this.mapView.renderSegment(segment);
      }
    }

    this.focusApplied = true;
    this.selectSegment(segment);
    this.mapView.focusSegment(segment);
    await this.tableView.loadSegment({ type: "focus" }, segment);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("focusSegmentId");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  }
}
