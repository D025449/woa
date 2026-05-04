import Utils from "../../shared/Utils.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";

export default class WorkoutLibraryView {

  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("dashboardNewPage.library");
    this.pageT = createTranslator("dashboardNewPage");
    this.locale = getCurrentLocale();
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.headerElement = document.getElementById(handlers.headerElementId || "files_header");
    this.searchInput = document.getElementById(handlers.searchInputId || "workout-library-search");
    this.sortSelect = document.getElementById(handlers.sortSelectId || "workout-library-sort");
    this.sortTrigger = document.getElementById("workout-library-sort-trigger");
    this.sortTriggerLabel = document.getElementById("workout-library-sort-trigger-label");
    this.sortMenu = document.getElementById("workout-library-sort-menu");
    this.loadMoreContainer = document.getElementById(handlers.loadMoreButtonId || "workout-library-load-more");
    this.loadMoreButton = this.loadMoreContainer?.querySelector("button") || null;
    this.activeFiltersElement = document.getElementById(handlers.activeFiltersId || "workout-library-active-filters");
    this.scopeMineButton = document.getElementById(handlers.scopeMineButtonId || "workout-library-scope-mine");
    this.scopeSharedButton = document.getElementById(handlers.scopeSharedButtonId || "workout-library-scope-shared");
    this.scopeAllButton = document.getElementById(handlers.scopeAllButtonId || "workout-library-scope-all");

    this.items = [];
    this.selectedWorkoutId = null;
    this.page = 1;
    this.pageSize = handlers.pageSize || 24;
    this.lastPage = 1;
    this.totalRecords = 0;
    this.ownSummary = null;
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

