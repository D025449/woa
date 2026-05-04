import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";

export default class SegmentBestEffortsCardView {
  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("segmentsPage");
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.currentSegment = null;
    this.scopeValue = handlers.initialScope ?? "mine";
    this.pollTimer = null;
    this.pollAttempt = 0;
  }

  setScope(scope) {
    this.scopeValue = scope || "mine";
  }

  async loadSegment(segment) {
    this.currentSegment = segment;
    this.stopBestEffortsPolling();
    this.updateHeader(segment);
    await this.loadSegmentBestEfforts(segment);
  }

  async loadSegmentBestEfforts(segment) {
    if (!this.container || !segment?.id) {
      return;
    }

    this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.loading")}</div>`;

    try {
      const response = await fetch(`/segments/bestefforts/${segment.id}/data?scope=${encodeURIComponent(this.scopeValue || "mine")}`);
      if (!response.ok) {
        throw new Error(this.t("messages.failedBestEffortsStatus"));
      }

      const result = await response.json();
      const rows = Array.isArray(result?.data) ? result.data : [];
      this.updateHeader(segment, result?.total_records);
      this.renderRows(rows);

      if (this.shouldPollBestEfforts(segment)) {
        this.startBestEffortsPolling(segment.id);
      }
    } catch (error) {
      console.error(error);
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("messages.failedBestEffortsStatus")}</div>`;
    }
  }

  renderRows(rows) {
    if (!this.container) {
      return;
    }

    if (!rows.length) {
      this.container.innerHTML = `<div class="segments-best-efforts-empty">${this.t("bestEffortsEmpty")}</div>`;
      return;
    }

    this.container.innerHTML = rows.map((row) => this.renderRow(row)).join("");
  }

  renderRow(row) {
    const ownerId = row?.uid == null ? "" : String(row.uid);
    const currentUserId = this.handlers.currentUserId == null ? "" : String(this.handlers.currentUserId);
    const ownerLabel = ownerId !== "" && ownerId === currentUserId
      ? ""
      : (row.owner_display_name || row.owner_email || "");

    const meta = [
      row?.avg_speed != null ? `${Number(row.avg_speed).toFixed(1)} km/h` : null,
      row?.avg_power != null ? `${Number(row.avg_power).toFixed(0)} W` : null,
      row?.avg_heart_rate != null ? `${Number(row.avg_heart_rate).toFixed(0)} bpm` : null
    ].filter(Boolean).join(" · ");

    return `
      <article class="segments-best-effort-card">
        <div class="segments-best-effort-card__head">
          <div class="segments-best-effort-card__rank">#${this.escapeHtml(row.rn)}</div>
          <div class="segments-best-effort-card__identity">
            <div class="segments-best-effort-card__duration">${this.escapeHtml(Utils.formatDuration(row.duration))}</div>
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
    }
  }

  clear() {
    this.currentSegment = null;
    this.stopBestEffortsPolling();
    if (this.container) {
      this.container.innerHTML = "";
    }
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
          await this.loadSegmentBestEfforts(this.currentSegment);
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

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
