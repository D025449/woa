import Utils from "../../shared/Utils.js";

export default class WorkoutLibraryView {

  constructor(containerSelector, handlers = {}) {
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.headerElement = document.getElementById(handlers.headerElementId || "files_header");
    this.searchInput = document.getElementById(handlers.searchInputId || "workout-library-search");
    this.sortSelect = document.getElementById(handlers.sortSelectId || "workout-library-sort");
    this.loadMoreContainer = document.getElementById(handlers.loadMoreButtonId || "workout-library-load-more");
    this.loadMoreButton = this.loadMoreContainer?.querySelector("button") || null;
    this.scopeMineButton = document.getElementById(handlers.scopeMineButtonId || "workout-library-scope-mine");
    this.scopeSharedButton = document.getElementById(handlers.scopeSharedButtonId || "workout-library-scope-shared");
    this.scopeAllButton = document.getElementById(handlers.scopeAllButtonId || "workout-library-scope-all");

    this.items = [];
    this.selectedWorkoutId = null;
    this.page = 1;
    this.pageSize = handlers.pageSize || 24;
    this.lastPage = 1;
    this.totalRecords = 0;
    this.pendingRequestId = 0;
    this.openShareWorkoutId = null;
    this.loadingShareWorkoutId = null;
    this.savingShareWorkoutId = null;
    this.shareableGroups = [];
    this.shareDrafts = new Map();
    this.shareErrors = new Map();

    this.searchInputValue = handlers.initialSearch ?? "";
    this.sortValue = handlers.initialSort ?? "newest";
    this.scopeValue = handlers.initialScope ?? "mine";

    if (this.searchInput) {
      this.searchInput.value = this.searchInputValue;
    }

    if (this.sortSelect) {
      this.sortSelect.value = this.sortValue;
    }

    this.updateScopeButtons();

    this.registerEvents();
  }

  setShareableGroups(groups = []) {
    this.shareableGroups = Array.isArray(groups) ? groups : [];
    this.render();
  }