    this.syncSortUi();

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
        if (this.shouldWaitForScopedSearchValue(this.searchInputValue)) {
          return;
        }
        this.reload();
      }, 220);
    });

    this.sortSelect?.addEventListener("change", () => {
      this.sortValue = this.sortSelect?.value || "newest";
      this.syncSortUi();
      this.handlers.onStateChange?.(this.getState());
      this.reload();
    });

    this.sortTrigger?.addEventListener("click", () => {
      this.toggleSortMenu();
    });

    this.sortMenu?.querySelectorAll("[data-sort-option]").forEach((element) => {
      element.addEventListener("click", () => {
        const nextSort = element.getAttribute("data-sort-option") || "newest";
        this.applySortValue(nextSort);
        this.closeSortMenu();
      });
    });

    document.addEventListener("click", (event) => {
      if (!this.sortTrigger || !this.sortMenu) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (this.sortTrigger.contains(target) || this.sortMenu.contains(target)) {
        return;
      }

      this.closeSortMenu();
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

    document.querySelectorAll("[data-search-example]").forEach((element) => {
      element.addEventListener("click", () => {
        this.applySearchValue(element.getAttribute("data-search-example") || "");
      });
    });

    document.querySelectorAll("[data-search-scope]").forEach((element) => {
      element.addEventListener("click", () => {
        const scope = String(element.getAttribute("data-search-scope") || "").trim();
        if (!scope) {
          return;
        }
        this.applySearchValue(`${scope}:`);
        this.searchInput?.focus();
      });
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
    this.renderActiveFilters();
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
      throw new Error(this.t("failedLoadWorkouts", { status: response.status }));
    }

    const result = await response.json();

    if (requestId !== this.pendingRequestId) {
      return;
    }

    this.totalRecords = result.total_records || 0;
    this.lastPage = result.last_page || 1;
    this.ownSummary = result.own_summary || null;
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

    return [{ field: "__search", type: "like", value: search }];
  }

  shouldWaitForScopedSearchValue(search) {
    return /^[a-z_]+\s*(?::\s*|(?:<=|>=|=|<|>)\s*)$/i.test(String(search || "").trim());
  }

  renderHeader() {
    if (!this.headerElement) {
      return;
    }

    if (this.ownSummary) {
      const countText = this.t("workoutCount", { count: this.ownSummary.workout_count || 0 });
      const parts = [
        countText,
        this.formatAggregateHours(this.ownSummary.total_timer_time),
        this.formatDistance(this.ownSummary.total_distance, 0)
      ].filter(Boolean);

      this.headerElement.textContent = parts.join(" • ");
      return;
    }

    this.headerElement.textContent = this.t("workoutCount", { count: this.totalRecords });
  }

  renderActiveFilters() {
    if (!this.activeFiltersElement) {
      return;
    }

    const chips = [];
    const search = (this.searchInput?.value || this.searchInputValue || "").trim();
    if (search) {
      chips.push({
        type: "search",
        label: `${this.t("activeSearch")}: ${search}`
      });
    }

    if (chips.length === 0) {
      this.activeFiltersElement.hidden = true;
      this.activeFiltersElement.innerHTML = "";
      return;
    }

    this.activeFiltersElement.hidden = false;
    this.activeFiltersElement.innerHTML = `
      <span class="workout-library-active-filters__label">${this.t("activeFiltersLabel")}</span>
      ${chips.map((chip) => `
        <span class="workout-library-active-filters__chip">
          <span>${chip.label}</span>
          <button type="button" class="workout-library-active-filters__remove" data-filter-remove="${chip.type}" aria-label="${this.t("clearFilter")}">×</button>
        </span>
      `).join("")}
    `;

    this.activeFiltersElement.querySelectorAll("[data-filter-remove]").forEach((element) => {
      element.addEventListener("click", () => {
        this.clearFilterType(element.getAttribute("data-filter-remove") || "");
      });
    });
  }

  clearFilterType(type) {
    if (type === "search") {
      this.applySearchValue("");
      return;
    }

    if (type === "scope") {
      this.scopeValue = "mine";
      this.updateScopeButtons();
      this.handlers.onStateChange?.(this.getState());
      this.reload();
      return;
    }

    if (type === "sort") {
      this.applySortValue("newest");
    }
  }

  applySortValue(value) {
    this.sortValue = value || "newest";
    if (this.sortSelect) {
      this.sortSelect.value = this.sortValue;
    }
    this.syncSortUi();
    this.handlers.onStateChange?.(this.getState());
    this.reload();
  }

  applySearchValue(value) {
    this.searchInputValue = value;
    if (this.searchInput) {
      this.searchInput.value = value;
    }
    this.handlers.onStateChange?.(this.getState());
    if (this.shouldWaitForScopedSearchValue(value)) {
      this.renderActiveFilters();
      return;
    }
    this.reload();
  }

  getSortLabel(sort) {
    const labels = {
      newest: this.pageT("sortNewest"),
      uploaded: this.pageT("sortUploaded"),
      oldest: this.pageT("sortOldest"),
      distance: this.pageT("sortDistance"),
      duration: this.pageT("sortDuration"),
      power: this.pageT("sortPower"),
      np: this.pageT("sortNp")
    };
    return labels[sort] || sort;
  }

  syncSortUi() {
    const sort = this.sortSelect?.value || this.sortValue || "newest";

    if (this.sortTriggerLabel) {
      this.sortTriggerLabel.textContent = this.getSortLabel(sort);
    }

    this.sortMenu?.querySelectorAll("[data-sort-option]").forEach((element) => {
      element.classList.toggle("is-active", element.getAttribute("data-sort-option") === sort);
    });
  }

  toggleSortMenu() {
    const isOpen = !this.sortMenu?.hasAttribute("hidden");
    if (isOpen) {
      this.closeSortMenu();
      return;
    }
    this.openSortMenu();
  }

  openSortMenu() {
    if (!this.sortMenu || !this.sortTrigger) {
      return;
    }
    this.sortMenu.hidden = false;
    this.sortTrigger.classList.add("is-open");
    this.sortTrigger.setAttribute("aria-expanded", "true");
  }

  closeSortMenu() {
    if (!this.sortMenu || !this.sortTrigger) {
      return;
    }
    this.sortMenu.hidden = true;
    this.sortTrigger.classList.remove("is-open");
    this.sortTrigger.setAttribute("aria-expanded", "false");
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

  getWorkoutById(workoutId) {
    const targetId = String(workoutId);
    return this.items.find((workout) => String(workout.id) === targetId) || null;
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
          ${this.t("empty")}
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
      element.addEventListener("click", (event) => {
        if (event.target?.closest?.(".workout-library-actions-menu")) {
          return;
        }
        const workoutId = element.getAttribute("data-workout-open");
        this.handlers.onWorkoutOpen?.(workoutId);
      });
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        const workoutId = element.getAttribute("data-workout-open");
        this.handlers.onWorkoutOpen?.(workoutId);
      });
    });

    this.container.querySelectorAll(".workout-library-actions-menu").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });

    this.container.querySelectorAll(".workout-library-actions-menu__trigger").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
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

    this.container.querySelectorAll("[data-workout-export]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        const workoutId = element.getAttribute("data-workout-export");
        const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
        if (!workout?.is_owned) {
          event.preventDefault();
          return;
        }

        await this.handlers.onWorkoutExport?.(workout, element);
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
      this.shareErrors.set(workoutId, err.message || this.t("couldNotLoadSharing"));
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
      this.shareErrors.set(String(workoutId), this.t("selectAtLeastOneGroup"));
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
      this.shareErrors.set(String(workoutId), err.message || this.t("couldNotSaveSharing"));
    } finally {
      this.savingShareWorkoutId = null;
      this.render();
    }
  }

  renderWorkoutCard(workout) {
    const isSelected = String(workout.id) === this.selectedWorkoutId;
    const hasSelection = !!this.selectedWorkoutId;
    const workoutId = String(workout.id);
    const isOwned = !!workout.is_owned;
    const hasValidGps = workout.validGps ?? workout.validgps ?? false;
    const isShareOpen = this.openShareWorkoutId === workoutId;
    const isShareLoading = this.loadingShareWorkoutId === workoutId;
    const isShareSaving = this.savingShareWorkoutId === workoutId;
    const startedAt = workout.start_time ? new Date(workout.start_time) : null;
    const dayLabel = startedAt
      ? startedAt.toLocaleDateString(this.locale, { day: "2-digit", month: "short", year: "numeric" })
      : this.t("na");
    const timeLabel = startedAt
      ? startedAt.toLocaleTimeString(this.locale, { hour: "2-digit", minute: "2-digit" })
      : "";
    const shareMode = workout.sharing?.shareMode || (Number(workout.share_group_count) > 0 ? "groups" : "private");
    const shareTag = shareMode === "groups"
      ? this.t("shareTagGroups", { count: Number(workout.share_group_count) || 0 })
      : this.t("sharePrivate");
    const draft = this.getShareDraft(workoutId);
    const shareError = this.shareErrors.get(workoutId) || "";
    const tone = this.getWorkoutTone(workout);
    const dimmedClass = hasSelection && !isSelected ? " is-dimmed" : "";
    const compactStat = this.getCompactStat(workout);

    return `
      <article
        class="workout-library-card workout-library-card--${tone}${isSelected ? " is-selected" : ""}${dimmedClass}"
        data-workout-open="${workout.id}"
        role="button"
        tabindex="0"
      >
        <div class="workout-library-card__accent"></div>
        <div class="workout-library-card__head">
          <div class="workout-library-card__identity">
            <div class="workout-library-card__context">
              <span class="workout-library-card__context-chip">${dayLabel}</span>
              ${timeLabel ? `<span class="workout-library-card__context-chip">${timeLabel}</span>` : ""}
              <span class="workout-library-card__context-chip">${hasValidGps ? this.t("gps") : this.t("noGps")}</span>
              <span class="workout-library-card__context-chip">${shareTag}</span>
            </div>
            <div class="workout-library-card__title">${this.t("workoutLabel", { id: workout.id })}</div>
            <div class="workout-library-card__meta">${this.buildIdentitySummary(workout)}</div>
            ${workout.is_owned ? "" : `
              <div class="workout-library-card__owner">
                ${this.t("sharedBy", { owner: workout.owner_display_name || workout.owner_email || this.t("anotherUser") })}
              </div>
            `}
          </div>
          <div class="workout-library-card__kpi-strip">
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">${this.t("duration")}</span>
              <span class="workout-library-kpi__value">${Utils.formatDuration(workout.total_timer_time)}</span>
            </div>
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">${this.t("distance")}</span>
              <span class="workout-library-kpi__value">${this.formatDistance(workout.total_distance)}</span>
            </div>
          </div>
        </div>

        <div class="workout-library-card__body">
          <div class="workout-library-stat-row">
            <span class="workout-library-stat"><span class="workout-library-stat__label">${this.t("avgPower")}</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_power)} W</span></span>
            <span class="workout-library-stat"><span class="workout-library-stat__label">NP</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_normalized_power)} W</span></span>
            ${compactStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${compactStat.label}</span><span class="workout-library-stat__value">${compactStat.value}</span></span>` : ""}
            ${isOwned ? `
              <details class="workout-library-actions-menu">
                <summary class="workout-library-actions-menu__trigger" aria-label="${this.t("share")} / ${this.t("delete")}">
                  <span></span><span></span><span></span>
                </summary>
                <div class="workout-library-actions-menu__panel">
                  <a
                    class="workout-library-actions-menu__item workout-library-actions-menu__item--primary"
                    href="/workouts/${workout.id}/export.fit"
                    data-workout-export="${workout.id}"
                    download>
                    <span class="workout-library-actions-menu__icon" aria-hidden="true">
                      <svg viewBox="0 0 20 20">
                        <path d="M10 3.5v8.5M6.8 8.9 10 12.3l3.2-3.4M4 14.5h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                      </svg>
                    </span>
                    ${this.t("exportFit")}
                  </a>
                  <button class="workout-library-actions-menu__item workout-library-actions-menu__item--secondary" type="button" data-workout-share-toggle="${workout.id}">
                    <span class="workout-library-actions-menu__icon" aria-hidden="true">
                      <svg viewBox="0 0 20 20">
                        <path d="M7.2 10.2 12.8 6.9M7.2 9.8l5.6 3.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path>
                        <circle cx="5.4" cy="10" r="2.1" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                        <circle cx="14.8" cy="5.8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                        <circle cx="14.8" cy="14.2" r="2.1" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                      </svg>
                    </span>
                    ${this.t("share")}
                  </button>
                  <button class="workout-library-actions-menu__item workout-library-actions-menu__item--danger" type="button" data-workout-delete="${workout.id}">
                    <span class="workout-library-actions-menu__icon" aria-hidden="true">
                      <svg viewBox="0 0 20 20">
                        <path d="M6.2 6.2h7.6M8 6.2V4.8h4v1.4M7.2 6.2l.45 8.1h4.7l.45-8.1M8.7 8.1v4.5M11.3 8.1v4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                      </svg>
                    </span>
                    ${this.t("delete")}
                  </button>
                </div>
              </details>
            ` : ""}
          </div>
          ${isOwned && isShareOpen ? `
            <div class="workout-share-inline">
              <div class="workout-share-inline__row">
                <label class="form-label mb-0">${this.t("visibility")}</label>
                <select class="form-select form-select-sm" style="width: 140px;" data-workout-share-mode="${workout.id}">
                  <option value="private" ${draft.shareMode === "private" ? "selected" : ""}>${this.t("sharePrivate")}</option>
                  <option value="groups" ${draft.shareMode === "groups" ? "selected" : ""}>${this.t("shareGroups")}</option>
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
                  ${isShareLoading ? this.t("loadingSharing") : shareError || ""}
                </span>
                <button
                  class="btn btn-sm btn-primary"
                  type="button"
                  data-workout-share-save="${workout.id}"
                  ${isShareLoading || isShareSaving ? "disabled" : ""}>
                  ${isShareSaving ? this.t("saving") : this.t("apply")}
                </button>
              </div>
            </div>
          ` : ""}
        </div>
      </article>
    `;
  }

  formatDistance(value, fractionDigits = 1) {
    return Number.isFinite(value)
      ? `${(Number(value) / 1000).toFixed(fractionDigits)} km`
      : this.t("na");
  }

  formatSpeed(value) {
    return Number.isFinite(value) ? `${Number(value).toFixed(1)} km/h` : this.t("na");
  }

  formatInt(value) {
    return Number.isFinite(value) ? `${Math.round(value)}` : this.t("na");
  }

  formatAscentMeters(value) {
    if (!Number.isFinite(value)) {
      return this.t("na");
    }

    return `${Math.round(Number(value))} m`;
  }

  formatAggregateHours(value) {
    const seconds = Number(value) || 0;
    const hours = seconds / 3600;
    const formatter = new Intl.NumberFormat(this.locale || undefined, {
      minimumFractionDigits: hours >= 100 ? 0 : 1,
      maximumFractionDigits: hours >= 100 ? 0 : 1
    });

    return `${formatter.format(hours)} h`;
  }

  getCompactStat(workout) {
    if (Number.isFinite(workout.avg_heart_rate) && Number(workout.avg_heart_rate) > 0) {
      return {
        label: this.t("avgHr"),
        value: `${this.formatInt(workout.avg_heart_rate)} bpm`
      };
    }

    if (Number.isFinite(workout.total_ascent) && Number(workout.total_ascent) > 0) {
      return {
        label: "hm",
        value: this.formatAscentMeters(workout.total_ascent)
      };
    }

    if (Number.isFinite(workout.avg_speed) && Number(workout.avg_speed) > 0) {
      return {
        label: this.t("avgSpeed"),
        value: this.formatSpeed(workout.avg_speed)
      };
    }

    return null;
  }

  getWorkoutTone(workout) {
    const durationSeconds = Number(workout.total_timer_time) || 0;
    const avgPower = Number(workout.avg_power) || 0;
    const hasGps = workout.validGps ?? workout.validgps ?? false;

    if (avgPower >= 220) {
      return "power";
    }

    if (durationSeconds >= 7200) {
      return "endurance";
    }

    if (hasGps) {
      return "route";
    }

    return "basic";
  }

  buildIdentitySummary(workout) {
    const summary = [];

    if (Number.isFinite(workout.total_distance) && Number(workout.total_distance) > 0) {
      summary.push(this.formatDistance(workout.total_distance));
    }

    if (Number.isFinite(workout.avg_speed) && Number(workout.avg_speed) > 0) {
      summary.push(this.formatSpeed(workout.avg_speed));
    }

    if (!summary.length) {
      summary.push(this.t("na"));
    }

    return summary.join(" · ");
  }
}
