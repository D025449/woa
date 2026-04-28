function formatEventTimestamp(value, locale = "en-US") {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDistanceKm(value, unit = "km") {
  const distance = Number(value);

  if (!Number.isFinite(distance) || distance <= 0) {
    return null;
  }

  const normalizedDistance = unit === "m"
    ? distance / 1000
    : distance;

  return `${normalizedDistance.toFixed(1)} km`;
}

function formatDurationSeconds(value) {
  const totalSeconds = Number(value);

  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  return [hours, minutes, seconds]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}

function formatSegmentMeta(item, t) {
  const parts = [
    item.entity_id ? t("view.segmentMetaId", { id: item.entity_id }) : null,
    item.payload?.segmentType === "gps" ? t("view.segmentMetaTypeGps") : item.payload?.segmentType || null,
    item.payload?.startName && item.payload?.endName
      ? `${item.payload.startName} -> ${item.payload.endName}`
      : item.payload?.startName || item.payload?.endName || null,
    formatDistanceKm(item.payload?.distance, "m")
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatPublishedInGroups(item, t) {
  const count = Number(item.group_count);

  if (!Number.isFinite(count) || count <= 1) {
    return null;
  }

  return t("view.publishedInGroups", { count });
}

function describeEvent(item, t) {
  const actor = item.actor_display_name || item.actor_email || t("view.eventActorFallback");
  const publishedInGroups = formatPublishedInGroups(item, t);

  if (item.event_type === "workout_uploaded") {
    return {
      kicker: publishedInGroups || t("view.activityKicker"),
      title: t("view.eventWorkoutUploaded", { actor }),
      meta: [
        item.payload?.originalFileName || null,
        formatDistanceKm(item.payload?.totalDistance, "m"),
        formatDurationSeconds(item.payload?.totalTimerTime)
      ].filter(Boolean).join(" · "),
      linkHref: item.entity_id ? `/dashboard-new?workoutId=${encodeURIComponent(item.entity_id)}` : null,
      linkLabel: item.entity_id ? t("buttons.openWorkout") : null
    };
  }

  if (item.event_type === "segment_published") {
    return {
      kicker: publishedInGroups || t("view.activityKicker"),
      title: t("view.eventSegmentPublished", { actor }),
      meta: formatSegmentMeta(item, t),
      linkHref: item.entity_id ? `/segments?focusSegmentId=${encodeURIComponent(item.entity_id)}` : null,
      linkLabel: item.entity_id ? t("buttons.openSegment") : null
    };
  }

  return {
    kicker: publishedInGroups || t("view.activityKicker"),
    title: t("view.eventDefault", { actor }),
    meta: "",
    linkHref: null,
    linkLabel: null
  };
}

export default class GroupFeedView {

  constructor(containerSelector, handlers = {}, t = (key) => key, locale = "en-US") {
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.items = [];
    this.t = t;
    this.locale = locale;
  }

  render(items = []) {
    if (!this.container) {
      return;
    }

    this.items = items;

    if (!items.length) {
      this.container.innerHTML = `
        <div class="groups-empty">
          <strong>${this.t("view.emptyFeedTitle")}</strong><br>
          ${this.t("view.emptyFeedBody")}
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((item) => {
      const event = describeEvent(item, this.t);
      const timestamp = formatEventTimestamp(item.created_at, this.locale);

      return `
        <div class="groups-preview-card">
          <span class="groups-preview-kicker">${event.kicker}</span>
          <h3 class="groups-preview-title">${event.title}</h3>
          <p class="groups-preview-copy">
            ${event.meta || this.t("view.newGroupEvent")}
            ${timestamp ? `<br><span class="text-muted">${timestamp}</span>` : ""}
          </p>
          <div class="groups-preview-actions">
            ${event.linkHref ? `
              <a class="btn btn-outline-primary btn-sm" href="${event.linkHref}">
                ${event.linkLabel}
              </a>
            ` : ""}
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="dismiss-feed-event"
              data-feed-event-id="${item.id}">
              ${this.t("buttons.dismissEvent")}
            </button>
          </div>
        </div>
      `;
    }).join("");

    this.bindEvents();
  }

  bindEvents() {
    this.container
      .querySelectorAll('[data-action="dismiss-feed-event"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const item = this.items.find((entry) => String(entry.id) === String(button.dataset.feedEventId));
          if (item) {
            this.handlers.onDismissFeedEvent?.(item);
          }
        });
      });
  }

}
