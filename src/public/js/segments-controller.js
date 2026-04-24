import MapView from "./segment-map-view.js";
import ChartView from "./segment-chart-view.js";
import TableView from "./segment-table-view.js";
import SegmentElevationView from "./segment-elevation-view.js";
import WorkoutService from "./workout-service.js";
import MapSegment from "../../shared/MapSegment.js";
import UIStateManager from "./UIStateManager.js"
import confirmModal from "./confirm-modal.js";

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("segmentController");
    this.selectedSegment = null;
    this.selectedSegmentSharing = null;
    this.mapSegments = [];
    this.shareableGroups = [];
    this.currentUserId = String(document.body?.dataset?.currentUserId || "");
    this.segmentScope = this.uiState.get("segmentScope", "mine");
    this.bestEffortsScope = this.uiState.get("segmentBestEffortsScope", "mine");
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
      currentUserId: this.currentUserId,
      initialScope: this.bestEffortsScope,

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
      },

      onScopeChange: (scope) => {
        this.bestEffortsScope = scope;
        this.uiState.set("segmentBestEffortsScope", scope);
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
    this.shareToggleButton = document.getElementById("share-segment-toggle");
    this.shareInline = document.getElementById("segment-share-inline");
    this.shareModeSelect = document.getElementById("segment-share-mode");
    this.shareGroupsContainer = document.getElementById("segment-share-groups");
    this.shareStatus = document.getElementById("segment-share-status");
    this.shareSaveButton = document.getElementById("segment-share-save");
    this.segmentHeader = document.getElementById("segment-header");
    this.segmentSharedMeta = document.getElementById("segment-shared-meta");
    this.segmentSharedMetaText = document.getElementById("segment-shared-meta-text");
    this.scopeMineButton = document.getElementById("segments-scope-mine");
    this.scopeSharedButton = document.getElementById("segments-scope-shared");
    this.scopeAllButton = document.getElementById("segments-scope-all");
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.syncScopeButtons();
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.deleteButton?.addEventListener("click", () => this.deleteSelectedSegment());
    this.shareToggleButton?.addEventListener("click", () => this.toggleShareInline());
    this.shareModeSelect?.addEventListener("change", () => this.updateShareModeUi());
    this.shareSaveButton?.addEventListener("click", async () => {
      await this.saveSegmentSharing();
    });
    [this.scopeMineButton, this.scopeSharedButton, this.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const scope = button.getAttribute("data-segment-scope") || "mine";
        await this.setSegmentScope(scope);
      });
    });
    this.loadShareableGroups();
  }

  onResize() {
    this.chartView.resize();
    this.elevationView.resize();
  }

  syncScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.segmentScope === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.segmentScope === "shared");
    this.scopeAllButton?.classList.toggle("active", this.segmentScope === "all");
  }

  async setSegmentScope(scope) {
    const normalizedScope = ["mine", "shared", "all"].includes(String(scope))
      ? String(scope)
      : "mine";

    if (normalizedScope === this.segmentScope) {
      return;
    }

    this.segmentScope = normalizedScope;
    this.uiState.set("segmentScope", normalizedScope);
    this.syncScopeButtons();
    this.clearSelectedSegment();
    this.restoredSegmentId = null;
    if (!this.focusSegmentId) {
      this.uiState.remove("selectedSegmentId");
    }
    this.mapSegments = [];
    this.mapView.controller.mapSegments = this.mapSegments;
    this.mapView.refreshSegments();
    this.focusApplied = false;
    await this.mapView.loadSegmentsForViewport(this.mapView.map.getBounds());
  }

  isSegmentVisibleInCurrentScope(segment) {
    if (!segment) {
      return false;
    }

    const ownerId = segment.uid == null ? "" : String(segment.uid);
    const isOwnedByCurrentUser = ownerId !== "" && ownerId === this.currentUserId;

    if (this.segmentScope === "shared") {
      return !isOwnedByCurrentUser;
    }

    if (this.segmentScope === "all") {
      return true;
    }

    return isOwnedByCurrentUser;
  }

  selectSegment(segment) {
    this.selectedSegment = segment;
    this.selectedSegmentSharing = null;
    this.uiState.set("selectedSegmentId", segment?.id ?? null);
    this.mapView.selectSegment(segment);
    this.elevationView.updateSegment(segment);
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.updateBestEffortsScopeUi();
    this.loadSelectedSegmentSharing();
  }

  clearSelectedSegment() {
    this.selectedSegment = null;
    this.selectedSegmentSharing = null;
    this.uiState.remove("selectedSegmentId");
    this.tableView.clear();
    this.elevationView.hide();
    if (this.segmentHeader) {
      this.segmentHeader.textContent = "Segments";
    }
    this.mapView.selectSegment(null);
    this.mapView.hideMarker();
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.updateBestEffortsScopeUi();
  }

  updateDeleteButton() {
    if (!this.deleteButton) return;

    const isEditable = this.canEditSelectedSegment();
    this.deleteButton.classList.toggle("d-none", !isEditable);
    this.deleteButton.disabled = !isEditable;
  }

  updateSegmentMeta() {
    if (!this.segmentSharedMeta || !this.segmentSharedMetaText) {
      return;
    }

    const segment = this.selectedSegment;
    const ownerLabel = segment?.ownerDisplayName || segment?.ownerEmail || "";
    const ownerId = segment?.uid == null ? "" : String(segment.uid);
    const isOwnedByCurrentUser = ownerId !== "" && ownerId === this.currentUserId;
    const isSharedSegment = Number(segment?.shareGroupCount || 0) > 0;

    if (!segment) {
      this.segmentSharedMeta.classList.add("d-none");
      this.segmentSharedMetaText.textContent = "";
      return;
    }

    this.segmentSharedMeta.classList.remove("d-none");
    const eyebrow = this.segmentSharedMeta.querySelector(".segments-shared-meta__eyebrow");
    if (eyebrow) {
      eyebrow.textContent = isSharedSegment ? "Shared Segment" : "Private Segment";
    }

    if (isSharedSegment) {
      this.segmentSharedMetaText.textContent = isOwnedByCurrentUser
        ? "Mit Gruppen geteilt"
        : `Geteilt von ${ownerLabel}`;
      return;
    }

    this.segmentSharedMetaText.textContent = isOwnedByCurrentUser
      ? "Nur fuer dich sichtbar"
      : `Privat von ${ownerLabel}`;
  }

  updateBestEffortsScopeUi() {
    const isSharedSegment = Number(this.selectedSegment?.shareGroupCount || 0) > 0;
    this.tableView?.setScopeVisibility(!!isSharedSegment);
  }

  canEditSelectedSegment(segment = this.selectedSegment) {
    if (!segment) {
      return false;
    }

    const ownerId = segment.uid == null ? "" : String(segment.uid);
    return ownerId !== "" && ownerId === this.currentUserId;
  }

  isShareableGpsSegment(segment) {
    return !!segment
      && this.canEditSelectedSegment(segment)
      && segment.rowstate === "DB"
      && Number.isInteger(Number(segment.id))
      && Array.isArray(segment.track);
  }

  async loadShareableGroups() {
    try {
      const response = await fetch("/collaboration/groups", {
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to load groups (${response.status})`);
      }

      const result = await response.json();
      this.shareableGroups = result.data || [];
      this.renderShareGroupOptions([]);
    } catch (error) {
      console.error(error);
    }
  }

  updateShareUi() {
    const segment = this.selectedSegment;
    const isShareableGpsSegment = this.isShareableGpsSegment(segment);

    this.shareToggleButton?.classList.toggle("d-none", !isShareableGpsSegment);

    if (!isShareableGpsSegment) {
      this.shareInline?.classList.remove("is-open");
      if (this.shareStatus) {
        this.shareStatus.textContent = "";
      }
    }
  }

  toggleShareInline() {
    if (!this.isShareableGpsSegment(this.selectedSegment)) {
      return;
    }

    this.shareInline?.classList.toggle("is-open");
  }

  renderShareGroupOptions(selectedGroupIds = []) {
    if (!this.shareGroupsContainer) {
      return;
    }

    this.shareGroupsContainer.innerHTML = this.shareableGroups.map((group) => `
      <label class="segment-share-chip">
        <input type="checkbox" value="${group.id}" ${selectedGroupIds.includes(Number(group.id)) ? "checked" : ""}>
        <span>${group.name}</span>
      </label>
    `).join("");
  }

  updateShareModeUi() {
    const isGroups = this.shareModeSelect?.value === "groups";
    this.shareGroupsContainer?.classList.toggle("is-visible", isGroups);
  }

  async loadSelectedSegmentSharing() {
    const segment = this.selectedSegment;

    if (!this.isShareableGpsSegment(segment)) {
      return;
    }

    try {
      const response = await fetch(`/segments/${encodeURIComponent(segment.id)}/sharing`, {
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to load segment sharing (${response.status})`);
      }

      const result = await response.json();
      const data = result.data || { shareMode: "private", groupIds: [] };
      this.selectedSegmentSharing = data;

      if (this.shareModeSelect) {
        this.shareModeSelect.value = data.shareMode || "private";
      }

      this.renderShareGroupOptions((data.groupIds || []).map((value) => Number(value)));
      this.updateShareModeUi();

      if (this.shareStatus) {
        this.shareStatus.textContent = data.shareMode === "groups"
          ? `${(data.groupIds || []).length} Gruppe(n) aktiv`
          : "Privat";
      }
      this.updateBestEffortsScopeUi();
    } catch (error) {
      console.error(error);
      this.selectedSegmentSharing = null;
      if (this.shareStatus) {
        this.shareStatus.textContent = "Sharing konnte nicht geladen werden";
      }
      this.updateBestEffortsScopeUi();
    }
  }

  async saveSegmentSharing() {
    const segment = this.selectedSegment;

    if (!this.isShareableGpsSegment(segment)) {
      return;
    }

    const groupIds = Array.from(
      this.shareGroupsContainer?.querySelectorAll('input[type="checkbox"]:checked') || []
    ).map((input) => Number(input.value)).filter((value) => Number.isInteger(value) && value > 0);

    const payload = {
      shareMode: this.shareModeSelect?.value || "private",
      groupIds
    };

    try {
      const response = await fetch(`/segments/${encodeURIComponent(segment.id)}/sharing`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed to save segment sharing (${response.status})`);
      }

      const data = result.data || payload;
      this.selectedSegmentSharing = data;
      if (this.shareStatus) {
        this.shareStatus.textContent = data.shareMode === "groups"
          ? `${(data.groupIds || []).length} Gruppe(n) aktiv`
          : "Privat";
      }
      this.updateBestEffortsScopeUi();

      this.shareInline?.classList.remove("is-open");
    } catch (error) {
      console.error(error);
      window.alert(error.message || "Segment-Sharing konnte nicht gespeichert werden.");
    }
  }

  async deleteSelectedSegment() {
    const segment = this.selectedSegment;
    if (!segment) return;

    const label = `${segment.start?.name ?? "Start"} - ${segment.end?.name ?? "End"}`;
    const ok = await confirmModal({
      title: "Segment löschen",
      message: `Segment wirklich loeschen?\n\n${label}`,
      acceptLabel: "Segment löschen",
      cancelLabel: "Abbrechen",
      acceptClass: "btn-danger"
    });
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

    if (segment && !this.isSegmentVisibleInCurrentScope(segment)) {
      segment = null;
    }

    if (!segment) {
      segment = await MapSegment.getSegmentById(targetSegmentId);
      if (!segment) {
        if (!this.focusSegmentId) {
          this.uiState.remove("selectedSegmentId");
        }
        this.focusApplied = true;
        return;
      }

      if (!this.isSegmentVisibleInCurrentScope(segment)) {
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
