import UIStateManager from "./UIStateManager.js";
import GroupListView from "./group-list-view.js";
import GroupInvitesView from "./group-invites-view.js";
import GroupSentInvitesView from "./group-sent-invites-view.js";
import ActivityFeedController from "./activity-feed-controller.js";

export default class GroupsController {

  constructor({ t = (key) => key, locale = "en-US" } = {}) {
    this.t = t;
    this.locale = locale;
    this.uiState = new UIStateManager("groupsController");
    this.groupsFilter = this.uiState.get("groupsFilter", "all");
    this.createButton = document.getElementById("groups-create-button");
    this.filterAllButton = document.getElementById("groups-filter-all");
    this.filterOwnedButton = document.getElementById("groups-filter-owned");
    this.shellElement = document.getElementById("groups-shell");
    this.heroElement = document.getElementById("groups-hero");
    this.gridElement = document.getElementById("groups-grid");
    this.createModalElement = document.getElementById("create-group-modal");
    this.createForm = document.getElementById("create-group-form");
    this.createSubmitButton = document.getElementById("create-group-submit");
    this.createErrorElement = document.getElementById("create-group-error");
    this.createModal = this.createModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.createModalElement)
      : null;
    this.editModalElement = document.getElementById("edit-group-modal");
    this.editForm = document.getElementById("edit-group-form");
    this.editSubmitButton = document.getElementById("edit-group-submit");
    this.editErrorElement = document.getElementById("edit-group-error");
    this.editModal = this.editModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.editModalElement)
      : null;
    this.inviteModalElement = document.getElementById("invite-group-modal");
    this.inviteForm = document.getElementById("invite-group-form");
    this.inviteSubmitButton = document.getElementById("invite-group-submit");
    this.inviteErrorElement = document.getElementById("invite-group-error");
    this.inviteContextElement = document.getElementById("invite-group-context");
    this.inviteModal = this.inviteModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.inviteModalElement)
      : null;
    this.publishModalElement = document.getElementById("publish-group-content-modal");
    this.publishForm = document.getElementById("publish-group-content-form");
    this.publishSubmitButton = document.getElementById("publish-group-content-submit");
    this.publishErrorElement = document.getElementById("publish-group-content-error");
    this.publishContextElement = document.getElementById("publish-group-content-context");
    this.publishPresetWrapper = document.getElementById("publish-group-workout-preset-wrapper");
    this.publishTypeSelect = document.getElementById("publish-group-content-type");
    this.publishModal = this.publishModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.publishModalElement)
      : null;
    this.pendingPublishGroup = null;
    this.leaveModalElement = document.getElementById("leave-group-modal");
    this.leaveConfirmButton = document.getElementById("leave-group-confirm");
    this.leaveErrorElement = document.getElementById("leave-group-error");
    this.leaveContextElement = document.getElementById("leave-group-context");
    this.leaveModal = this.leaveModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.leaveModalElement)
      : null;
    this.pendingLeaveGroup = null;
    this.deleteModalElement = document.getElementById("delete-group-modal");
    this.deleteConfirmButton = document.getElementById("delete-group-confirm");
    this.deleteErrorElement = document.getElementById("delete-group-error");
    this.deleteContextElement = document.getElementById("delete-group-context");
    this.deleteModal = this.deleteModalElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Modal(this.deleteModalElement)
      : null;
    this.pendingDeleteGroup = null;
    this.pendingEditGroup = null;
    this.groups = [];
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.initViews();
    this.registerEvents();
    this.boot();
  }

  initViews() {
    this.groupListView = new GroupListView("#groups-list", {
      onEditGroup: (group) => {
        this.openEditModal(group);
      },
      onInviteGroup: (group) => {
        this.openInviteModal(group);
      },
      onPublishGroupContent: (group) => {
        this.openPublishModal(group);
      },
      onLeaveGroup: (group) => {
        this.openLeaveModal(group);
      },
      onDeleteGroup: (group) => {
        this.openDeleteModal(group);
      }
    }, this.t);
    this.groupInvitesView = new GroupInvitesView("#group-invites-list", {
      onAcceptInvite: async (invite) => {
        await this.respondToInvite(invite, "accept");
      },
      onDeclineInvite: async (invite) => {
        await this.respondToInvite(invite, "decline");
      }
    }, this.t);
    this.groupSentInvitesView = new GroupSentInvitesView("#group-sent-invites-list", {
      onRevokeInvite: async (invite) => {
        await this.revokeInvite(invite);
      },
      onDismissSentInvite: async (invite) => {
        await this.dismissSentInvite(invite);
      }
    }, this.t);
    this.activityFeedController = new ActivityFeedController({
      namespace: "groupsActivityFeed",
      idPrefix: "group",
      listSelector: "#group-feed-list",
      t: this.t,
      locale: this.locale
    });
  }

  registerEvents() {
    this.activityFeedController.registerEvents();
    window.addEventListener("resize", () => this.scheduleDesktopLayoutMeasure());
    this.initLayoutObservers();

    this.createButton?.addEventListener("click", () => {
      this.hideCreateError();
      this.createForm?.reset();
      this.createModal?.show();
    });

    [this.filterAllButton, this.filterOwnedButton].forEach((button) => {
      button?.addEventListener("click", () => {
        const nextFilter = button.dataset.filterValue || "all";
        this.setGroupsFilter(nextFilter);
      });
    });

    this.createForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handleCreateGroup();
    });

    this.editForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handleEditGroup();
    });

    this.inviteForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handleInviteGroup();
    });

    this.publishTypeSelect?.addEventListener("change", () => {
      this.updatePublishPresetUi();
    });

    this.publishForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handlePublishGroupContent();
    });

    this.leaveConfirmButton?.addEventListener("click", async () => {
      await this.handleLeaveGroup();
    });

    this.deleteConfirmButton?.addEventListener("click", async () => {
      await this.handleDeleteGroup();
    });
  }

  initLayoutObservers() {
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observerTargets = [
      document.querySelector(".app-topbar"),
      this.heroElement,
      this.gridElement
    ].filter(Boolean);

    if (!observerTargets.length) {
      return;
    }

    this.layoutObserver = new ResizeObserver(() => {
      this.scheduleDesktopLayoutMeasure();
    });

    observerTargets.forEach((target) => this.layoutObserver.observe(target));
  }

  scheduleDesktopLayoutMeasure() {
    if (!this.shellElement || !this.gridElement) {
      return;
    }

    if (this.layoutMeasureRaf != null) {
      cancelAnimationFrame(this.layoutMeasureRaf);
    }

    this.layoutMeasureRaf = requestAnimationFrame(() => {
      this.layoutMeasureRaf = null;
      this.updateDesktopLayoutMeasure();
    });
  }

  updateDesktopLayoutMeasure() {
    const shell = this.shellElement;
    const grid = this.gridElement;

    if (!shell || !grid) {
      return;
    }

    const isDesktopLike = window.matchMedia("(min-width: 992px)").matches;
    const rect = grid.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.floor(viewportHeight - rect.top - 24);
    const canUseClientLayout = isDesktopLike && availableHeight >= 520;

    shell.classList.toggle("groups-shell--client", canUseClientLayout);

    if (!canUseClientLayout) {
      shell.style.removeProperty("--groups-client-height");
      return;
    }

    shell.style.setProperty("--groups-client-height", `${availableHeight}px`);
  }

  openPublishModal(group) {
    if (!group || !this.publishForm) {
      return;
    }

    this.pendingPublishGroup = group;
    this.hidePublishError();
    this.publishForm.reset();

    if (this.publishTypeSelect) {
      this.publishTypeSelect.value = "workouts";
    }

    if (this.publishContextElement) {
      this.publishContextElement.textContent = this.t("messages.publishContext", { group: group.name });
    }

    this.updatePublishPresetUi();
    this.publishModal?.show();
  }

  updatePublishPresetUi() {
    const contentType = this.publishTypeSelect?.value || "workouts";
    this.publishPresetWrapper?.classList.toggle("d-none", contentType !== "workouts");
  }

  async handlePublishGroupContent() {
    if (!this.pendingPublishGroup || !this.publishForm) {
      return;
    }

    const formData = new FormData(this.publishForm);
    const contentType = String(formData.get("contentType") || "workouts");
    const payload = { contentType };

    if (contentType === "workouts") {
      payload.preset = String(formData.get("workoutPreset") || "training-30d");
    }

    this.hidePublishError();
    this.setPublishSubmitting(true);

    try {
      const response = await fetch(`/collaboration/groups/${this.pendingPublishGroup.id}/publish`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedPublishContent", { status: response.status }));
      }

      this.publishModal?.hide();
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showPublishError(err.message || this.t("messages.couldNotPublishContent"));
    } finally {
      this.setPublishSubmitting(false);
    }
  }

  setPublishSubmitting(isSubmitting) {
    if (!this.publishSubmitButton) {
      return;
    }

    this.publishSubmitButton.disabled = isSubmitting;
    this.publishSubmitButton.textContent = isSubmitting
      ? this.t("buttons.publishing")
      : this.t("buttons.publish");
  }

  showPublishError(message) {
    if (!this.publishErrorElement) {
      return;
    }

    this.publishErrorElement.textContent = message;
    this.publishErrorElement.classList.remove("d-none");
  }

  hidePublishError() {
    if (!this.publishErrorElement) {
      return;
    }

    this.publishErrorElement.textContent = "";
    this.publishErrorElement.classList.add("d-none");
  }

  async boot() {
    try {
      const [groups, invites, sentInvites] = await Promise.all([
        this.fetchGroups(),
        this.fetchInvites(),
        this.fetchSentInvites()
      ]);

      this.groups = groups;
      this.updateFilterUi();
      this.uiState.set("groupsPreview", groups);
      this.uiState.set("groupInvitesPreview", invites);
      this.uiState.set("groupSentInvitesPreview", sentInvites);

      this.groupListView.render(this.getFilteredGroups(groups));
      this.groupInvitesView.render(invites);
      this.groupSentInvitesView.render(sentInvites);
      await this.activityFeedController.boot();
      this.scheduleDesktopLayoutMeasure();
    } catch (err) {
      console.error(err);

      this.groups = this.uiState.get("groupsPreview", []);
      this.updateFilterUi();
      this.groupListView.render(this.getFilteredGroups(this.uiState.get("groupsPreview", [])));
      this.groupInvitesView.render(this.uiState.get("groupInvitesPreview", []));
      this.groupSentInvitesView.render(this.uiState.get("groupSentInvitesPreview", []));
      await this.activityFeedController.boot();
      this.scheduleDesktopLayoutMeasure();
    }
  }

  async fetchGroups() {
    const response = await fetch("/collaboration/groups", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(this.t("messages.failedLoadGroups", { status: response.status }));
    }

    const result = await response.json();
    return result.data || [];
  }

  setGroupsFilter(nextFilter) {
    this.groupsFilter = nextFilter === "owned" ? "owned" : "all";
    this.uiState.set("groupsFilter", this.groupsFilter);
    this.updateFilterUi();
    this.groupListView.render(this.getFilteredGroups(this.groups));
    this.scheduleDesktopLayoutMeasure();
  }

  updateFilterUi() {
    this.filterAllButton?.classList.toggle("active", this.groupsFilter !== "owned");
    this.filterOwnedButton?.classList.toggle("active", this.groupsFilter === "owned");
  }

  getFilteredGroups(groups = []) {
    if (this.groupsFilter !== "owned") {
      return groups;
    }

    return groups.filter((group) => String(group.role || "").toLowerCase() === "owner");
  }

  async fetchInvites() {
    const response = await fetch("/collaboration/invites", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(this.t("messages.failedLoadInvites", { status: response.status }));
    }

    const result = await response.json();
    return result.data || [];
  }

  async fetchSentInvites() {
    const response = await fetch("/collaboration/invites/sent", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(this.t("messages.failedLoadSentInvites", { status: response.status }));
    }

    const result = await response.json();
    return result.data || [];
  }

  async handleCreateGroup() {
    const formData = new FormData(this.createForm);
    const payload = {
      name: String(formData.get("name") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      visibility: String(formData.get("visibility") || "private")
    };

    this.hideCreateError();
    this.setCreateSubmitting(true);

    try {
      const response = await fetch("/collaboration/groups", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedCreateGroup", { status: response.status }));
      }

      this.createModal?.hide();
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showCreateError(err.message || this.t("messages.couldNotCreateGroup"));
    } finally {
      this.setCreateSubmitting(false);
    }
  }

  setCreateSubmitting(isSubmitting) {
    if (!this.createSubmitButton) {
      return;
    }

    this.createSubmitButton.disabled = isSubmitting;
    this.createSubmitButton.textContent = isSubmitting
      ? this.t("buttons.creating")
      : this.t("buttons.createGroup");
  }

  showCreateError(message) {
    if (!this.createErrorElement) {
      return;
    }

    this.createErrorElement.textContent = message;
    this.createErrorElement.classList.remove("d-none");
  }

  hideCreateError() {
    if (!this.createErrorElement) {
      return;
    }

    this.createErrorElement.textContent = "";
    this.createErrorElement.classList.add("d-none");
  }

  openEditModal(group) {
    if (!group || !this.editForm) {
      return;
    }

    this.pendingEditGroup = group;
    this.hideEditError();
    this.editForm.reset();
    this.editForm.elements.groupId.value = String(group.id);
    this.editForm.elements.name.value = group.name || "";
    this.editForm.elements.description.value = group.description || "";
    this.editModal?.show();
  }

  async handleEditGroup() {
    const formData = new FormData(this.editForm);
    const groupId = String(formData.get("groupId") || "");
    const payload = {
      name: String(formData.get("name") || "").trim(),
      description: String(formData.get("description") || "").trim()
    };

    this.hideEditError();
    this.setEditSubmitting(true);

    try {
      const response = await fetch(`/collaboration/groups/${encodeURIComponent(groupId)}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedUpdateGroup", { status: response.status }));
      }

      this.editModal?.hide();
      this.pendingEditGroup = null;
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showEditError(err.message || this.t("messages.couldNotUpdateGroup"));
    } finally {
      this.setEditSubmitting(false);
    }
  }

  openInviteModal(group) {
    if (!group || !this.inviteForm) {
      return;
    }

    this.hideInviteError();
    this.inviteForm.reset();
    this.inviteForm.elements.groupId.value = String(group.id);

    if (this.inviteContextElement) {
      this.inviteContextElement.textContent = this.t("messages.inviteContext", { group: group.name });
    }

    this.inviteModal?.show();
  }

  openLeaveModal(group) {
    if (!group) {
      return;
    }

    this.pendingLeaveGroup = group;
    this.hideLeaveError();

    if (this.leaveContextElement) {
      this.leaveContextElement.textContent = this.t("messages.leaveContext", { group: group.name });
    }

    this.leaveModal?.show();
  }

  openDeleteModal(group) {
    if (!group) {
      return;
    }

    this.pendingDeleteGroup = group;
    this.hideDeleteError();

    if (this.deleteContextElement) {
      this.deleteContextElement.textContent = this.t("messages.deleteContext", { group: group.name });
    }

    this.deleteModal?.show();
  }

  async handleInviteGroup() {
    const formData = new FormData(this.inviteForm);
    const groupId = String(formData.get("groupId") || "");
    const payload = {
      invitedEmail: String(formData.get("invitedEmail") || "").trim(),
      message: String(formData.get("message") || "").trim()
    };

    this.hideInviteError();
    this.setInviteSubmitting(true);

    try {
      const response = await fetch(`/collaboration/groups/${encodeURIComponent(groupId)}/invites`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedInviteUser", { status: response.status }));
      }

      this.inviteModal?.hide();
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showInviteError(err.message || this.t("messages.couldNotCreateInvite"));
    } finally {
      this.setInviteSubmitting(false);
    }
  }

  async handleLeaveGroup() {
    if (!this.pendingLeaveGroup?.id) {
      return;
    }

    this.hideLeaveError();
    this.setLeaveSubmitting(true);

    try {
      const response = await fetch(`/collaboration/groups/${encodeURIComponent(this.pendingLeaveGroup.id)}/leave`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedLeaveGroup", { status: response.status }));
      }

      this.leaveModal?.hide();
      this.pendingLeaveGroup = null;
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showLeaveError(err.message || this.t("messages.couldNotLeaveGroup"));
    } finally {
      this.setLeaveSubmitting(false);
    }
  }

  async handleDeleteGroup() {
    if (!this.pendingDeleteGroup?.id) {
      return;
    }

    this.hideDeleteError();
    this.setDeleteSubmitting(true);

    try {
      const response = await fetch(`/collaboration/groups/${encodeURIComponent(this.pendingDeleteGroup.id)}`, {
        method: "DELETE",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedDeleteGroup", { status: response.status }));
      }

      this.deleteModal?.hide();
      this.pendingDeleteGroup = null;
      await this.boot();
    } catch (err) {
      console.error(err);
      this.showDeleteError(err.message || this.t("messages.couldNotDeleteGroup"));
    } finally {
      this.setDeleteSubmitting(false);
    }
  }

  async respondToInvite(invite, action) {
    if (!invite?.id) {
      return;
    }

    try {
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
        throw new Error(result.error || this.t("messages.failedInviteAction", { action, status: response.status }));
      }

      await this.boot();
    } catch (err) {
      console.error(err);
      window.alert(err.message || this.t("messages.couldNotUpdateInviteStatus"));
    }
  }

  async revokeInvite(invite) {
    if (!invite?.id) {
      return;
    }

    try {
      const response = await fetch(`/collaboration/invites/${encodeURIComponent(invite.id)}/revoke`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedRevokeInvite", { status: response.status }));
      }

      await this.boot();
    } catch (err) {
      console.error(err);
      window.alert(err.message || this.t("messages.couldNotRevokeInvite"));
    }
  }

  async dismissSentInvite(invite) {
    if (!invite?.id) {
      return;
    }

    try {
      const response = await fetch(`/collaboration/invites/${encodeURIComponent(invite.id)}/dismiss-sent`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || this.t("messages.failedDismissInvite", { status: response.status }));
      }

      await this.boot();
    } catch (err) {
      console.error(err);
      window.alert(err.message || this.t("messages.couldNotDismissInvite"));
    }
  }

  setInviteSubmitting(isSubmitting) {
    if (!this.inviteSubmitButton) {
      return;
    }

    this.inviteSubmitButton.disabled = isSubmitting;
    this.inviteSubmitButton.textContent = isSubmitting
      ? this.t("buttons.sending")
      : this.t("buttons.sendInvite");
  }

  showInviteError(message) {
    if (!this.inviteErrorElement) {
      return;
    }

    this.inviteErrorElement.textContent = message;
    this.inviteErrorElement.classList.remove("d-none");
  }

  hideInviteError() {
    if (!this.inviteErrorElement) {
      return;
    }

    this.inviteErrorElement.textContent = "";
    this.inviteErrorElement.classList.add("d-none");
  }

  setEditSubmitting(isSubmitting) {
    if (!this.editSubmitButton) {
      return;
    }

    this.editSubmitButton.disabled = isSubmitting;
    this.editSubmitButton.textContent = isSubmitting
      ? this.t("buttons.saving")
      : this.t("buttons.saveChanges");
  }

  showEditError(message) {
    if (!this.editErrorElement) {
      return;
    }

    this.editErrorElement.textContent = message;
    this.editErrorElement.classList.remove("d-none");
  }

  hideEditError() {
    if (!this.editErrorElement) {
      return;
    }

    this.editErrorElement.textContent = "";
    this.editErrorElement.classList.add("d-none");
  }

  setLeaveSubmitting(isSubmitting) {
    if (!this.leaveConfirmButton) {
      return;
    }

    this.leaveConfirmButton.disabled = isSubmitting;
    this.leaveConfirmButton.textContent = isSubmitting
      ? this.t("buttons.leaving")
      : this.t("buttons.leaveGroupConfirm");
  }

  showLeaveError(message) {
    if (!this.leaveErrorElement) {
      return;
    }

    this.leaveErrorElement.textContent = message;
    this.leaveErrorElement.classList.remove("d-none");
  }

  hideLeaveError() {
    if (!this.leaveErrorElement) {
      return;
    }

    this.leaveErrorElement.textContent = "";
    this.leaveErrorElement.classList.add("d-none");
  }

  setDeleteSubmitting(isSubmitting) {
    if (!this.deleteConfirmButton) {
      return;
    }

    this.deleteConfirmButton.disabled = isSubmitting;
    this.deleteConfirmButton.textContent = isSubmitting
      ? this.t("buttons.deleting")
      : this.t("buttons.deleteGroupConfirm");
  }

  showDeleteError(message) {
    if (!this.deleteErrorElement) {
      return;
    }

    this.deleteErrorElement.textContent = message;
    this.deleteErrorElement.classList.remove("d-none");
  }

  hideDeleteError() {
    if (!this.deleteErrorElement) {
      return;
    }

    this.deleteErrorElement.textContent = "";
    this.deleteErrorElement.classList.add("d-none");
  }
}
