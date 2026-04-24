export default class GroupInvitesView {

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
          <strong>Keine eingegangenen Einladungen.</strong><br>
          Hier erscheinen nur Gruppen-Einladungen, die an dich adressiert sind.
        </div>
      `;
      return;
    }

    this.container.innerHTML = items.map((invite) => `
      <div class="groups-preview-card">
        <span class="groups-preview-kicker">${invite.status || "Pending"}</span>
        <h3 class="groups-preview-title">${invite.group_name}</h3>
        <p class="groups-preview-copy">${invite.message || invite.group_description || ""}</p>
        ${String(invite.status || "").toLowerCase() === "pending" ? `
          <div class="groups-preview-actions">
            <button
              type="button"
              class="btn btn-success btn-sm"
              data-action="accept-invite"
              data-invite-id="${invite.id}">
              Accept
            </button>
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm"
              data-action="decline-invite"
              data-invite-id="${invite.id}">
              Decline
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
