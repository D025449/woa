import confirmModal from "./confirm-modal.js";

const form = document.getElementById("garmin-settings-form");
if (form) {
  const messages = JSON.parse(document.getElementById("garmin-settings-messages").textContent);
  const input = document.getElementById("garmin-api-key");
  const status = document.getElementById("garmin-settings-status");
  const feedback = document.getElementById("garmin-settings-feedback");
  const remove = document.getElementById("garmin-key-remove");
  let configured = false;
  let readOnly = true;
  let busy = false;

  function lock(value) {
    busy = value;
    for (const element of form.elements) element.disabled = busy || readOnly;
    remove.disabled = busy || readOnly || !configured;
  }

  function display(data) {
    configured = data.configured;
    status.textContent = configured ? messages.configured : messages.empty;
  }

  async function request(options = {}) {
    const response = await fetch("/api/profile/garmin", {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json" }
    });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 503 ? messages.unavailable : messages.error);
    return result.data;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || readOnly) return;
    lock(true);
    feedback.textContent = "";
    try {
      const data = await request({ method: "PUT", body: JSON.stringify({ apiKey: input.value }) });
      input.value = "";
      display(data);
      feedback.textContent = messages.saved;
    } catch (error) { feedback.textContent = error.message; }
    finally { lock(false); }
  });

  remove.addEventListener("click", async () => {
    if (busy || readOnly || !configured) return;
    lock(true);
    try {
      const accepted = await confirmModal({ title: messages.remove, message: messages.confirmDelete,
        acceptLabel: messages.remove, cancelLabel: messages.cancel, acceptClass: "btn-danger" });
      if (!accepted || readOnly) return;
      await request({ method: "DELETE" });
      input.value = "";
      display({ configured: false });
      feedback.textContent = messages.removed;
    } catch (error) { feedback.textContent = error.message; }
    finally { lock(false); }
  });

  window.addEventListener("profile-account-state", event => {
    readOnly = event.detail !== "active";
    lock(busy);
  });
  lock(true);
  request().then(display).catch(() => { status.textContent = messages.error; }).finally(() => lock(false));
}
