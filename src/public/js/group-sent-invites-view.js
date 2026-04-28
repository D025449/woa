export default class GroupSentInvitesView {

  constructor(containerSelector, handlers = {}, t = (key) => key) {
    this.container = document.querySelector(containerSelector);
    this.handlers = handlers;
    this.items = [];
    this.t = t;
  }

  render(items = []) {
    if (!this.container) {
      return;
    }

    this.items = items;

    if (!items.length) {
      this.container.innerHTML = `
        <div class="groups-empty">
          <strong>${this.t("view.emptySentInvitesTitle")}</strong><br>
          ${this.t("view.emptySentInvitesBody")}
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((invite) => `
      <div class="groups-preview-card">
        <span class="groups-preview-kicker">${invite.status || this.t("view.statusPending")}</span>
        <h3 class="groups-preview-title">${invite.group_name}</h3>
        <p class="groups-preview-copy">
          ${invite.invited_display_name || invite.invited_email}
          ${invite.message ? `<br><span class="text-muted">${invite.message}</span>` : ""}
        </p>
        <div class="groups-preview-actions">
          ${String(invite.status || "").toLowerCase() === "pending" ? `
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="revoke-invite"
              data-invite-id="${invite.id}">
              ${this.t("buttons.revoke")}
            </button>
          ` : `
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="dismiss-sent-invite"
              data-invite-id="${invite.id}">
              ${this.t("buttons.dismiss")}
            </button>
          `}
        </div>
      </div>
    `).join("");

    this.bindEvents();
  }

  bindEvents() {
    this.container
      .querySelectorAll('[data-action="revoke-invite"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const invite = this.items.find((item) => String(item.id) === String(button.dataset.inviteId));
          if (invite) {
            this.handlers.onRevokeInvite?.(invite);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="dismiss-sent-invite"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const invite = this.items.find((item) => String(item.id) === String(button.dataset.inviteId));
          if (invite) {
            this.handlers.onDismissSentInvite?.(invite);
          }
        });
      });
  }
}
