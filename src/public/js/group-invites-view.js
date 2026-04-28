export default class GroupInvitesView {

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
          <strong>${this.t("view.emptyInvitesTitle")}</strong><br>
          ${this.t("view.emptyInvitesBody")}
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((invite) => `
      <div class="groups-preview-card">
        <span class="groups-preview-kicker">${invite.status || this.t("view.statusPending")}</span>
        <h3 class="groups-preview-title">${invite.group_name}</h3>
        <p class="groups-preview-copy">${invite.message || invite.group_description || ""}</p>
        ${String(invite.status || "").toLowerCase() === "pending" ? `
          <div class="groups-preview-actions">
            <button
              type="button"
              class="btn btn-success btn-sm"
              data-action="accept-invite"
              data-invite-id="${invite.id}">
              ${this.t("buttons.accept")}
            </button>
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="decline-invite"
              data-invite-id="${invite.id}">
              ${this.t("buttons.decline")}
            </button>
          </div>
        ` : ""}
      </div>
    `).join("");

    this.bindEvents();
  }

  bindEvents() {
    this.container
      .querySelectorAll('[data-action="accept-invite"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const invite = this.items.find((item) => String(item.id) === String(button.dataset.inviteId));
          if (invite) {
            this.handlers.onAcceptInvite?.(invite);
          }
        });
      });

    this.container
      .querySelectorAll('[data-action="decline-invite"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const invite = this.items.find((item) => String(item.id) === String(button.dataset.inviteId));
          if (invite) {
            this.handlers.onDeclineInvite?.(invite);
          }
        });
      });
  }
}
