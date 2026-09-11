import Utils from "../../shared/Utils.js";
import { MAX_SEGMENT_COMPARISON_WORKOUTS } from "../../shared/SegmentComparison.js";
import { createTranslator } from "./i18n.js";

export function normalizeSegmentBestEffortsPageSize(value) {
  const pageSize = Number(value);
  return [10, 25, 50].includes(pageSize) ? pageSize : 25;
}

export default class SegmentBestEffortsCardView {
  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("segmentsPage");
    this.pageT = createTranslator("dashboardNewPage");
    this.container = document.querySelector(containerSelector);
    this.paginationContainer = document.getElementById("segment-best-efforts-pagination");
    this.previousPageButton = document.getElementById("segment-best-efforts-page-previous");
    this.nextPageButton = document.getElementById("segment-best-efforts-page-next");
    this.pageStatusElement = document.getElementById("segment-best-efforts-page-status");
    this.pageSizeSelect = document.getElementById("segment-best-efforts-page-size");
    this.handlers = handlers;
    this.currentSegment = null;
    this.scopeValue = handlers.initialScope ?? "mine";
    this.perUserValue = handlers.initialPerUser ?? "all";
    this.pollTimer = null;
    this.pollAttempt = 0;
    this.pollDeadline = 0;
    this.page = 1;
    this.pageSize = normalizeSegmentBestEffortsPageSize(handlers.pageSize);
    this.lastPage = 1;
    this.loading = false;
    this.pendingRequestId = 0;
    this.fastestDuration = null;
    this.lastMatchCount = null;
    this.comparisonRows = new Map();
    this.rowsByComparisonKey = new Map();

    this.container?.addEventListener("click", (event) => {
      if (event.target?.closest?.("a")) return;
      const card = event.target?.closest?.("[data-segment-comparison-key]");
      if (card) this.toggleComparison(card.dataset.segmentComparisonKey);
    });
    this.container?.addEventListener("keydown", (event) => {
      if (!['Enter', ' '].includes(event.key) || event.target?.closest?.("a")) return;
      const card = event.target?.closest?.("[data-segment-comparison-key]");
      if (!card) return;
      event.preventDefault();
      this.toggleComparison(card.dataset.segmentComparisonKey);
    });

