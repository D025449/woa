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

    this.items = [];
    this.selectedWorkoutId = null;
    this.page = 1;
    this.pageSize = handlers.pageSize || 24;
    this.lastPage = 1;
    this.totalRecords = 0;
    this.pendingRequestId = 0;

    this.searchInputValue = handlers.initialSearch ?? "";
    this.sortValue = handlers.initialSort ?? "newest";

    if (this.searchInput) {
      this.searchInput.value = this.searchInputValue;
    }

    if (this.sortSelect) {
      this.sortSelect.value = this.sortValue;
    }

    this.registerEvents();
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
    return `/files/workouts?${params.toString()}`;
  }

  buildSort() {
    const sort = this.sortSelect?.value || this.sortValue || "newest";

    if (sort === "oldest") {
      return [{ field: "start_time", dir: "asc" }];
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

  getState() {
    return {
      search: this.searchInput?.value || this.searchInputValue || "",
      sort: this.sortSelect?.value || this.sortValue || "newest"
    };
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
  }

  renderWorkoutCard(workout) {
    const isSelected = String(workout.id) === this.selectedWorkoutId;
    const startedAt = workout.start_time ? new Date(workout.start_time) : null;
    const dayLabel = startedAt
      ? startedAt.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })
      : "–";
    const timeLabel = startedAt
      ? startedAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "";

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
            <span class="workout-library-stat"><span class="workout-library-stat__label">hm</span><span class="workout-library-stat__value">${this.formatInt(workout.total_ascent)} m</span></span>
          </div>
          <div class="workout-library-card__footer">
            <div class="workout-library-tags">
              <span class="workout-library-tag">${workout.validGps ? "GPS" : "No GPS"}</span>
              <span class="workout-library-tag">${workout.avg_power ? "Power" : "Basic"}</span>
            </div>
            <button class="btn btn-sm btn-outline-danger" type="button" data-workout-delete="${workout.id}">
              Delete
            </button>
          </div>
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
}
