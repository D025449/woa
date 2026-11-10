import confirmModal from "./confirm-modal.js";

const list = document.getElementById("mcp-connections-list");
if (list) {
  const messages = JSON.parse(document.getElementById("mcp-connections-messages").textContent);
  const feedback = document.getElementById("mcp-connections-feedback");
  const refresh = document.getElementById("mcp-connections-refresh");
  let csrfToken = "", busy = false;
  const date = value => value ? new Date(value).toLocaleString(document.documentElement.lang) : messages.never;
  function node(tag, value, className = "") {
    const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
  }
  function controls() { refresh.disabled = busy; for (const button of list.querySelectorAll("button")) button.disabled = busy; }
  async function load() {
    const response = await fetch("/api/profile/mcp-connections", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 404) { list.replaceChildren(); feedback.textContent = messages.disabled; return; }
    if (!response.ok) throw new Error(messages.error);
    const payload = await response.json();
    csrfToken = payload.csrfToken;
    document.getElementById("mcp-server-url").textContent = payload.serverUrl;
    list.replaceChildren();
    for (const connection of payload.data) {
      const row = node("li", "", "mb-3");
      row.append(node("strong", connection.client_name), node("div", connection.scopes.filter(scope => scope !== "offline_access")
        .map(scope => messages.scopeLabels[scope]).filter(Boolean).join(" / "), "small"),
        node("div", `${messages.expires} ${date(connection.expires_at)}`, "small"),
        node("div", `${messages.lastUsed} ${date(connection.last_used_at)}`, "small"), node("div", messages[connection.status] || messages.expired, "small"));
      if (connection.status === "active") {
        const revoke = node("button", messages.revoke, "btn btn-sm btn-outline-danger"); revoke.type = "button";
        revoke.addEventListener("click", async () => {
          if (busy) return; busy = true; controls();
          try {
            if (!await confirmModal({ title: messages.revoke, message: messages.confirmRevoke, acceptLabel: messages.revoke,
              cancelLabel: messages.cancel, acceptClass: "btn-danger" })) return;
            const response = await fetch(`/api/profile/mcp-connections/${encodeURIComponent(connection.id)}`,
              { method: "DELETE", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } });
            if (!response.ok) throw new Error(messages.error);
            await load(); feedback.textContent = messages.revokedSuccess;
          } catch { feedback.textContent = messages.error; }
          finally { busy = false; controls(); }
        });
        row.append(revoke);
      }
      list.append(row);
    }
    feedback.textContent = payload.data.length ? "" : messages.empty;
  }
  async function reload() {
    if (busy) return; busy = true; controls();
    try { await load(); } catch { feedback.textContent = messages.error; } finally { busy = false; controls(); }
  }
  refresh.addEventListener("click", reload);
  reload();
}