    this.previousPageButton?.addEventListener("click", () => this.goToPage(this.page - 1));
    this.nextPageButton?.addEventListener("click", () => this.goToPage(this.page + 1));
    if (this.pageSizeSelect) this.pageSizeSelect.value = String(this.pageSize);
    this.pageSizeSelect?.addEventListener("change", async () => {
      const pageSize = normalizeSegmentBestEffortsPageSize(this.pageSizeSelect.value);
      if (pageSize === this.pageSize) return;
      this.pageSize = pageSize;
      this.page = 1;
      if (this.currentSegment) await this.loadSegmentBestEfforts(this.currentSegment);
    });
  }

  async goToPage(page) {
    if (!this.currentSegment || this.loading) return;
    const targetPage = Math.min(this.lastPage, Math.max(1, Math.trunc(Number(page)) || 1));
    if (targetPage === this.page) return;
    this.page = targetPage;
    await this.loadSegmentBestEfforts(this.currentSegment);
    this.container?.parentElement?.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  setScope(scope) {
    this.scopeValue = scope || "mine";
  }

  setPerUserFilter(value) {
    this.perUserValue = ["all", "1", "3"].includes(String(value)) ? String(value) : "all";
  }

  async loadSegment(segment) {
    const segmentChanged = String(this.currentSegment?.id ?? "") !== String(segment?.id ?? "");
    this.currentSegment = segment;
    if (segmentChanged) this.clearComparisons();
    this.stopBestEffortsPolling();
    this.page = 1;
    this.lastPage = 1;
    this.fastestDuration = null;
    this.lastMatchCount = null;
    this.updateHeader(segment);
    await this.loadSegmentBestEfforts(segment);
  }

  async loadSegmentBestEfforts(segment, { showLoading = true } = {}) {
    if (!this.container || !segment?.id) {
      return;
    }

    const requestId = ++this.pendingRequestId;
    this.loading = true;
    this.updatePagination();
    if (showLoading) {
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.loading")}</div>`;
    }

    try {
      const response = await fetch(this.buildRequestUrl(segment.id));
      if (!response.ok) {
        throw new Error(this.t("messages.failedBestEffortsStatus"));
      }

      const result = await response.json();
      if (requestId !== this.pendingRequestId) return;
      const rows = Array.isArray(result?.data) ? result.data : [];
      if (result?.best_efforts_status) {
        segment.bestEffortsStatus = result.best_efforts_status;
      }
      this.fastestDuration = rows.length ? Number(rows[0]?.leader_duration ?? rows[0]?.duration) : null;
      this.lastPage = Math.max(1, Number(result?.last_page) || 1);
      this.page = Math.min(this.lastPage, Math.max(1, Number(result?.current_page) || this.page));
      this.lastMatchCount = Number.isFinite(Number(result?.total_records))
        ? Number(result.total_records)
        : null;
      this.updateHeader(segment, result?.total_records);
      this.renderRows(rows);

      if (this.shouldPollBestEfforts(segment, rows.length)) {
        this.startBestEffortsPolling(segment.id);
      }
    } catch (error) {
      if (requestId !== this.pendingRequestId) return;
      console.error(error);
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.failedBestEffortsStatus")}</div>`;
      if (this.shouldPollBestEfforts(segment, 0)) {
        this.startBestEffortsPolling(segment.id);
      }
    } finally {
      if (requestId === this.pendingRequestId) {
        this.loading = false;
        this.updatePagination();
      }
    }
  }

  renderRows(rows) {
    if (!this.container) {
      return;
    }

    this.rowsByComparisonKey.clear();

    if (!rows.length) {
      this.container.innerHTML = `
        <div class="segments-best-efforts-empty">
          <div class="segments-best-efforts-empty__title">${this.t("bestEffortsEmptyTitle")}</div>
          <div class="segments-best-efforts-empty__copy">${this.t("bestEffortsEmpty")}</div>
        </div>
      `;
      return;
    }

    rows.forEach((row) => this.rowsByComparisonKey.set(this.comparisonKey(row), row));
    const markup = rows.map((row) => this.renderRow(row)).join("");
    this.container.innerHTML = markup;
    this.syncComparisonCards();
  }

  buildRequestUrl(segmentId) {
    const params = new URLSearchParams();
    params.set("scope", this.scopeValue || "mine");
    params.set("perUser", this.perUserValue || "all");
    params.set("page", String(this.page));
    params.set("size", String(this.pageSize));
    params.set("sort[0][field]", "duration");
    params.set("sort[0][dir]", "asc");
    params.set("sort[1][field]", "wid");
    params.set("sort[1][dir]", "asc");
    params.set("sort[2][field]", "start_offset");
    params.set("sort[2][dir]", "asc");
    params.set("sort[3][field]", "end_offset");
    params.set("sort[3][dir]", "asc");
    return `/segments/bestefforts/${segmentId}/data?${params.toString()}`;
  }

  updatePagination() {
    if (!this.paginationContainer) return;
    const hasResults = Number(this.lastMatchCount) > 0;
    this.paginationContainer.classList.toggle("d-none", !hasResults);
    if (this.previousPageButton) this.previousPageButton.disabled = this.loading || this.page <= 1;
    if (this.nextPageButton) this.nextPageButton.disabled = this.loading || this.page >= this.lastPage;
    if (this.pageSizeSelect) this.pageSizeSelect.disabled = this.loading;
    if (this.pageStatusElement) {
      this.pageStatusElement.textContent = this.pageT("paginationStatus", {
        page: this.page,
        pages: this.lastPage
      });
    }
  }

  renderRow(row) {
    const ownerId = row?.uid == null ? "" : String(row.uid);
    const currentUserId = this.handlers.currentUserId == null ? "" : String(this.handlers.currentUserId);
    const ownerLabel = ownerId !== "" && ownerId === currentUserId
      ? ""
      : (row.owner_display_name || row.owner_email || "");

    const meta = [
      this.formatGapToLeader(row?.duration),
      row?.avg_speed != null ? `${Number(row.avg_speed).toFixed(1)} km/h` : null,
      row?.avg_power != null ? `${Number(row.avg_power).toFixed(0)} W` : null,
      row?.avg_heart_rate != null ? `${Number(row.avg_heart_rate).toFixed(0)} bpm` : null
    ].filter(Boolean).join(" · ");

    const comparisonKey = this.comparisonKey(row);
    return `
      <article class="segments-best-effort-card" role="checkbox" tabindex="0"
        aria-checked="false" aria-label="${this.escapeHtml(this.t("comparisonAddAria", { workout: `W-${row.wid}` }))}"
        data-segment-comparison-key="${this.escapeHtml(comparisonKey)}">
        <div class="segments-best-effort-card__head">
          <div class="segments-best-effort-card__rank">#${this.escapeHtml(row.rn)}</div>
          <div class="segments-best-effort-card__identity">
            <div class="segments-best-effort-card__duration">${this.escapeHtml(Utils.formatDuration(row.duration))}${this.perUserValue === "1" ? ` <span class="segments-best-efforts-badge">PR</span>` : ""}</div>
            <div class="segments-best-effort-card__meta">${this.escapeHtml(this.formatStart(row))}</div>
          </div>
          <div class="segments-best-effort-card__actions">
            <span class="segments-best-effort-card__compare" aria-hidden="true">
              <span class="segments-best-effort-card__compare-dot"></span>
              <span data-comparison-label>${this.t("comparisonAdd")}</span>
            </span>
            <a class="segments-best-effort-card__workout" href="/dashboard-new?workoutId=${encodeURIComponent(row.wid)}">W-${this.escapeHtml(row.wid)}</a>
          </div>
        </div>
        <div class="segments-best-effort-card__stats">${this.escapeHtml(meta || this.t("na"))}</div>
        ${ownerLabel ? `<div class="segments-best-effort-card__owner">${this.t("table.ownerShort")}: ${this.escapeHtml(ownerLabel)}</div>` : ""}
      </article>
    `;
  }

  formatStart(row) {
    if (!row?.start_time) {
      return this.t("na");
    }
    return `${new Date(row.start_time).toLocaleDateString()} · ${Utils.formatStartIndex(row.start_offset)}`;
  }

  updateHeader(segment, matchCount = null) {
    const hdr = document.getElementById("segment-header");
    if (hdr && this.handlers.formatSegmentHeaderMarkup) {
      hdr.innerHTML = this.handlers.formatSegmentHeaderMarkup(segment, matchCount);
      this.handlers.onHeaderRendered?.();
    }
  }

  clear() {
    this.pendingRequestId += 1;
    this.loading = false;
    this.currentSegment = null;
    this.stopBestEffortsPolling();
    this.page = 1;
    this.lastPage = 1;
    this.fastestDuration = null;
    this.lastMatchCount = null;
    this.clearComparisons();
    this.rowsByComparisonKey.clear();
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.updatePagination();
  }

  resize() {}

  comparisonKey(row) {
    return [row?.wid, row?.start_offset, row?.end_offset].map((value) => String(value ?? "")).join(":");
  }

  toggleComparison(key) {
    const row = this.rowsByComparisonKey.get(String(key));
    if (!row) return;

    if (this.comparisonRows.has(String(key))) {
      this.comparisonRows.delete(String(key));
    } else {
      if (this.comparisonRows.size >= MAX_SEGMENT_COMPARISON_WORKOUTS) {
        this.handlers.onComparisonLimit?.(MAX_SEGMENT_COMPARISON_WORKOUTS);
        return;
      }
      this.comparisonRows.set(String(key), row);
    }

    this.syncComparisonCards();
    this.handlers.onComparisonChange?.([...this.comparisonRows.values()]);
  }

  clearComparisons() {
    if (this.comparisonRows.size === 0) return;
    this.comparisonRows.clear();
    this.syncComparisonCards();
    this.handlers.onComparisonChange?.([]);
  }

  syncComparisonCards() {
    const selectedKeys = [...this.comparisonRows.keys()];
    this.container?.querySelectorAll?.("[data-segment-comparison-key]").forEach((card) => {
      const selectedIndex = selectedKeys.indexOf(card.dataset.segmentComparisonKey);
      const selected = selectedIndex >= 0;
      card.classList.toggle("is-comparison-selected", selected);
      card.setAttribute("aria-checked", selected ? "true" : "false");
      card.dataset.comparisonIndex = selected ? String(selectedIndex + 1) : "";
      const row = this.rowsByComparisonKey.get(card.dataset.segmentComparisonKey);
      card.setAttribute("aria-label", this.t(selected ? "comparisonRemoveAria" : "comparisonAddAria", {
        workout: `W-${row?.wid ?? ""}`
      }));
      const label = card.querySelector("[data-comparison-label]");
      if (label) label.textContent = selected
        ? this.t("comparisonSelected", { index: selectedIndex + 1 })
        : this.t("comparisonAdd");
    });
  }

  shouldPollBestEfforts(segment, rowCount = 0) {
    const status = String(segment?.bestEffortsStatus || "").toLowerCase();
    return status === "queued"
      || status === "processing"
      || (!status && Number(rowCount) === 0);
  }

  startBestEffortsPolling(segmentId) {
    this.stopBestEffortsPolling();
    this.pollAttempt = 0;
    this.pollDeadline = Date.now() + (5 * 60 * 1000);

    const scheduleNext = () => {
      if (Date.now() >= this.pollDeadline) {
        this.stopBestEffortsPolling();
        return;
      }
      const delayMs = Math.min(5000, 1000 + (Math.floor(this.pollAttempt / 10) * 500));
      this.pollTimer = window.setTimeout(tick, delayMs);
    };

    const tick = async () => {
      if (!this.currentSegment || String(this.currentSegment.id) !== String(segmentId)) {
        this.stopBestEffortsPolling();
        return;
      }

      this.pollAttempt += 1;

      try {
        const res = await fetch(`/segments/${segmentId}/best-efforts-status`);
        if (!res.ok) {
          throw new Error(this.t("messages.failedBestEffortsStatus"));
        }

        const data = await res.json();
        this.currentSegment.bestEffortsStatus = data.status;

        if (data.status === "completed" || data.status === "failed") {
          this.page = 1;
          await this.loadSegmentBestEfforts(this.currentSegment, {
            showLoading: false
          });
          this.stopBestEffortsPolling();
          return;
        }

        scheduleNext();
      } catch (err) {
        console.error(err);
        scheduleNext();
      }
    };

    this.pollTimer = window.setTimeout(tick, 250);
  }

  stopBestEffortsPolling() {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollDeadline = 0;
  }

  formatGapToLeader(duration) {
    const fastest = Number(this.fastestDuration);
    const value = Number(duration);

    if (!Number.isFinite(value) || !Number.isFinite(fastest)) {
      return null;
    }

    const delta = Math.max(0, value - fastest);
    if (delta <= 0) {
      return this.t("table.leader");
    }

    return `+${Utils.formatDuration(delta)}`;
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
