import ActivityFeedController from "./activity-feed-controller.js";
import GroupInvitesView from "./group-invites-view.js";

document.addEventListener("DOMContentLoaded", async () => {
  const controller = new ActivityFeedController({
    namespace: "homeActivityFeed",
    idPrefix: "home",
    listSelector: "#home-feed-list"
  });

  const invitesView = new GroupInvitesView("#home-group-invites-list", {
    onAcceptInvite: async (invite) => {
      await respondToInvite(invite, "accept");
    },
    onDeclineInvite: async (invite) => {
      await respondToInvite(invite, "decline");
    }
  });

  async function fetchInvites() {
    const response = await fetch("/collaboration/invites", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(`Failed to load invites (${response.status})`);
    }

    const result = await response.json();
    return result.data || [];
  }

  async function respondToInvite(invite, action) {
    if (!invite?.id) {
      return;
    }

    const response = await fetch(`/collaboration/invites/${encodeURIComponent(invite.id)}/${action}`, {
      method: "POST",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || `Failed to ${action} invite (${response.status})`);
    }

    const invites = await fetchInvites();
    invitesView.render(invites);
  }

  controller.registerEvents();

  try {
    const invites = await fetchInvites();
    invitesView.render(invites);
  } catch (err) {
    console.error(err);
    invitesView.render([]);
  }

  await controller.boot();
});
