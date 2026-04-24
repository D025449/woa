import UIStateManager from "./UIStateManager.js";
import GroupFeedView from "./group-feed-view.js";

export default class ActivityFeedController {

  constructor({
    namespace,
    idPrefix,
    listSelector,
    defaultRange = "7d",
    defaultActorScope = "all"
  }) {
    this.uiState = new UIStateManager(namespace);
    this.idPrefix = idPrefix;
    this.feedFilter = this.uiState.get("feedFilter", defaultRange);
    this.feedActorFilter = this.uiState.get("feedActorFilter", defaultActorScope);
    this.feedFilter1dButton = document.getElementById(`${idPrefix}-feed-filter-1d`);
    this.feedFilter7dButton = document.getElementById(`${idPrefix}-feed-filter-7d`);
    this.feedFilterAllButton = document.getElementById(`${idPrefix}-feed-filter-all`);
    this.feedActorAllButton = document.getElementById(`${idPrefix}-feed-actor-all`);
    this.feedActorOthersButton = document.getElementById(`${idPrefix}-feed-actor-others`);
    this.feedView = new GroupFeedView(listSelector, {
      onDismissFeedEvent: async (item) => {
        await this.dismissFeedEvent(item);
      }
    });
  }

  registerEvents() {
    [this.feedFilter1dButton, this.feedFilter7dButton, this.feedFilterAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const nextFilter = button.dataset.feedFilterValue || "7d";
        await this.setFeedFilter(nextFilter);
      });
    });

    [this.feedActorAllButton, this.feedActorOthersButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const nextFilter = button.dataset.feedActorValue || "all";
        await this.setFeedActorFilter(nextFilter);
      });
    });
  }

  async boot() {
    this.updateFeedFilterUi();
    this.updateFeedActorFilterUi();

    try {
      const feedItems = await this.fetchFeed();
      this.uiState.set("feedPreview", feedItems);
      this.feedView.render(feedItems);
    } catch (err) {
      console.error(err);
      this.feedView.render(this.uiState.get("feedPreview", []));
    }
  }

  async fetchFeed() {
    const params = new URLSearchParams({
      limit: "20",
      range: this.feedFilter,
      actorScope: this.feedActorFilter
    });

    const response = await fetch(`/collaboration/feed?${params.toString()}`, {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(`Failed to load group feed (${response.status})`);
    }

    const result = await response.json();
    return result.data || [];
  }

  async setFeedFilter(nextFilter) {
    this.feedFilter = ["1d", "7d", "all"].includes(nextFilter) ? nextFilter : "7d";
    this.uiState.set("feedFilter", this.feedFilter);
    this.updateFeedFilterUi();

    try {
      const feedItems = await this.fetchFeed();
      this.uiState.set("feedPreview", feedItems);
      this.feedView.render(feedItems);
    } catch (err) {
      console.error(err);
    }
  }

  async setFeedActorFilter(nextFilter) {
    this.feedActorFilter = nextFilter === "others" ? "others" : "all";
    this.uiState.set("feedActorFilter", this.feedActorFilter);
    this.updateFeedActorFilterUi();

    try {
      const feedItems = await this.fetchFeed();
      this.uiState.set("feedPreview", feedItems);
      this.feedView.render(feedItems);
    } catch (err) {
      console.error(err);
    }
  }

  updateFeedFilterUi() {
    this.feedFilter1dButton?.classList.toggle("active", this.feedFilter === "1d");
    this.feedFilter7dButton?.classList.toggle("active", this.feedFilter === "7d");
    this.feedFilterAllButton?.classList.toggle("active", this.feedFilter === "all");
  }

  updateFeedActorFilterUi() {
    this.feedActorAllButton?.classList.toggle("active", this.feedActorFilter !== "others");
    this.feedActorOthersButton?.classList.toggle("active", this.feedActorFilter === "others");
  }

  async dismissFeedEvent(item) {
    if (!item?.id) {
      return;
    }

    try {
      const response = await fetch(`/collaboration/feed/${encodeURIComponent(item.id)}/dismiss`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed to dismiss feed event (${response.status})`);
      }

      await this.boot();
    } catch (err) {
      console.error(err);
      window.alert(err.message || "Feed-Eintrag konnte nicht ausgeblendet werden.");
    }
  }
}
