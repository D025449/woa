import confirmModal from "./confirm-modal.js";

const form = document.getElementById("api-keys-form");
if (form) {
  const messages = JSON.parse(document.getElementById("api-keys-messages").textContent);
  const element = id => document.getElementById(id);
  const name = element("api-key-name");
  const read = element("api-key-read");
  const gps = element("api-key-gps");
  const fit = element("api-key-fit");
  const create = element("api-key-create");
  const refresh = element("api-keys-refresh");
  const feedback = element("api-keys-feedback");
  const list = element("api-keys-list");
  const secretPanel = element("api-key-secret-panel");
  const secret = element("api-key-secret");
  const show = element("api-key-show");
  let state = null;
  let csrfToken = "";
  let busy = false;
  let accountActive = true;

  function clearSecret() {
    secret.value = "";
    secret.type = "password";
    show.checked = false;
    secretPanel.hidden = true;
  }

  function updateControls() {
    const activeCount = state?.keys.filter(key => key.status === "active").length || 0;
    const canCreate = state?.canCreate && accountActive && activeCount < state.limits.maxActiveKeys;
    for (const control of [name, read, gps, fit]) control.disabled = busy || !canCreate || !secretPanel.hidden;
    create.disabled = busy || !canCreate || !read.checked || !secretPanel.hidden;
    refresh.disabled = busy;
    for (const button of list.querySelectorAll("button")) button.disabled = busy;
    if (state) {
      element("api-keys-limits").textContent = messages.limits.replace("{count}", String(activeCount))
        .replace("{max}", String(state.limits.maxActiveKeys)).replace("{days}", String(state.limits.lifetimeDays));
    }
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/profile/api-keys${path}`, {
      credentials: "same-origin", cache: "no-store", ...options,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }
    });
    if (response.status === 204) return null;
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.code === "key_limit_reached" ? messages.limitReached
        : payload.code === "account_pending_deletion" ? messages.readOnly
        : response.status === 503 ? messages.unavailable : messages.error);
    }
    return payload;
  }

  function text(tag, value, className = "") {
    const node = document.createElement(tag);
    node.textContent = value;
    node.className = className;
    return node;
  }

  function date(value) {
    return value ? new Date(value).toLocaleString(messages.locale) : messages.never;
  }

  function render() {
    list.replaceChildren();
    for (const key of state.keys) {
      const row = document.createElement("li");
      row.className = "api-key-row";
      const identity = text("div", "", "api-key-identity");
      identity.append(text("strong", key.name), text("div", `${key.prefix}...`, "small font-monospace"));
      const scopeLabels = { "workouts:read": messages.readScope, "workouts:gps:read": messages.gpsScope, "workouts:fit:read": messages.fitScope };
      const scopes = text("div", key.scopes.map(scope => scopeLabels[scope] || scope).join(" / "), "small");
      const expires = text("div", "", "small");
      expires.append(text("span", messages.expires, "api-key-label"), text("span", date(key.expiresAt)));
      const lastUsed = text("div", "", "small");
      lastUsed.append(text("span", messages.lastUsed, "api-key-label"), text("span", date(key.lastUsedAt)));
      const actions = text("div", "", "api-key-actions");
      actions.append(text("span", messages[key.status] || messages.expired, "small"));
      if (key.status === "active") {
        const revoke = text("button", messages.revoke, "btn btn-sm btn-outline-danger");
        revoke.type = "button";
        revoke.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          updateControls();
          try {
            const accepted = await confirmModal({ title: messages.revoke, message: messages.confirmRevoke,
              acceptLabel: messages.revoke, cancelLabel: messages.cancel, acceptClass: "btn-danger" });
            if (!accepted) return;
            await request(`/${encodeURIComponent(key.id)}`, { method: "DELETE" });
            if (secret.value) clearSecret();
            await load();
            feedback.textContent = messages.revokedSuccess;
          } catch (error) { feedback.textContent = error.message; }
          finally { busy = false; updateControls(); }
        });
        actions.append(revoke);
      }
      row.append(identity, scopes, expires, lastUsed, actions);
      list.append(row);
    }
    element("api-keys-empty").hidden = state.keys.length > 0;
    updateControls();
  }

  async function load() {
    const payload = await request();
    csrfToken = payload.csrfToken;
    state = payload.data;
    render();
  }

  async function reload() {
    if (busy) return;
    busy = true;
    feedback.textContent = messages.loading;
    updateControls();
    try { await load(); feedback.textContent = state.canCreate && accountActive ? "" : messages.readOnly; }
    catch (error) { feedback.textContent = error.message; }
    finally { busy = false; updateControls(); }
  }

  read.addEventListener("change", () => { if (!read.checked) { gps.checked = false; fit.checked = false; } updateControls(); });
  gps.addEventListener("change", () => { if (gps.checked) read.checked = true; else fit.checked = false; updateControls(); });
  fit.addEventListener("change", () => { if (fit.checked) { read.checked = true; gps.checked = true; } updateControls(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || create.disabled || !form.reportValidity()) return;
    busy = true;
    updateControls();
    feedback.textContent = "";
    try {
      const payload = await request("", { method: "POST", body: JSON.stringify({ name: name.value,
        scopes: ["workouts:read", ...(gps.checked ? ["workouts:gps:read"] : []), ...(fit.checked ? ["workouts:fit:read"] : [])] }) });
      secret.value = payload.data.secret;
      secretPanel.hidden = false;
      state.keys.unshift(payload.data.key);
      name.value = "";
      render();
      feedback.textContent = messages.created;
    } catch (error) { feedback.textContent = error.message; }
    finally { busy = false; updateControls(); }
  });
  refresh.addEventListener("click", reload);
  show.addEventListener("change", () => { secret.type = show.checked ? "text" : "password"; });
  element("api-key-dismiss").addEventListener("click", () => { clearSecret(); updateControls(); });
  element("api-key-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(secret.value); feedback.textContent = messages.copied; }
    catch { feedback.textContent = messages.copyError; }
  });
  window.addEventListener("profile-account-state", event => {
    accountActive = event.detail === "active";
    updateControls();
  });
  window.addEventListener("pagehide", () => { clearSecret(); updateControls(); });
  clearSecret();
  reload();
}