  registerEvents() {
    let searchTimeout;

    this.searchInput?.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.searchInputValue = this.searchInput?.value || "";
        this.handlers.onStateChange?.(this.getState());
        this.reload();
      }, 220);
    });

    this.sortSelect?.addEventListener("change", () => {
      this.sortValue = this.sortSelect?.value || "newest";
      this.handlers.onStateChange?.(this.getState());
      this.reload();
    });

    [this.scopeMineButton, this.scopeSharedButton, this.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", () => {
        this.scopeValue = button.dataset.workoutScope || "mine";
        this.updateScopeButtons();
        this.handlers.onStateChange?.(this.getState());
        this.reload();
      });
    });

    this.loadMoreButton?.addEventListener("click", async () => {
      if (this.page >= this.lastPage) {
        return;
      }

      this.page += 1;
      await this.fetchPage({ append: true });
    });
  }

  async initialize() {
    this.handlers.onStateChange?.(this.getState());
    await this.reload();
  }

  async reload() {
    this.page = 1;
    this.lastPage = 1;
    this.items = [];
    await this.fetchPage({ append: false });
  }

  async fetchPage({ append }) {
    const requestId = ++this.pendingRequestId;
    const url = this.buildUrl();

    const response = await fetch(url, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }

    if (!response.ok) {
      throw new Error(`Failed to load workouts (${response.status})`);
    }

    const result = await response.json();

    if (requestId !== this.pendingRequestId) {
      return;
    }

    this.totalRecords = result.total_records || 0;
    this.lastPage = result.last_page || 1;
    this.items = append
      ? [...this.items, ...(result.data || [])]
      : (result.data || []);

    this.renderHeader();
    this.render();
    this.updateLoadMoreButton();
  }

  buildUrl() {
    const params = new URLSearchParams();
    params.set("page", String(this.page));
    params.set("size", String(this.pageSize));
    params.set("sort", JSON.stringify(this.buildSort()));
    params.set("filter", JSON.stringify(this.buildFilters()));
    params.set("scope", this.scopeValue || "mine");
    return `/files/workouts?${params.toString()}`;
  }

  buildSort() {
    const sort = this.sortSelect?.value || this.sortValue || "newest";

    if (sort === "oldest") {
      return [{ field: "start_time", dir: "asc" }];
    }

    if (sort === "uploaded") {
      return [{ field: "uploaded_at", dir: "desc" }];
    }

    if (sort === "distance") {
      return [{ field: "total_distance", dir: "desc" }];
    }

    if (sort === "duration") {
      return [{ field: "total_timer_time", dir: "desc" }];
    }

    if (sort === "power") {
      return [{ field: "avg_power", dir: "desc" }];
    }

    if (sort === "np") {
      return [{ field: "avg_normalized_power", dir: "desc" }];
    }

    return [{ field: "start_time", dir: "desc" }];
  }

  buildFilters() {
    const search = (this.searchInput?.value || this.searchInputValue || "").trim();
    if (!search) {
      return [];
    }

    if (/^\d+$/.test(search)) {
      return [{ field: "id", type: "=", value: search }];
    }

    return [{ field: "start_time", type: "like", value: search }];
  }

  renderHeader() {
    if (!this.headerElement) {
      return;
    }

    this.headerElement.textContent = `${this.totalRecords} Workouts`;
  }

  updateLoadMoreButton() {
    if (!this.loadMoreContainer || !this.loadMoreButton) {
      return;
    }

    const hasMore = this.page < this.lastPage;
    this.loadMoreContainer.classList.toggle("d-none", !hasMore);
    this.loadMoreButton.disabled = !hasMore;
  }

  setSelectedWorkout(workoutId) {
    this.selectedWorkoutId = workoutId ? String(workoutId) : null;
    this.render();
  }

  removeWorkout(workoutId) {
    const targetId = String(workoutId);
    this.items = this.items.filter((workout) => String(workout.id) !== targetId);
    this.totalRecords = Math.max(0, this.totalRecords - 1);

    if (this.selectedWorkoutId === targetId) {
      this.selectedWorkoutId = null;
    }

    this.renderHeader();
    this.render();
  }

  setWorkoutSharing(workoutId, sharing) {
    const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
    if (!workout) {
      return;
    }

    workout.sharing = sharing;
    workout.share_group_count = Array.isArray(sharing?.groupIds) ? sharing.groupIds.length : 0;
    this.shareDrafts.set(String(workoutId), {
      shareMode: sharing?.shareMode || "private",
      groupIds: Array.isArray(sharing?.groupIds) ? [...sharing.groupIds] : []
    });
  }

  getState() {
    return {
      search: this.searchInput?.value || this.searchInputValue || "",
      sort: this.sortSelect?.value || this.sortValue || "newest",
      scope: this.scopeValue || "mine"
    };
  }

  updateScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.scopeValue === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.scopeValue === "shared");
    this.scopeAllButton?.classList.toggle("active", this.scopeValue === "all");
  }

  render() {
    if (!this.container) {
      return;
    }

    if (this.items.length === 0) {
      this.container.innerHTML = `
        <div class="workout-library-empty">
          Keine Workouts gefunden.
        </div>
      `;
      return;
    }

    this.container.innerHTML = this.items
      .map((workout) => this.renderWorkoutCard(workout))
      .join("");

    this.bindCardEvents();
  }

  bindCardEvents() {
    this.container.querySelectorAll("[data-workout-open]").forEach((element) => {
      element.addEventListener("click", () => {
        const workoutId = element.getAttribute("data-workout-open");
        this.handlers.onWorkoutOpen?.(workoutId);
      });
    });

    this.container.querySelectorAll(".workout-share-inline").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });

    this.container.querySelectorAll("[data-workout-delete]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        const workoutId = element.getAttribute("data-workout-delete");
        const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
        if (!workout) {
          return;
        }

        await this.handlers.onWorkoutDelete?.(workout);
      });
    });

    this.container.querySelectorAll("[data-workout-share-toggle]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-share-toggle"));
        await this.toggleSharePanel(workoutId);
      });
    });

    this.container.querySelectorAll("[data-workout-share-mode]").forEach((element) => {
      element.addEventListener("change", (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-share-mode"));
        const draft = this.getShareDraft(workoutId);
        draft.shareMode = element.value === "groups" ? "groups" : "private";
        if (draft.shareMode !== "groups") {
          draft.groupIds = [];
        }
        this.shareDrafts.set(workoutId, draft);
        this.shareErrors.delete(workoutId);
        this.render();
      });
    });

    this.container.querySelectorAll("[data-workout-share-group]").forEach((element) => {
      element.addEventListener("change", (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-share-group"));
        const groupId = Number(element.value);
        const draft = this.getShareDraft(workoutId);
        const nextGroupIds = new Set(draft.groupIds || []);
        if (element.checked) {
          nextGroupIds.add(groupId);
        } else {
          nextGroupIds.delete(groupId);
        }
        draft.groupIds = [...nextGroupIds];
        this.shareDrafts.set(workoutId, draft);
        this.shareErrors.delete(workoutId);
      });
    });

    this.container.querySelectorAll("[data-workout-share-save]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-share-save"));
        await this.saveSharePanel(workoutId);
      });
    });
  }

  async toggleSharePanel(workoutId) {
    const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
    if (!workout?.is_owned) {
      return;
    }

    if (this.openShareWorkoutId === workoutId) {
      this.openShareWorkoutId = null;
      this.shareErrors.delete(workoutId);
      this.render();
      return;
    }

    this.openShareWorkoutId = workoutId;
    this.shareErrors.delete(workoutId);
    this.render();

    if (!workout) {
      return;
    }

    if (workout.sharing) {
      if (!this.shareDrafts.has(workoutId)) {
        this.setWorkoutSharing(workoutId, workout.sharing);
      }
      this.render();
      return;
    }

    this.loadingShareWorkoutId = workoutId;
    this.render();

    try {
      const sharing = await this.handlers.onWorkoutShareOpen?.(workout);
      if (sharing) {
        this.setWorkoutSharing(workoutId, sharing);
      }
    } catch (err) {
      console.error(err);
      this.shareErrors.set(workoutId, err.message || "Freigabe konnte nicht geladen werden.");
    } finally {
      this.loadingShareWorkoutId = null;
      this.render();
    }
  }

  getShareDraft(workoutId) {
    return this.shareDrafts.get(String(workoutId)) || {
      shareMode: "private",
      groupIds: []
    };
  }

  async saveSharePanel(workoutId) {
    const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
    if (!workout?.is_owned) {
      return;
    }

    const draft = this.getShareDraft(workoutId);
    if (draft.shareMode === "groups" && (!Array.isArray(draft.groupIds) || draft.groupIds.length === 0)) {
      this.shareErrors.set(String(workoutId), "Bitte mindestens eine Gruppe auswaehlen.");
      this.render();
      return;
    }

    this.savingShareWorkoutId = String(workoutId);
    this.shareErrors.delete(String(workoutId));
    this.render();

    try {
      const sharing = await this.handlers.onWorkoutShareSave?.(workout, draft);
      if (sharing) {
        this.setWorkoutSharing(workoutId, sharing);
      }
      this.openShareWorkoutId = null;
    } catch (err) {
      console.error(err);
      this.shareErrors.set(String(workoutId), err.message || "Freigabe konnte nicht gespeichert werden.");
    } finally {
      this.savingShareWorkoutId = null;
      this.render();
    }
  }

  renderWorkoutCard(workout) {
    const isSelected = String(workout.id) === this.selectedWorkoutId;
    const workoutId = String(workout.id);
    const isOwned = !!workout.is_owned;
    const hasValidGps = workout.validGps ?? workout.validgps ?? false;
    const isShareOpen = this.openShareWorkoutId === workoutId;
    const isShareLoading = this.loadingShareWorkoutId === workoutId;
    const isShareSaving = this.savingShareWorkoutId === workoutId;
    const startedAt = workout.start_time ? new Date(workout.start_time) : null;
    const dayLabel = startedAt
      ? startedAt.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })
      : "–";
    const timeLabel = startedAt
      ? startedAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "";
    const shareMode = workout.sharing?.shareMode || (Number(workout.share_group_count) > 0 ? "groups" : "private");
    const shareTag = shareMode === "groups"
      ? `Shared${Number(workout.share_group_count) > 0 ? ` (${Number(workout.share_group_count)})` : ""}`
      : "Private";
    const draft = this.getShareDraft(workoutId);
    const shareError = this.shareErrors.get(workoutId) || "";

    return `
      <article
        class="workout-library-card${isSelected ? " is-selected" : ""}"
        data-workout-open="${workout.id}"
        role="button"
        tabindex="0"
      >
        <div class="workout-library-card__head">
          <div>
            <div class="workout-library-card__title">Workout #${workout.id}</div>
            <div class="workout-library-card__meta">${dayLabel}${timeLabel ? ` · ${timeLabel}` : ""}</div>
            ${workout.is_owned ? "" : `
              <div class="workout-library-card__owner">
                Von ${workout.owner_display_name || workout.owner_email || "anderem User"}
              </div>
            `}
          </div>
          <div class="workout-library-card__primary-metrics">
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">Dauer</span>
              <span class="workout-library-kpi__value">${Utils.formatDuration(workout.total_timer_time)}</span>
            </div>
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">Distanz</span>
              <span class="workout-library-kpi__value">${this.formatDistance(workout.total_distance)}</span>
            </div>
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">Ø Speed</span>
              <span class="workout-library-kpi__value">${this.formatSpeed(workout.avg_speed)}</span>
            </div>
          </div>
        </div>

        <div class="workout-library-card__body">
          <div class="workout-library-stat-row">
            <span class="workout-library-stat"><span class="workout-library-stat__label">Ø Power</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_power)} W</span></span>
            <span class="workout-library-stat"><span class="workout-library-stat__label">NP</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_normalized_power)} W</span></span>
            <span class="workout-library-stat"><span class="workout-library-stat__label">Ø HR</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_heart_rate)} bpm</span></span>
            <span class="workout-library-stat"><span class="workout-library-stat__label">hm</span><span class="workout-library-stat__value">${this.formatAscentMeters(workout.total_ascent)}</span></span>
          </div>
          <div class="workout-library-card__footer">
            <div class="workout-library-tags">
              <span class="workout-library-tag">${hasValidGps ? "GPS" : "No GPS"}</span>
              <span class="workout-library-tag">${workout.avg_power ? "Power" : "Basic"}</span>
              <span class="workout-library-tag">${shareTag}</span>
            </div>
            <div class="workout-library-actions">
              ${isOwned ? `
                <button class="btn btn-sm btn-outline-secondary" type="button" data-workout-share-toggle="${workout.id}">
                  Share
                </button>
                <button class="btn btn-sm btn-outline-danger" type="button" data-workout-delete="${workout.id}">
                  Delete
                </button>
              ` : ""}
            </div>
          </div>
          ${isOwned && isShareOpen ? `
            <div class="workout-share-inline">
              <div class="workout-share-inline__row">
                <label class="form-label mb-0">Sichtbarkeit</label>
                <select class="form-select form-select-sm" style="width: 140px;" data-workout-share-mode="${workout.id}">
                  <option value="private" ${draft.shareMode === "private" ? "selected" : ""}>Privat</option>
                  <option value="groups" ${draft.shareMode === "groups" ? "selected" : ""}>Gruppen</option>
                </select>
              </div>
              ${draft.shareMode === "groups" ? `
                <div class="workout-share-inline__groups">
                  ${this.shareableGroups.map((group) => `
                    <label class="workout-share-chip">
                      <input
                        type="checkbox"
                        value="${group.id}"
                        data-workout-share-group="${workout.id}"
                        ${draft.groupIds.includes(Number(group.id)) ? "checked" : ""}
                      >
                      <span>${group.name}</span>
                    </label>
                  `).join("")}
                </div>
              ` : ""}
              <div class="workout-share-inline__actions">
                <span class="workout-share-inline__status">
                  ${isShareLoading ? "Lade aktuelle Freigabe ..." : shareError || ""}
                </span>
                <button
                  class="btn btn-sm btn-primary"
                  type="button"
                  data-workout-share-save="${workout.id}"
                  ${isShareLoading || isShareSaving ? "disabled" : ""}>
                  ${isShareSaving ? "Speichert ..." : "Übernehmen"}
                </button>
              </div>
            </div>
          ` : ""}
        </div>
      </article>
    `;
  }

  formatDistance(value) {
    return Number.isFinite(value) ? `${Number(value).toFixed(1)} km` : "–";
  }

  formatSpeed(value) {
    return Number.isFinite(value) ? `${Number(value).toFixed(1)} km/h` : "–";
  }

  formatInt(value) {
    return Number.isFinite(value) ? `${Math.round(value)}` : "–";
  }

  formatAscentMeters(value) {
    if (!Number.isFinite(value)) {
      return "–";
    }

    return `${Math.round(Number(value) * 1000)} m`;
  }
}
