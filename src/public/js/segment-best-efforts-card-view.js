import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";

export default class SegmentBestEffortsCardView {
  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("segmentsPage");
    this.container = document.querySelector(containerSelector);
    this.loadMoreContainer = document.getElementById(handlers.loadMoreButtonId || "segment-best-efforts-load-more");
    this.loadMoreButton = this.loadMoreContainer?.querySelector("button") || null;
    this.handlers = handlers;
    this.currentSegment = null;
    this.scopeValue = handlers.initialScope ?? "mine";
    this.perUserValue = handlers.initialPerUser ?? "all";
    this.pollTimer = null;
    this.pollAttempt = 0;
    this.page = 1;
    this.pageSize = handlers.pageSize || 20;
    this.lastPage = 1;
    this.fastestDuration = null;

    this.loadMoreButton?.addEventListener("click", async () => {
      if (!this.currentSegment || this.page >= this.lastPage) {
        return;
      }

      this.page += 1;
      await this.loadSegmentBestEfforts(this.currentSegment, { append: true });
    });
  }

  setScope(scope) {
    this.scopeValue = scope || "mine";
  }

  setPerUserFilter(value) {
    this.perUserValue = ["all", "1", "3"].includes(String(value)) ? String(value) : "all";
  }

  async loadSegment(segment) {
    this.currentSegment = segment;
    this.stopBestEffortsPolling();
    this.page = 1;
    this.lastPage = 1;
    this.fastestDuration = null;
    this.updateHeader(segment);
    await this.loadSegmentBestEfforts(segment, { append: false });
  }

  async loadSegmentBestEfforts(segment, { append = false } = {}) {
    if (!this.container || !segment?.id) {
      return;
    }

    if (!append) {
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.loading")}</div>`;
      this.updateLoadMore();
    }

    try {
      const response = await fetch(this.buildRequestUrl(segment.id));
      if (!response.ok) {
        throw new Error(this.t("messages.failedBestEffortsStatus"));
      }

      const result = await response.json();
      const rows = Array.isArray(result?.data) ? result.data : [];
      if (!append) {
        this.fastestDuration = rows.length ? Number(rows[0]?.duration) : null;
      }
      this.lastPage = result?.last_page || 1;
      this.updateHeader(segment, result?.total_records);
      this.renderRows(rows, { append });
      this.updateLoadMore();

      if (this.shouldPollBestEfforts(segment)) {
        this.startBestEffortsPolling(segment.id);
      }
    } catch (error) {
      console.error(error);
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.failedBestEffortsStatus")}</div>`;
      this.updateLoadMore();
    }
  }

  renderRows(rows, { append = false } = {}) {
    if (!this.container) {
      return;
    }

    if (!rows.length) {
      if (!append) {
        this.container.innerHTML = `
          <div class="segments-best-efforts-empty">
            <div class="segments-best-efforts-empty__title">${this.t("bestEffortsEmptyTitle")}</div>
            <div class="segments-best-efforts-empty__copy">${this.t("bestEffortsEmpty")}</div>
          </div>
        `;
      }
      return;
    }

    const markup = rows.map((row) => this.renderRow(row)).join("");
    if (append) {
      this.container.insertAdjacentHTML("beforeend", markup);
      return;
    }

    this.container.innerHTML = markup;
  }

  buildRequestUrl(segmentId) {
    const params = new URLSearchParams();
    params.set("scope", this.scopeValue || "mine");
    params.set("perUser", this.perUserValue || "all");
    params.set("page", String(this.page));
    params.set("size", String(this.pageSize));
    params.set("sort[0][field]", "duration");
    params.set("sort[0][dir]", "asc");
    return `/segments/bestefforts/${segmentId}/data?${params.toString()}`;
  }

  updateLoadMore() {
    if (!this.loadMoreContainer || !this.loadMoreButton) {
      return;
    }

    const hasMore = this.page < this.lastPage;
    this.loadMoreContainer.classList.toggle("d-none", !hasMore);
    this.loadMoreButton.disabled = !hasMore;
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

    return `
      <article class="segments-best-effort-card">
        <div class="segments-best-effort-card__head">
          <div class="segments-best-effort-card__rank">#${this.escapeHtml(row.rn)}</div>
          <div class="segments-best-effort-card__identity">
            <div class="segments-best-effort-card__duration">${this.escapeHtml(Utils.formatDuration(row.duration))}${this.perUserValue === "1" ? ` <span class="segments-best-efforts-badge">PR</span>` : ""}</div>
            <div class="segments-best-effort-card__meta">${this.escapeHtml(this.formatStart(row))}</div>
          </div>
          <a class="segments-best-effort-card__workout" href="/dashboard-new?workoutId=${encodeURIComponent(row.wid)}">#${this.escapeHtml(row.wid)}</a>
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
    this.currentSegment = null;
    this.stopBestEffortsPolling();
    this.page = 1;
    this.lastPage = 1;
    this.fastestDuration = null;
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.updateLoadMore();
  }

  resize() {}

  shouldPollBestEfforts(segment) {
    return segment?.bestEffortsStatus === "queued" || segment?.bestEffortsStatus === "processing";
  }

  startBestEffortsPolling(segmentId) {
    this.stopBestEffortsPolling();
    this.pollAttempt = 0;

    const tick = async () => {
      if (!this.currentSegment || this.currentSegment.id !== segmentId) {
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
          await this.loadSegmentBestEfforts(this.currentSegment, { append: false });
          this.stopBestEffortsPolling();
          return;
        }

        if (this.pollAttempt >= 20) {
          this.stopBestEffortsPolling();
          return;
        }

        this.pollTimer = window.setTimeout(tick, 1000);
      } catch (err) {
        console.error(err);
        this.stopBestEffortsPolling();
      }
    };

    this.pollTimer = window.setTimeout(tick, 1000);
  }

  stopBestEffortsPolling() {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
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
