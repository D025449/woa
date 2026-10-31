import confirmModal from "./confirm-modal.js";

const connect = document.getElementById("wahoo-connect");
if (connect) {
  const messages = JSON.parse(document.getElementById("wahoo-settings-messages").textContent);
  const remove = document.getElementById("wahoo-remove");
  const status = document.getElementById("wahoo-status");
  const feedback = document.getElementById("wahoo-feedback");
  let data = { configured: false, available: false };
  let readOnly = true;
  let busy = false;
  function lock(value) {
    busy = value;
    connect.disabled = busy || readOnly || !data.available || data.configured;
    remove.disabled = busy || readOnly || !data.configured;
  }
  async function request(path, method = "GET") {
    const response = await fetch(`/auth/wahoo/${path}`, { method, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(messages.error);
    return response.status === 204 ? null : response.json();
  }
  function display() {
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
      display();
      feedback.textContent = messages.removed;
    } catch { feedback.textContent = messages.error; }
    finally { lock(false); }
  });
  window.addEventListener("profile-account-state", event => {
    readOnly = event.detail !== "active";
    lock(busy);
  });
  lock(true);
  request("status").then(result => { data = result.data; display(); })
    .catch(() => { status.textContent = messages.error; }).finally(() => lock(false));
}
