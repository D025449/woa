import { WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION } from "../../shared/SegmentAppearance.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";

export default class WorkoutLibraryView {

  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("dashboardNewPage.library");
    this.pageT = createTranslator("dashboardNewPage");
    this.locale = getCurrentLocale();
    this.numberFormatters = new Map();
    this.container = document.querySelector(containerSelector);
    this.scrollRoot = this.container?.closest?.(".workout-library-scroll") || null;
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
    this.favoriteFilterButton = document.getElementById(handlers.favoriteFilterButtonId || "workout-library-favorites-filter");
    this.workoutTypeFilter = document.getElementById(handlers.workoutTypeFilterId || "workout-library-type-filter");
    this.workoutTypeTrigger = document.getElementById("workout-library-type-trigger");
    this.workoutTypeTriggerLabel = document.getElementById("workout-library-type-trigger-label");
    this.workoutTypeMenu = document.getElementById("workout-library-type-menu");
    this.gpsFilter = document.getElementById(handlers.gpsFilterId || "workout-library-gps-filter");
    this.gpsFilterTrigger = document.getElementById("workout-library-gps-trigger");
    this.gpsFilterTriggerLabel = document.getElementById("workout-library-gps-trigger-label");
    this.gpsFilterMenu = document.getElementById("workout-library-gps-menu");
    this.selectionModeButton = document.getElementById(handlers.selectionModeButtonId || "workout-library-selection-toggle");
    this.bulkBarElement = document.getElementById(handlers.bulkBarElementId || "workout-library-bulk-bar");
    this.bulkCountElement = document.getElementById(handlers.bulkCountElementId || "workout-library-bulk-count");
    this.bulkExitButton = document.getElementById(handlers.bulkExitButtonId || "workout-library-bulk-exit");
    this.bulkDeleteButton = document.getElementById(handlers.bulkDeleteButtonId || "workout-library-bulk-delete");
    this.bulkCancelButton = document.getElementById(handlers.bulkCancelButtonId || "workout-library-bulk-cancel");
    this.bulkSelectAllVisibleButton = document.getElementById(handlers.bulkSelectAllVisibleButtonId || "workout-library-select-all-visible");
    this.bulkClearSelectionButton = document.getElementById(handlers.bulkClearSelectionButtonId || "workout-library-clear-selection");
    this.bulkPublishToggleButton = document.getElementById(handlers.bulkPublishToggleButtonId || "workout-library-bulk-publish-toggle");
    this.bulkShareInline = document.getElementById(handlers.bulkShareInlineId || "workout-library-bulk-share-inline");
    this.bulkShareModeSelect = document.getElementById(handlers.bulkShareModeSelectId || "workout-library-bulk-share-mode");
    this.bulkShareGroupsContainer = document.getElementById(handlers.bulkShareGroupsContainerId || "workout-library-bulk-share-groups");
    this.bulkShareCancelButton = document.getElementById(handlers.bulkShareCancelButtonId || "workout-library-bulk-share-cancel");
    this.bulkShareApplyButton = document.getElementById(handlers.bulkShareApplyButtonId || "workout-library-bulk-share-apply");
    this.bulkMenu = document.getElementById(handlers.bulkMenuId || "workout-library-bulk-actions-menu");
    this.toolbarDefaultElement = document.getElementById(handlers.toolbarDefaultElementId || "workout-library-toolbar-default");

    this.items = [];
    this.selectedWorkoutId = null;
    this.selectionMode = false;
    this.selectedWorkoutIds = new Set();
    this.bulkShareDraft = {
      shareMode: "private",
      groupIds: []
    };
    this.page = 1;
    this.pageSize = handlers.pageSize || 24;
    this.lastPage = 1;
    this.totalRecords = 0;
    this.resultsLoaded = false;
    this.ownSummary = null;
    this.pendingRequestId = 0;
    this.openShareWorkoutId = null;
    this.loadingShareWorkoutId = null;
    this.savingShareWorkoutId = null;
    this.shareableGroups = [];
    this.shareDrafts = new Map();
    this.shareErrors = new Map();
    this.openVisibilityWorkoutId = null;
    this.loadingVisibilityWorkoutId = null;
    this.thumbnailObserver = null;

    this.searchInputValue = handlers.initialSearch ?? "";
    this.sortValue = handlers.initialSort ?? "newest";
    this.scopeValue = handlers.initialScope ?? "mine";
    this.favoriteFilterActive = !!handlers.initialFavoriteFilterActive;
    this.workoutTypeValue = ["indoor", "road", "mountain", "unknown"].includes(handlers.initialWorkoutType)
      ? handlers.initialWorkoutType
      : "all";
    this.gpsFilterValue = ["valid", "invalid"].includes(handlers.initialGpsFilter)
      ? handlers.initialGpsFilter
      : "all";
    this.favoriteWorkoutIds = new Set((handlers.initialFavoriteWorkoutIds || []).map((value) => String(value)));

    if (this.searchInput) {
      this.searchInput.value = this.searchInputValue;
    }

    if (this.sortSelect) {
      this.sortSelect.value = this.sortValue;
    }
    if (this.workoutTypeFilter) {
      this.workoutTypeFilter.value = this.workoutTypeValue;
    }
    if (this.gpsFilter) {
      this.gpsFilter.value = this.gpsFilterValue;
    }

    this.syncWorkoutTypeUi();
    this.syncGpsFilterUi();
    this.syncSortUi();

    this.updateScopeButtons();
    this.updateFavoriteFilterButton();

