function canInvite(group) {
  return ["owner", "admin"].includes(String(group.role || "").toLowerCase());
}

function canLeave(group) {
  return String(group.role || "").toLowerCase() !== "owner";
}

function canDelete(group) {
  return String(group.role || "").toLowerCase() === "owner";
}

function canEdit(group) {
  return String(group.role || "").toLowerCase() === "owner";
}

function canPublishContent(group) {
  return Boolean(group?.id);
}

function getMemberPreview(group) {
  const members = Array.isArray(group.members) ? group.members : [];
  const visibleMembers = members.slice(0, 4);
  const hiddenCount = Math.max(0, members.length - visibleMembers.length);

  return {
    visibleMembers,
    hiddenCount
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getGroupMonogram(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "G";
}

function roleTone(role) {
  switch (String(role || "").toLowerCase()) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    default:
      return "member";
  }
}

function visibilityTone(visibility) {
  return String(visibility || "").toLowerCase() === "discoverable" ? "discoverable" : "private";
}

export default class GroupListView {

  constructor(containerSelector, handlers = {}, t = (key) => key) {
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.items = [];
    this.t = t;
  }

  getRoleLabel(role) {
    switch (String(role || "").toLowerCase()) {
      case "owner":
        return this.t("view.roleOwner");
      case "admin":
        return this.t("view.roleAdmin");
      case "member":
        return this.t("view.roleMember");
      default:
        return role || this.t("view.memberFallback");
    }
  }

  getVisibilityLabel(visibility) {
    return String(visibility || "").toLowerCase() === "discoverable"
      ? this.t("view.visibilityDiscoverable")
      : this.t("view.visibilityPrivate");
  }

  render(items = []) {
    if (!this.container) {
      return;
    }

    this.items = items;

    if (!items.length) {
      this.container.innerHTML = `
        <div class="groups-empty">
          <strong>${this.t("view.emptyGroupsTitle")}</strong><br>
          ${this.t("view.emptyGroupsBody")}
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((group) => {
      const { visibleMembers, hiddenCount } = getMemberPreview(group);
      const safeName = escapeHtml(group.name);
      const safeDescription = escapeHtml(group.description || this.t("view.noDescription"));
      const monogram = escapeHtml(getGroupMonogram(group.name));
      const roleLabel = this.getRoleLabel(group.role);
      const visibilityLabel = this.getVisibilityLabel(group.visibility);
      const roleClass = roleTone(group.role);
      const visibilityClass = visibilityTone(group.visibility);
      const memberCount = Number(group.member_count || 0);

      return `
        <article class="groups-library-card">
          <div class="groups-library-card__accent groups-library-card__accent--${roleClass}"></div>

          <div class="groups-library-card__header">
            <div class="groups-library-card__identity">
              <div class="groups-library-card__meta">
                <span class="groups-library-pill groups-library-pill--${roleClass}">${escapeHtml(roleLabel)}</span>
                <span class="groups-library-pill groups-library-pill--${visibilityClass}">${escapeHtml(visibilityLabel)}</span>
              </div>
              <div class="groups-library-card__identity-row">
                <span class="groups-library-card__mark groups-library-card__mark--${roleClass}" aria-hidden="true">${monogram}</span>
                <h3 class="groups-library-card__title">${safeName}</h3>
              </div>
              <p class="groups-library-card__copy">${safeDescription}</p>
            </div>
            <div class="groups-library-card__count">
              <span class="groups-library-card__count-label">${this.t("view.membersLabel")}</span>
              <strong class="groups-library-card__count-value">${memberCount}</strong>
            </div>
          </div>

          <div class="groups-library-card__members">
            <div class="groups-member-summary__items">
              ${visibleMembers.map((member) => `
                <span class="groups-member-pill">${escapeHtml(member.label)}</span>
              `).join("")}
              ${hiddenCount > 0 ? `
                <span class="groups-member-pill groups-member-pill--more">${escapeHtml(this.t("view.moreMembers", { count: hiddenCount }))}</span>
              ` : ""}
            </div>
          </div>

          <div class="groups-library-card__actions groups-preview-actions">
            ${canPublishContent(group) ? `
              <button
                type="button"
                class="btn btn-outline-success btn-sm"
                data-action="publish-group-content"
                data-group-id="${group.id}">
                ${this.t("buttons.publishContent")}
              </button>
            ` : ""}
            ${canEdit(group) ? `
              <button
                type="button"
                class="btn btn-outline-secondary btn-sm"
                data-action="edit-group"
                data-group-id="${group.id}">
                ${this.t("buttons.edit")}
              </button>
            ` : ""}
            ${canInvite(group) ? `
              <button
                type="button"
                class="btn btn-outline-primary btn-sm"
                data-action="invite-group"
                data-group-id="${group.id}">
                ${this.t("buttons.invite")}
              </button>
            ` : ""}
            ${canLeave(group) ? `
              <button
                type="button"
                class="btn btn-outline-danger btn-sm"
                data-action="leave-group"
                data-group-id="${group.id}">
                ${this.t("buttons.leaveGroup")}
              </button>
            ` : ""}
            ${canDelete(group) ? `
              <button
                type="button"
                class="btn btn-danger btn-sm"
                data-action="delete-group"
                data-group-id="${group.id}">
                ${this.t("buttons.deleteGroup")}
              </button>
            ` : ""}
          </div>
        </article>
      `;
    }).join("");

    this.bindEvents();
  }

  bindEvents() {
    this.container
      .querySelectorAll('[data-action="edit-group"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const groupId = button.dataset.groupId;
          const group = this.items.find((item) => String(item.id) === String(groupId));
          if (group) {
            this.handlers.onEditGroup?.(group);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="publish-group-content"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const groupId = button.dataset.groupId;
          const group = this.items.find((item) => String(item.id) === String(groupId));
          if (group) {
            this.handlers.onPublishGroupContent?.(group);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="invite-group"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const groupId = button.dataset.groupId;
          const group = this.items.find((item) => String(item.id) === String(groupId));
          if (group) {
            this.handlers.onInviteGroup?.(group);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="leave-group"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const groupId = button.dataset.groupId;
          const group = this.items.find((item) => String(item.id) === String(groupId));
          if (group) {
            this.handlers.onLeaveGroup?.(group);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="delete-group"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const groupId = button.dataset.groupId;
          const group = this.items.find((item) => String(item.id) === String(groupId));
          if (group) {
            this.handlers.onDeleteGroup?.(group);
          }
        });
      });
  }
}
