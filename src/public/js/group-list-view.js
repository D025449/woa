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

export default class GroupListView {

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
          <strong>Noch keine Gruppen.</strong><br>
          Lege deine erste private Trainingsgruppe hier an. Die Home-Seite bleibt dabei bewusst read-only.
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((group) => `
      ${(() => {
        const { visibleMembers, hiddenCount } = getMemberPreview(group);

        return `
      <div class="groups-preview-card">
        <span class="groups-preview-kicker">${group.role || "Member"} · ${group.member_count || 0} Mitglieder</span>
        <h3 class="groups-preview-title">${group.name}</h3>
        <p class="groups-preview-copy">${group.description || ""}</p>
        <div class="groups-member-summary">
          <div class="groups-member-summary__label">Mitglieder</div>
          <div class="groups-member-summary__items">
            ${visibleMembers.map((member) => `
              <span class="groups-member-pill">${member.label}</span>
            `).join("")}
            ${hiddenCount > 0 ? `
              <span class="groups-member-pill groups-member-pill--more">+${hiddenCount} mehr</span>
            ` : ""}
          </div>
        </div>
        <div class="groups-preview-actions">
          ${canPublishContent(group) ? `
            <button
              type="button"
              class="btn btn-outline-success btn-sm"
              data-action="publish-group-content"
              data-group-id="${group.id}">
              Inhalte veroeffentlichen
            </button>
          ` : ""}
          ${canEdit(group) ? `
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="edit-group"
              data-group-id="${group.id}">
              Bearbeiten
            </button>
          ` : ""}
          ${canInvite(group) ? `
            <button
              type="button"
              class="btn btn-outline-primary btn-sm"
              data-action="invite-group"
              data-group-id="${group.id}">
              Einladen
            </button>
          ` : ""}
          ${canLeave(group) ? `
            <button
              type="button"
              class="btn btn-outline-danger btn-sm"
              data-action="leave-group"
              data-group-id="${group.id}">
              Gruppe verlassen
            </button>
          ` : ""}
          ${canDelete(group) ? `
            <button
              type="button"
              class="btn btn-danger btn-sm"
              data-action="delete-group"
              data-group-id="${group.id}">
              Gruppe löschen
            </button>
          ` : ""}
        </div>
      </div>
    `;
      })()}
    `).join("");

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