    this.registerEvents();
  }

  setShareableGroups(groups = []) {
    this.shareableGroups = Array.isArray(groups) ? groups : [];
    this.renderBulkShareGroups();
    this.render();
  }

  applyState(state = {}) {
    const allowedSorts = [
      "newest",
      "oldest",
      "uploaded",
      "distance",
      "duration",
      "calories",
      "powerload",
      "power",
      "np"
    ];
    this.searchInputValue = String(state.search ?? "").slice(0, 300);
    this.sortValue = allowedSorts.includes(state.sort) ? state.sort : "newest";
    this.scopeValue = ["mine", "shared", "all"].includes(state.scope) ? state.scope : "mine";
    this.favoriteFilterActive = state.favoritesOnly === true;
    this.workoutTypeValue = ["indoor", "road", "mountain", "unknown"].includes(state.workoutType)
      ? state.workoutType
      : "all";
    this.gpsFilterValue = ["valid", "invalid"].includes(state.gpsFilter)
      ? state.gpsFilter
      : "all";

    if (this.searchInput) {
      this.searchInput.value = this.searchInputValue;
    }
    if (this.sortSelect) {
      this.sortSelect.value = this.sortValue;
    }
    if (this.workoutTypeFilter) {
      this.workoutTypeFilter.value = this.workoutTypeValue;
    }
    if (this.gpsFilter) {
      this.gpsFilter.value = this.gpsFilterValue;
    }

    this.syncSortUi();
    this.syncWorkoutTypeUi();
    this.syncGpsFilterUi();
    this.updateScopeButtons();
    this.updateFavoriteFilterButton();
    this.renderActiveFilters();
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

    this.workoutTypeFilter?.addEventListener("change", () => {
      this.applyWorkoutTypeValue(this.workoutTypeFilter?.value || "all");
    });

    this.workoutTypeTrigger?.addEventListener("click", () => {
      this.toggleWorkoutTypeMenu();
    });

    this.workoutTypeMenu?.querySelectorAll("[data-workout-type-option]").forEach((element) => {
      element.addEventListener("click", () => {
        this.applyWorkoutTypeValue(element.getAttribute("data-workout-type-option") || "all");
        this.closeWorkoutTypeMenu();
      });
    });

    this.gpsFilter?.addEventListener("change", () => {
      this.applyGpsFilterValue(this.gpsFilter?.value || "all");
    });

    this.gpsFilterTrigger?.addEventListener("click", () => {
      this.toggleGpsFilterMenu();
    });

    this.gpsFilterMenu?.querySelectorAll("[data-gps-filter-option]").forEach((element) => {
      element.addEventListener("click", () => {
        this.applyGpsFilterValue(element.getAttribute("data-gps-filter-option") || "all");
        this.closeGpsFilterMenu();
      });
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
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!this.sortTrigger?.contains(target) && !this.sortMenu?.contains(target)) {
        this.closeSortMenu();
      }

      if (!this.workoutTypeTrigger?.contains(target) && !this.workoutTypeMenu?.contains(target)) {
        this.closeWorkoutTypeMenu();
      }

      if (!this.gpsFilterTrigger?.contains(target) && !this.gpsFilterMenu?.contains(target)) {
        this.closeGpsFilterMenu();
      }

      if (
        this.openVisibilityWorkoutId &&
        !event.target?.closest?.("[data-workout-visibility-toggle]") &&
        !event.target?.closest?.("[data-workout-visibility-popover]")
      ) {
        this.closeVisibilityPopover();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (this.openVisibilityWorkoutId || this.loadingVisibilityWorkoutId) {
        this.closeVisibilityPopover();
      }
    });

    [this.scopeMineButton, this.scopeSharedButton, this.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", () => {
        this.scopeValue = button.dataset.workoutScope || "mine";
        this.updateScopeButtons();
        this.handlers.onStateChange?.(this.getState());
        this.reload();
      });
    });

    this.favoriteFilterButton?.addEventListener("click", () => {
      this.favoriteFilterActive = !this.favoriteFilterActive;
      this.updateFavoriteFilterButton();
      this.handlers.onStateChange?.(this.getState());
      this.renderActiveFilters();
      this.reload();
    });

    this.selectionModeButton?.addEventListener("click", () => {
      this.toggleSelectionMode();
    });

    this.bulkCancelButton?.addEventListener("click", () => {
      this.setSelectionMode(false);
    });

    this.bulkExitButton?.addEventListener("click", () => {
      this.setSelectionMode(false);
    });

    this.bulkSelectAllVisibleButton?.addEventListener("click", () => {
      this.selectAllVisibleOwned();
    });

    this.bulkClearSelectionButton?.addEventListener("click", () => {
      this.bulkMenu?.removeAttribute("open");
      this.clearSelection();
    });

    this.bulkDeleteButton?.addEventListener("click", async () => {
      await this.handlers.onBulkDelete?.(this.getSelectedOwnedWorkouts());
    });

    this.bulkPublishToggleButton?.addEventListener("click", () => {
      this.toggleBulkSharePanel();
    });

    this.bulkShareModeSelect?.addEventListener("change", () => {
      this.bulkShareDraft.shareMode = this.bulkShareModeSelect.value === "groups" ? "groups" : "private";
      if (this.bulkShareDraft.shareMode !== "groups") {
        this.bulkShareDraft.groupIds = [];
      }
      this.renderBulkShareGroups();
    });

    this.bulkShareCancelButton?.addEventListener("click", () => {
      this.closeBulkSharePanel();
    });

    this.bulkShareApplyButton?.addEventListener("click", async () => {
      await this.handlers.onBulkPublish?.(this.getSelectedOwnedWorkouts(), {
        shareMode: this.bulkShareDraft.shareMode,
        groupIds: [...this.bulkShareDraft.groupIds]
      });
      this.closeBulkSharePanel();
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
    this.resultsLoaded = false;
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
    this.resultsLoaded = true;
    this.lastPage = result.last_page || 1;
    this.ownSummary = result.own_summary || null;
    this.favoriteWorkoutIds = new Set(
      (result.favorite_workout_ids || []).map((value) => String(value))
    );
    this.items = append
      ? [...this.items, ...(result.data || [])]
      : (result.data || []);

    this.handlers.onFavoriteIdsChange?.([...this.favoriteWorkoutIds]);

    this.renderHeader();
    this.renderActiveFilters();
    this.render();
    this.updateLoadMoreButton();
    this.handlers.onRendered?.({
      append,
      totalRecords: this.totalRecords
    });
  }

  buildUrl() {
    const params = new URLSearchParams();
    params.set("page", String(this.page));
    params.set("size", String(this.pageSize));
    params.set("sort", JSON.stringify(this.buildSort()));
    params.set("filter", JSON.stringify(this.buildFilters()));
    params.set("scope", this.scopeValue || "mine");
    params.set("favoritesOnly", this.favoriteFilterActive ? "1" : "0");
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

    if (sort === "calories") {
      return [{ field: "total_calories", dir: "desc" }];
    }

    if (sort === "powerload") {
      return [{ field: "total_work", dir: "desc" }];
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
    const filters = search ? [{ field: "__search", type: "like", value: search }] : [];
    if (["indoor", "road", "mountain", "unknown"].includes(this.workoutTypeValue)) {
      filters.push({ field: "workout_type", type: "=", value: this.workoutTypeValue });
    }
    if (["valid", "invalid"].includes(this.gpsFilterValue)) {
      filters.push({
        field: "validgps",
        type: "=",
        value: this.gpsFilterValue === "valid"
      });
    }
    return filters;
  }

  shouldWaitForScopedSearchValue(search) {
    return /^[a-z_]+\s*(?::\s*|(?:<=|>=|=|<|>)\s*)$/i.test(String(search || "").trim());
  }

  renderHeader() {
    if (!this.headerElement) {
      return;
    }

    if (this.ownSummary) {
      const countText = this.t("workoutCount", {
        count: this.formatNumber(this.ownSummary.workout_count || 0, 0)
      });
      const parts = [
        countText,
        this.formatAggregateHours(this.ownSummary.total_timer_time),
        this.formatDistance(this.ownSummary.total_distance, 0)
      ].filter(Boolean);

      this.headerElement.textContent = parts.join(" • ");
      return;
    }

    this.headerElement.textContent = this.t("workoutCount", {
      count: this.formatNumber(this.totalRecords, 0)
    });
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

    if (this.favoriteFilterActive) {
      chips.push({
        type: "favorites",
        label: this.pageT("favoriteFilterLabel")
      });
    }

    if (this.workoutTypeValue !== "all") {
      chips.push({
        type: "workoutType",
        label: this.pageT(`workoutType${this.workoutTypeValue.charAt(0).toUpperCase()}${this.workoutTypeValue.slice(1)}`)
      });
    }

    if (this.gpsFilterValue !== "all") {
      chips.push({
        type: "gpsFilter",
        label: this.getGpsFilterLabel(this.gpsFilterValue)
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
      ${this.resultsLoaded ? `
        <span class="workout-library-active-filters__result" aria-live="polite">
          ${this.t("resultCount", { count: this.formatNumber(this.totalRecords, 0) })}
        </span>
      ` : ""}
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

    if (type === "favorites") {
      this.favoriteFilterActive = false;
      this.updateFavoriteFilterButton();
      this.handlers.onStateChange?.(this.getState());
      this.renderActiveFilters();
      this.reload();
      return;
    }

    if (type === "workoutType") {
      this.applyWorkoutTypeValue("all");
      return;
    }

    if (type === "gpsFilter") {
      this.applyGpsFilterValue("all");
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

  applyWorkoutTypeValue(value) {
    this.workoutTypeValue = ["indoor", "road", "mountain", "unknown"].includes(value)
      ? value
      : "all";
    if (this.workoutTypeFilter) {
      this.workoutTypeFilter.value = this.workoutTypeValue;
    }
    this.syncWorkoutTypeUi();
    this.handlers.onStateChange?.(this.getState());
    this.reload();
  }

  getWorkoutTypeLabel(type) {
    const labels = {
      all: this.pageT("workoutTypeAll"),
      indoor: this.pageT("workoutTypeIndoor"),
      road: this.pageT("workoutTypeRoad"),
      mountain: this.pageT("workoutTypeMountain"),
      unknown: this.pageT("workoutTypeUnknown")
    };
    return labels[type] || labels.all;
  }

  syncWorkoutTypeUi() {
    const label = this.getWorkoutTypeLabel(this.workoutTypeValue);
    const accessibleLabel = `${this.pageT("workoutTypeFilterLabel")}: ${label}`;

    if (this.workoutTypeTriggerLabel) {
      this.workoutTypeTriggerLabel.textContent = label;
    }
    if (this.workoutTypeTrigger) {
      this.workoutTypeTrigger.title = accessibleLabel;
      this.workoutTypeTrigger.setAttribute("aria-label", accessibleLabel);
      this.workoutTypeTrigger.classList.toggle("is-active", this.workoutTypeValue !== "all");
    }
    this.workoutTypeMenu?.querySelectorAll("[data-workout-type-option]").forEach((element) => {
      element.classList.toggle(
        "is-active",
        element.getAttribute("data-workout-type-option") === this.workoutTypeValue
      );
    });
  }

  toggleWorkoutTypeMenu() {
    if (!this.workoutTypeMenu?.hidden) {
      this.closeWorkoutTypeMenu();
      return;
    }
    this.openWorkoutTypeMenu();
  }

  openWorkoutTypeMenu() {
    if (!this.workoutTypeMenu || !this.workoutTypeTrigger) {
      return;
    }
    this.closeSortMenu();
    this.closeGpsFilterMenu();
    this.workoutTypeMenu.hidden = false;
    this.workoutTypeTrigger.classList.add("is-open");
    this.workoutTypeTrigger.setAttribute("aria-expanded", "true");
  }

  closeWorkoutTypeMenu() {
    if (!this.workoutTypeMenu || !this.workoutTypeTrigger) {
      return;
    }
    this.workoutTypeMenu.hidden = true;
    this.workoutTypeTrigger.classList.remove("is-open");
    this.workoutTypeTrigger.setAttribute("aria-expanded", "false");
  }

  applyGpsFilterValue(value) {
    this.gpsFilterValue = ["valid", "invalid"].includes(value) ? value : "all";
    if (this.gpsFilter) {
      this.gpsFilter.value = this.gpsFilterValue;
    }
    this.syncGpsFilterUi();
    this.handlers.onStateChange?.(this.getState());
    this.reload();
  }

  getGpsFilterLabel(value) {
    const labels = {
      all: this.pageT("gpsFilterAll"),
      valid: this.pageT("gpsFilterValid"),
      invalid: this.pageT("gpsFilterInvalid")
    };
    return labels[value] || labels.all;
  }

  syncGpsFilterUi() {
    const label = this.getGpsFilterLabel(this.gpsFilterValue);
    const accessibleLabel = `${this.pageT("gpsFilterLabel")}: ${label}`;

    if (this.gpsFilterTriggerLabel) {
      this.gpsFilterTriggerLabel.textContent = label;
    }
    if (this.gpsFilterTrigger) {
      this.gpsFilterTrigger.title = accessibleLabel;
      this.gpsFilterTrigger.setAttribute("aria-label", accessibleLabel);
      this.gpsFilterTrigger.classList.toggle("is-active", this.gpsFilterValue !== "all");
    }
    this.gpsFilterMenu?.querySelectorAll("[data-gps-filter-option]").forEach((element) => {
      element.classList.toggle(
        "is-active",
        element.getAttribute("data-gps-filter-option") === this.gpsFilterValue
      );
    });
  }

  toggleGpsFilterMenu() {
    if (!this.gpsFilterMenu?.hidden) {
      this.closeGpsFilterMenu();
      return;
    }
    this.openGpsFilterMenu();
  }

  openGpsFilterMenu() {
    if (!this.gpsFilterMenu || !this.gpsFilterTrigger) {
      return;
    }
    this.closeWorkoutTypeMenu();
    this.closeSortMenu();
    this.gpsFilterMenu.hidden = false;
    this.gpsFilterTrigger.classList.add("is-open");
    this.gpsFilterTrigger.setAttribute("aria-expanded", "true");
  }

  closeGpsFilterMenu() {
    if (!this.gpsFilterMenu || !this.gpsFilterTrigger) {
      return;
    }
    this.gpsFilterMenu.hidden = true;
    this.gpsFilterTrigger.classList.remove("is-open");
    this.gpsFilterTrigger.setAttribute("aria-expanded", "false");
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
      calories: this.pageT("sortCalories"),
      powerload: this.pageT("sortPowerload"),
      power: this.pageT("sortPower"),
      np: this.pageT("sortNp")
    };
    return labels[sort] || sort;
  }

  syncSortUi() {
    const sort = this.sortSelect?.value || this.sortValue || "newest";
    const label = this.getSortLabel(sort);

    if (this.sortTriggerLabel) {
      this.sortTriggerLabel.textContent = label;
    }

    if (this.sortTrigger) {
      this.sortTrigger.title = label;
      this.sortTrigger.setAttribute("aria-label", label);
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
    this.closeWorkoutTypeMenu();
    this.closeGpsFilterMenu();
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

  closeAllOpenCardShares() {
    if (!this.openShareWorkoutId && !this.loadingShareWorkoutId && !this.savingShareWorkoutId) {
      return false;
    }

    this.openShareWorkoutId = null;
    this.loadingShareWorkoutId = null;
    this.savingShareWorkoutId = null;
    this.shareErrors.clear();
    this.render();
    return true;
  }

  closeVisibilityPopover() {
    if (!this.openVisibilityWorkoutId && !this.loadingVisibilityWorkoutId) {
      return false;
    }

    this.openVisibilityWorkoutId = null;
    this.loadingVisibilityWorkoutId = null;
    this.render();
    return true;
  }

  handleEscape() {
    if (this.closeVisibilityPopover()) {
      return true;
    }

    if (this.bulkShareInline && !this.bulkShareInline.classList.contains("d-none")) {
      this.closeBulkSharePanel();
      return true;
    }

    if (this.bulkMenu?.open) {
      this.bulkMenu.removeAttribute("open");
      return true;
    }

    if (this.selectionMode) {
      this.setSelectionMode(false);
      return true;
    }

    if (this.closeAllOpenCardShares()) {
      return true;
    }

    if (this.sortMenu && !this.sortMenu.hidden) {
      this.closeSortMenu();
      return true;
    }

    if (this.workoutTypeMenu && !this.workoutTypeMenu.hidden) {
      this.closeWorkoutTypeMenu();
      return true;
    }

    if (this.gpsFilterMenu && !this.gpsFilterMenu.hidden) {
      this.closeGpsFilterMenu();
      return true;
    }

    return false;
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

  setWorkoutFavoriteState(workoutId, isFavorite) {
    const key = String(workoutId);
    const workout = this.items.find((entry) => String(entry.id) === key);
    if (workout) {
      workout.is_favorite = !!isFavorite;
    }
    if (isFavorite) {
      this.favoriteWorkoutIds.add(key);
    } else {
      this.favoriteWorkoutIds.delete(key);
    }
    this.handlers.onFavoriteIdsChange?.([...this.favoriteWorkoutIds]);
  }

  removeWorkout(workoutId) {
    const targetId = String(workoutId);
    const removedWorkout = this.items.find((workout) => String(workout.id) === targetId) || null;
    this.items = this.items.filter((workout) => String(workout.id) !== targetId);
    this.totalRecords = Math.max(0, this.totalRecords - 1);

    if (removedWorkout?.is_owned && this.ownSummary) {
      this.ownSummary = {
        ...this.ownSummary,
        workout_count: Math.max(0, Number(this.ownSummary.workout_count || 0) - 1),
        total_timer_time: Math.max(
          0,
          Number(this.ownSummary.total_timer_time || 0) - Number(removedWorkout.total_timer_time || 0)
        ),
        total_distance: Math.max(
          0,
          Number(this.ownSummary.total_distance || 0) - Number(removedWorkout.total_distance || 0)
        )
      };
    }

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

  updateWorkoutFields(workoutId, fields = {}) {
    const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
    if (!workout || !fields || typeof fields !== "object") {
      return;
    }

    Object.assign(workout, fields);
    this.render();
  }

  getState() {
    return {
      search: this.searchInput?.value || this.searchInputValue || "",
      sort: this.sortSelect?.value || this.sortValue || "newest",
      scope: this.scopeValue || "mine",
      favoritesOnly: this.favoriteFilterActive,
      workoutType: this.workoutTypeValue,
      gpsFilter: this.gpsFilterValue
    };
  }

  updateScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.scopeValue === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.scopeValue === "shared");
    this.scopeAllButton?.classList.toggle("active", this.scopeValue === "all");
  }

  updateFavoriteFilterButton() {
    this.favoriteFilterButton?.setAttribute("aria-pressed", this.favoriteFilterActive ? "true" : "false");
  }

  getRenderableItems() {
    return this.items;
  }

  render() {
    if (!this.container) {
      return;
    }

    this.disconnectThumbnailObserver();

    const renderableItems = this.getRenderableItems();

    if (renderableItems.length === 0) {
      const emptyState = this.buildEmptyState();
      this.container.innerHTML = `
        <div class="workout-library-empty">
          <div class="workout-library-empty__title">${emptyState.title}</div>
          <div class="workout-library-empty__copy">${emptyState.copy}</div>
        </div>
      `;
      return;
    }

    this.container.innerHTML = renderableItems
      .map((workout) => this.renderWorkoutCard(workout))
      .join("");

    this.bindCardEvents();
    this.bindThumbnailLazyLoad();
    this.updateBulkUi();
  }

  disconnectThumbnailObserver() {
    if (this.thumbnailObserver) {
      this.thumbnailObserver.disconnect();
      this.thumbnailObserver = null;
    }
  }

  bindThumbnailLazyLoad() {
    const images = Array.from(this.container?.querySelectorAll?.("[data-thumb-src]") || []);
    if (images.length === 0) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      images.forEach((image) => this.loadThumbnailImage(image));
      return;
    }

    this.thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        this.loadThumbnailImage(entry.target);
        this.thumbnailObserver?.unobserve(entry.target);
      });
    }, {
      root: this.scrollRoot || null,
      rootMargin: "200px 0px",
      threshold: 0.01
    });

    images.forEach((image) => {
      this.thumbnailObserver?.observe(image);
    });

    requestAnimationFrame(() => {
      this.loadVisibleThumbnailImages(images);
    });
  }

  loadThumbnailImage(image) {
    if (!(image instanceof HTMLImageElement)) {
      return;
    }

    const src = image.dataset.thumbSrc;
    if (!src || image.getAttribute("src")) {
      return;
    }

    image.setAttribute("src", src);
  }

  loadVisibleThumbnailImages(images = []) {
    const rootRect = this.scrollRoot?.getBoundingClientRect?.() || {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight
    };

    images.forEach((image) => {
      if (!(image instanceof HTMLImageElement)) {
        return;
      }

      const rect = image.getBoundingClientRect();
      const intersects =
        rect.bottom >= (rootRect.top - 200) &&
        rect.top <= (rootRect.bottom + 200) &&
        rect.right >= rootRect.left &&
        rect.left <= rootRect.right;

      if (intersects) {
        this.loadThumbnailImage(image);
        this.thumbnailObserver?.unobserve(image);
      }
    });
  }

  bindCardEvents() {
    this.container.querySelectorAll("[data-workout-open]").forEach((element) => {
      element.addEventListener("click", (event) => {
        if (event.target?.closest?.(".workout-library-actions-menu")) {
          return;
        }
        if (this.selectionMode) {
          const workoutId = element.getAttribute("data-workout-open");
          this.toggleWorkoutSelection(workoutId);
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
        if (this.selectionMode) {
          this.toggleWorkoutSelection(workoutId);
          return;
        }
        this.handlers.onWorkoutOpen?.(workoutId);
      });
    });

    this.container.querySelectorAll("[data-workout-select]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      element.addEventListener("change", () => {
        this.toggleWorkoutSelection(element.getAttribute("data-workout-select"), element.checked);
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

    this.container.querySelectorAll("[data-workout-favorite-toggle]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-favorite-toggle") || "");
        if (!workoutId) {
          return;
        }
        this.toggleFavoriteWorkout(workoutId);
      });
    });

    this.container.querySelectorAll("[data-workout-visibility-toggle]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.toggleVisibilityPopover(element.getAttribute("data-workout-visibility-toggle"));
      });
    });

    this.container.querySelectorAll("[data-workout-visibility-popover]").forEach((element) => {
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

    this.container.querySelectorAll("[data-workout-similarity-classify]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        const workoutId = String(element.getAttribute("data-workout-similarity-classify") || "");
        const workout = this.items.find((entry) => String(entry.id) === workoutId);
        if (!workout) {
          return;
        }
        await this.handlers.onWorkoutSimilarityClassify?.(workout);
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
      ? startedAt.toLocaleDateString(this.locale, { dateStyle: "short" })
      : this.t("na");
    const shareMode = workout.sharing?.shareMode || (Number(workout.share_group_count) > 0 ? "groups" : "private");
    const shareTag = shareMode === "groups"
      ? this.t("shareTagGroups", { count: Number(workout.share_group_count) || 0 })
      : this.t("sharePrivate");
    const isShared = shareMode === "groups";
    const isVisibilityOpen = this.openVisibilityWorkoutId === workoutId;
    const isVisibilityLoading = this.loadingVisibilityWorkoutId === workoutId;
    const visibilityGroups = isShared ? this.getSharingGroupNames(workout.sharing) : [];
    const draft = this.getShareDraft(workoutId);
    const shareError = this.shareErrors.get(workoutId) || "";
    const tone = this.getWorkoutTone(workout);
    const dimmedClass = hasSelection && !isSelected ? " is-dimmed" : "";
    const heartRateStat = Number.isFinite(workout.avg_heart_rate) && Number(workout.avg_heart_rate) > 0
      ? {
          label: "HR",
          value: `${this.formatInt(workout.avg_heart_rate)} bpm`
        }
      : null;
    const ascentStat = Number.isFinite(workout.total_ascent) && Number(workout.total_ascent) > 0
      ? {
          label: "hm",
          value: this.formatAscentMeters(workout.total_ascent)
        }
      : null;
    const speedStat = Number.isFinite(workout.avg_speed) && Number(workout.avg_speed) > 0
      ? {
          label: "SP",
          value: this.formatSpeed(workout.avg_speed)
        }
      : null;
    const energyStat = Number.isFinite(workout.total_calories) && Number(workout.total_calories) > 0
      ? {
          label: "EN",
          value: `${this.formatInt(workout.total_calories)} kcal`
        }
      : null;
    const powerLoadStat = Number.isFinite(workout.total_work) && Number(workout.total_work) > 0
      ? {
          label: "PL",
          value: `${this.formatInt(workout.total_work)} PTS`
        }
      : null;
    const isFavorite = !!workout.is_favorite;
    const isSelectable = this.selectionMode && isOwned;
    const isSelectedForBulk = this.selectedWorkoutIds.has(workoutId);
    const workoutType = ["indoor", "road", "mountain", "unknown"].includes(workout.workout_type)
      ? workout.workout_type
      : "unknown";
    const workoutTypeLabel = this.pageT(
      `workoutType${workoutType.charAt(0).toUpperCase()}${workoutType.slice(1)}`
    );

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
              ${isSelectable ? `<label class="workout-library-card__select"><input type="checkbox" data-workout-select="${workoutId}" ${isSelectedForBulk ? "checked" : ""}></label>` : ""}
              <span class="workout-library-card__context-chip">${dayLabel}</span>
              <span class="workout-library-card__context-chip">${hasValidGps ? this.t("gps") : this.t("noGps")}</span>
              <span class="workout-library-card__context-chip">${workoutTypeLabel}</span>
              ${isShared ? `
                <button class="workout-library-card__context-chip workout-library-card__context-chip--button" type="button" data-workout-visibility-toggle="${workoutId}">
                  ${shareTag}
                </button>
                ${isVisibilityOpen ? `
                  <div class="workout-library-visibility-popover" data-workout-visibility-popover="${workoutId}">
                    ${isVisibilityLoading ? `
                      <div class="workout-library-visibility-popover__empty">${this.t("loadingSharing")}</div>
                    ` : visibilityGroups.length ? `
                      <div class="workout-library-visibility-popover__list">
                        ${visibilityGroups.map((groupName) => `<span class="workout-library-visibility-popover__item">${this.escapeHtml(groupName)}</span>`).join("")}
                      </div>
                    ` : `
                      <div class="workout-library-visibility-popover__empty">${this.t("shareGroups")}</div>
                    `}
                  </div>
                ` : ""}
              ` : `
                <span class="workout-library-card__context-chip">${shareTag}</span>
              `}
              <button class="workout-library-card__favorite${isFavorite ? " is-active" : ""}" type="button" data-workout-favorite-toggle="${workoutId}" aria-label="${this.t("favoriteToggle")}">★</button>
            </div>
            <div class="workout-library-card__title">${this.t("workoutLabel", { id: workout.id })}</div>
            ${workout.is_owned ? "" : `
              <div class="workout-library-card__owner">
                ${this.t("sharedBy", { owner: workout.owner_display_name || workout.owner_email || this.t("anotherUser") })}
              </div>
            `}
          </div>
          <div class="workout-library-card__kpi-strip">
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">${this.t("durationShort")}</span>
              <span class="workout-library-kpi__value">${this.formatCardDuration(workout.total_timer_time)}</span>
            </div>
            <div class="workout-library-kpi">
              <span class="workout-library-kpi__label">${this.t("distanceShort")}</span>
              <span class="workout-library-kpi__value">${this.formatCardDistance(workout.total_distance)}</span>
            </div>
          </div>
        </div>

        <div class="workout-library-card__body">
          <div class="workout-library-card__body-main">
            <div class="workout-library-card__thumb-shell${workout.has_thumbnail ? " has-image" : ""}">
              ${workout.has_thumbnail ? `
                <img
                  class="workout-library-card__thumb-image"
                  data-thumb-src="/workouts/${workout.id}/thumbnail?v=${encodeURIComponent(workout.thumbnail_updated_at || workout.uploaded_at || "")}&style=${WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION}"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                <div class="workout-library-card__thumb-placeholder" style="display:none;">${hasValidGps ? "GPS" : "DATA"}</div>
              ` : `
                <div class="workout-library-card__thumb-placeholder">${hasValidGps ? "GPS" : "DATA"}</div>
              `}
            </div>
            <div class="workout-library-card__body-copy">
              <div class="workout-library-card__body-copy-group">
                <span class="workout-library-stat"><span class="workout-library-stat__label">PW</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_power)} W</span></span>
                <span class="workout-library-stat"><span class="workout-library-stat__label">NP</span><span class="workout-library-stat__value">${this.formatInt(workout.avg_normalized_power)} W</span></span>
                ${heartRateStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${heartRateStat.label}</span><span class="workout-library-stat__value">${heartRateStat.value}</span></span>` : ""}
              </div>
              <div class="workout-library-card__body-copy-group">
                ${ascentStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${ascentStat.label}</span><span class="workout-library-stat__value">${ascentStat.value}</span></span>` : ""}
                ${speedStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${speedStat.label}</span><span class="workout-library-stat__value">${speedStat.value}</span></span>` : ""}
                ${energyStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${energyStat.label}</span><span class="workout-library-stat__value">${energyStat.value}</span></span>` : ""}
                ${powerLoadStat ? `<span class="workout-library-stat"><span class="workout-library-stat__label">${powerLoadStat.label}</span><span class="workout-library-stat__value">${powerLoadStat.value}</span></span>` : ""}
              </div>
              ${isOwned ? `
                <details class="workout-library-actions-menu workout-library-actions-menu--inline">
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
                    ${hasValidGps ? `
                      <button class="workout-library-actions-menu__item workout-library-actions-menu__item--secondary" type="button" data-workout-similarity-classify="${workout.id}">
                        <span class="workout-library-actions-menu__icon" aria-hidden="true">
                          <svg viewBox="0 0 20 20">
                            <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                            <circle cx="14" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                            <circle cx="10" cy="14" r="2" fill="none" stroke="currentColor" stroke-width="1.7"></circle>
                            <path d="M7.8 7.1L8.9 12.1M12.2 7.1L11.1 12.1M7.8 6H12.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                          </svg>
                        </span>
                        ${this.t("classifySimilar")}
                      </button>
                    ` : ""}
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
    const meters = Number(value);
    return Number.isFinite(meters)
      ? `${this.formatNumber(meters / 1000, fractionDigits)} km`
      : this.t("na");
  }

  formatCardDuration(value) {
    const totalMinutes = Math.floor(Number(value) / 60);
    if (!Number.isFinite(totalMinutes) || totalMinutes < 0) {
      return this.t("na");
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}`;
  }

  formatCardDistance(value) {
    const meters = Number(value);
    return Number.isFinite(meters)
      ? this.formatNumber(Math.floor(meters / 1000), 0)
      : this.t("na");
  }

  formatNumber(value, fractionDigits = 0) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.t("na");
    }

    const digits = Math.max(0, Math.floor(Number(fractionDigits) || 0));
    const cacheKey = `${this.locale || "default"}:${digits}`;
    if (!this.numberFormatters.has(cacheKey)) {
      this.numberFormatters.set(cacheKey, new Intl.NumberFormat(this.locale || undefined, {
        useGrouping: true,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }));
    }

    return this.numberFormatters.get(cacheKey).format(numericValue);
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  getSharingGroupNames(sharing) {
    const ids = Array.isArray(sharing?.groupIds) ? sharing.groupIds.map((value) => Number(value)) : [];
    if (!ids.length) {
      return [];
    }

    return ids.map((groupId) => {
      const group = this.shareableGroups.find((entry) => Number(entry.id) === Number(groupId));
      return group?.name || `#${groupId}`;
    });
  }

  async toggleVisibilityPopover(workoutId) {
    const targetId = String(workoutId || "");
    const workout = this.items.find((entry) => String(entry.id) === targetId);
    if (!workout) {
      return;
    }

    const shareMode = workout.sharing?.shareMode || (Number(workout.share_group_count) > 0 ? "groups" : "private");
    if (shareMode !== "groups") {
      return;
    }

    if (this.openVisibilityWorkoutId === targetId) {
      this.closeVisibilityPopover();
      return;
    }

    this.openVisibilityWorkoutId = targetId;
    this.render();

    if (Array.isArray(workout.sharing?.groupIds) && workout.sharing.groupIds.length) {
      return;
    }

    this.loadingVisibilityWorkoutId = targetId;
    this.render();

    try {
      const sharing = await this.handlers.onWorkoutShareOpen?.(workout);
      if (sharing) {
        this.setWorkoutSharing(targetId, sharing);
      }
    } catch (err) {
      console.error(err);
    } finally {
      this.loadingVisibilityWorkoutId = null;
      if (this.openVisibilityWorkoutId === targetId) {
        this.render();
      }
    }
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
    return `${this.formatNumber(hours, hours >= 100 ? 0 : 1)} h`;
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

    if (Number.isFinite(workout.total_ascent) && Number(workout.total_ascent) > 0) {
      summary.push(this.formatAscentMeters(workout.total_ascent));
    }

    if (Number.isFinite(workout.avg_speed) && Number(workout.avg_speed) > 0) {
      summary.push(this.formatSpeed(workout.avg_speed));
    }

    if (!summary.length) {
      summary.push(this.t("na"));
    }

    return summary.join(" · ");
  }

  async toggleFavoriteWorkout(workoutId) {
    const key = String(workoutId);
    const workout = this.items.find((entry) => String(entry.id) === key);
    const wasActive = workout ? !!workout.is_favorite : this.favoriteWorkoutIds.has(key);
    const isActive = !wasActive;

    if (isActive) {
      this.favoriteWorkoutIds = new Set([key, ...this.favoriteWorkoutIds]);
    } else {
      this.favoriteWorkoutIds.delete(key);
    }
    if (workout) {
      workout.is_favorite = isActive;
    }

    this.render();

    try {
      await this.handlers.onFavoriteChange?.({
        workoutId: key,
        isFavorite: isActive
      });
      this.handlers.onFavoriteIdsChange?.([...this.favoriteWorkoutIds]);
      this.handlers.onFavoriteToggle?.({
        workoutId: key,
        isFavorite: isActive
      });
      if (this.favoriteFilterActive && !isActive) {
        await this.reload();
      }
    } catch (err) {
      if (wasActive) {
        this.favoriteWorkoutIds.add(key);
      } else {
        this.favoriteWorkoutIds.delete(key);
      }
      if (workout) {
        workout.is_favorite = wasActive;
      }
      this.handlers.onFavoriteIdsChange?.([...this.favoriteWorkoutIds]);
      this.render();
      this.handlers.onFavoriteError?.(err);
    }
  }

  buildEmptyState() {
    if (this.favoriteFilterActive) {
      return {
        title: this.pageT("emptyFavoritesTitle"),
        copy: this.pageT("emptyFavoritesCopy")
      };
    }

    const search = (this.searchInput?.value || this.searchInputValue || "").trim();
    if (search) {
      return {
        title: this.pageT("emptySearchTitle"),
        copy: this.pageT("emptySearchCopy", { search })
      };
    }

    if (this.scopeValue === "shared") {
      return {
        title: this.pageT("emptySharedTitle"),
        copy: this.pageT("emptySharedCopy")
      };
    }

    if (this.scopeValue === "all") {
      return {
        title: this.pageT("emptyAllTitle"),
        copy: this.pageT("emptyAllCopy")
      };
    }

    return {
      title: this.pageT("emptyDefaultTitle"),
      copy: this.pageT("emptyDefaultCopy")
    };
  }

  setSelectionMode(isActive) {
    this.selectionMode = !!isActive;
    if (!this.selectionMode) {
      this.selectedWorkoutIds.clear();
      this.closeBulkSharePanel();
    }
    this.bulkMenu?.removeAttribute("open");
    this.updateBulkUi();
    this.render();
  }

  toggleSelectionMode() {
    this.setSelectionMode(!this.selectionMode);
  }

  toggleWorkoutSelection(workoutId, forceValue = null) {
    const workout = this.items.find((entry) => String(entry.id) === String(workoutId));
    if (!workout?.is_owned) {
      return;
    }

    const key = String(workoutId);
    const nextSelected = forceValue == null ? !this.selectedWorkoutIds.has(key) : !!forceValue;

    if (nextSelected) {
      this.selectedWorkoutIds.add(key);
    } else {
      this.selectedWorkoutIds.delete(key);
    }

    this.updateBulkUi();
    this.render();
  }

  selectAllVisibleOwned() {
    this.getRenderableItems().filter((workout) => workout.is_owned).forEach((workout) => {
      this.selectedWorkoutIds.add(String(workout.id));
    });
    this.updateBulkUi();
    this.render();
  }

  clearSelection() {
    this.selectedWorkoutIds.clear();
    this.closeBulkSharePanel();
    this.updateBulkUi();
    this.render();
  }

  toggleBulkSharePanel() {
    const shouldOpen = this.bulkShareInline?.classList.contains("d-none");
    if (!shouldOpen) {
      this.closeBulkSharePanel();
      return;
    }

    this.bulkShareInline?.classList.remove("d-none");
    this.bulkMenu?.removeAttribute("open");
    if (this.bulkShareModeSelect) {
      this.bulkShareModeSelect.value = this.bulkShareDraft.shareMode;
    }
    this.renderBulkShareGroups();
  }

  closeBulkSharePanel() {
    this.bulkShareInline?.classList.add("d-none");
    this.bulkMenu?.removeAttribute("open");
  }

  renderBulkShareGroups() {
    if (!this.bulkShareGroupsContainer) {
      return;
    }

    const isGroups = this.bulkShareDraft.shareMode === "groups";
    this.bulkShareGroupsContainer.classList.toggle("is-visible", isGroups);
    if (!isGroups) {
      this.bulkShareGroupsContainer.innerHTML = "";
      return;
    }

    this.bulkShareGroupsContainer.innerHTML = this.shareableGroups.map((group) => `
      <label class="workout-library-bulk-share-chip">
        <input type="checkbox" value="${group.id}" ${this.bulkShareDraft.groupIds.includes(Number(group.id)) ? "checked" : ""}>
        <span>${group.name}</span>
      </label>
    `).join("");

    this.bulkShareGroupsContainer.querySelectorAll('input[type="checkbox"]').forEach((element) => {
      element.addEventListener("change", () => {
        const nextGroupIds = new Set(this.bulkShareDraft.groupIds || []);
        const groupId = Number(element.value);
        if (element.checked) {
          nextGroupIds.add(groupId);
        } else {
          nextGroupIds.delete(groupId);
        }
        this.bulkShareDraft.groupIds = [...nextGroupIds];
      });
    });
  }

  getSelectedOwnedWorkouts() {
    return this.items.filter((workout) => workout.is_owned && this.selectedWorkoutIds.has(String(workout.id)));
  }

  updateBulkUi() {
    const selectedCount = this.getSelectedOwnedWorkouts().length;
    this.bulkBarElement?.classList.toggle("d-none", !this.selectionMode);
    this.toolbarDefaultElement?.classList.toggle("d-none", this.selectionMode);
    this.selectionModeButton?.setAttribute("aria-pressed", this.selectionMode ? "true" : "false");
    if (this.bulkCountElement) {
      this.bulkCountElement.textContent = selectedCount > 0
        ? this.pageT("bulkSelectedCount", { count: selectedCount })
        : this.pageT("bulkNoneSelected");
    }
    if (this.bulkDeleteButton) {
      this.bulkDeleteButton.disabled = selectedCount === 0;
    }
    if (this.bulkPublishToggleButton) {
      this.bulkPublishToggleButton.disabled = selectedCount === 0;
    }
    if (this.bulkClearSelectionButton) {
      this.bulkClearSelectionButton.disabled = selectedCount === 0;
    }
  }
}
