import confirmModal from "./confirm-modal.js";

const connect = document.getElementById("wahoo-connect");
if (connect) {
  const messages = JSON.parse(document.getElementById("wahoo-settings-messages").textContent);
  const remove = document.getElementById("wahoo-remove");
  const autoImport = document.getElementById("wahoo-auto-import");
  const help = document.getElementById("wahoo-auto-import-help");
  const status = document.getElementById("wahoo-status");
  const feedback = document.getElementById("wahoo-feedback");
  let data = { configured: false, available: false };
  let readOnly = true;
  let busy = false;
  function lock(value) {
    busy = value;
    connect.disabled = busy || readOnly || !data.available || (data.configured && data.offlineDataGranted);
    remove.disabled = busy || readOnly || !data.configured;
    autoImport.disabled = busy || readOnly || !data.configured || !data.offlineDataGranted || !data.webhookAvailable;
  }
  async function request(path, method = "GET", body) {
    const response = await fetch(`/auth/wahoo/${path}`, { method, credentials: "same-origin", cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(messages.error);
    return response.status === 204 ? null : response.json();
  }
  const connectLabel = connect.textContent;
  function display() {
    connect.textContent = data.configured && !data.offlineDataGranted ? messages.reconnect : connectLabel;
    autoImport.checked = Boolean(data.autoImportEnabled);
    help.textContent = !data.webhookAvailable ? messages.webhookUnavailable
      : data.configured && !data.offlineDataGranted ? messages.offlineRequired : messages.autoImportHelp;
    status.textContent = data.configured ? messages.configured : data.available ? messages.empty : messages.unavailable;
  }
  const outcome = new URLSearchParams(location.search).get("wahoo");
  if (["connected", "denied", "error"].includes(outcome)) feedback.textContent = messages[outcome];
  connect.addEventListener("click", async () => {
    if (busy || readOnly) return;
    lock(true);
    try {
      const result = await request("start", "POST");
      const url = new URL(result.url);
      if (url.origin !== "https://api.wahooligan.com" || url.pathname !== "/oauth/authorize") throw new Error(messages.error);
      location.assign(url.href);
    } catch { feedback.textContent = messages.error; lock(false); }
  });
  remove.addEventListener("click", async () => {
    if (busy || readOnly || !data.configured) return;
    lock(true);
    try {
      if (!await confirmModal({ title: messages.remove, message: messages.confirmDelete,
        acceptLabel: messages.remove, cancelLabel: messages.cancel, acceptClass: "btn-danger" }) || readOnly) return;
      await request("connection", "DELETE");
      data.configured = false;
      data.autoImportEnabled = false;
      data.offlineDataGranted = false;
      display();
      feedback.textContent = messages.removed;
    } catch { feedback.textContent = messages.error; }
    finally { lock(false); }
  });
  autoImport.addEventListener("change", async () => {
    if (busy || readOnly) { autoImport.checked = Boolean(data.autoImportEnabled); return; }
    const enabled = autoImport.checked;
    lock(true);
    try {
      await request("auto-import", "PUT", { enabled });
      data.autoImportEnabled = enabled;
      feedback.textContent = messages.autoImportSaved;
    } catch { feedback.textContent = messages.error; }
    finally { display(); lock(false); }
  });
  window.addEventListener("profile-account-state", event => {
    readOnly = event.detail !== "active";
    lock(busy);
  });
  lock(true);
  request("status").then(result => { data = result.data; display(); })
    .catch(() => { status.textContent = messages.error; }).finally(() => lock(false));
}
