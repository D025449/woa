function formatEventTimestamp(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("de-DE", {
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

function formatSegmentMeta(item) {
  const parts = [
    item.entity_id ? `Segment #${item.entity_id}` : null,
    item.payload?.segmentType === "gps" ? "GPS-Segment" : item.payload?.segmentType || null,
    item.payload?.startName && item.payload?.endName
      ? `${item.payload.startName} -> ${item.payload.endName}`
      : item.payload?.startName || item.payload?.endName || null,
    formatDistanceKm(item.payload?.distance, "m")
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatPublishedInGroups(item) {
  const count = Number(item.group_count);

  if (!Number.isFinite(count) || count <= 1) {
    return null;
  }

  return `In ${count} Gruppen veröffentlicht`;
}

function describeEvent(item) {
  const actor = item.actor_display_name || item.actor_email || "Ein Mitglied";
  const publishedInGroups = formatPublishedInGroups(item);

  if (item.event_type === "workout_uploaded") {
    return {
      kicker: publishedInGroups || "Aktivität",
      title: `${actor} hat ein Workout hochgeladen`,
      meta: [
        item.payload?.originalFileName || null,
        formatDistanceKm(item.payload?.totalDistance, "km"),
        formatDurationSeconds(item.payload?.totalTimerTime)
      ].filter(Boolean).join(" · "),
      linkHref: item.entity_id ? `/dashboard-new?workoutId=${encodeURIComponent(item.entity_id)}` : null,
      linkLabel: item.entity_id ? "Zum Workout" : null
    };
  }

  if (item.event_type === "segment_published") {
    return {
      kicker: publishedInGroups || "Aktivität",
      title: `${actor} hat ein GPS-Segment veröffentlicht`,
      meta: formatSegmentMeta(item),
      linkHref: item.entity_id ? `/segments?focusSegmentId=${encodeURIComponent(item.entity_id)}` : null,
      linkLabel: item.entity_id ? "Zum Segment" : null
    };
  }

  return {
    kicker: publishedInGroups || "Aktivität",
    title: `${actor} hat ein neues Ereignis ausgelöst`,
    meta: "",
    linkHref: null,
    linkLabel: null
  };
}

export default class GroupFeedView {

  constructor(containerSelector, handlers = {}) {
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.items = [];
  }

  render(items = []) {
    if (!this.container) {
      return;
    }

    this.items = items;

    if (!items.length) {
      this.container.innerHTML = `
        <div class="groups-empty">
          <strong>Noch keine Aktivität.</strong><br>
          Neue freigegebene Workouts und GPS-Segmente aus deinen Gruppen erscheinen spaeter hier.
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((item) => {
      const event = describeEvent(item);
      const timestamp = formatEventTimestamp(item.created_at);

      return `
        <div class="groups-preview-card">
          <span class="groups-preview-kicker">${event.kicker}</span>
          <h3 class="groups-preview-title">${event.title}</h3>
          <p class="groups-preview-copy">
            ${event.meta || "Neues Gruppenereignis"}
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
              Ausblenden
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
