import confirmModal from "./confirm-modal.js";

const form = document.getElementById("weight-history-form");
if (form) {
  const messages = JSON.parse(document.getElementById("weight-history-messages").textContent);
  const list = document.getElementById("weight-history-list");
  const status = document.getElementById("weight-history-status");
  const dateInput = form.elements.namedItem("validFrom");
  const weightInput = form.elements.namedItem("weightKg");
  const cancel = document.getElementById("weight-history-cancel");
  let editingId = null;
  let busy = false;
  let readOnly = true;

  function markEditing() {
    list.querySelectorAll("[data-weight-id]").forEach(row => {
      row.classList.toggle("is-editing", row.dataset.weightId === editingId);
    });
  }

  function reset() {
    editingId = null;
    markEditing();
    form.reset();
    const now = new Date();
    dateInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    cancel.hidden = true;
  }

  function lock(value) {
    busy = value;
    for (const element of form.elements) element.disabled = value || readOnly;
    list.querySelectorAll("button").forEach(button => { button.disabled = value || readOnly; });
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/profile/weight-history${path}`, {
      credentials: "include", ...options,
      headers: { "Content-Type": "application/json" }
    });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || messages.error);
    return result.data;
  }

  async function load() {
    const entries = await request();
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "profile-weight-empty";
      empty.textContent = messages.empty;
      list.append(empty);
    }
    const locale = messages.locale || navigator.language;
    const numbers = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dates = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
    for (const entry of entries) {
      const row = document.createElement("li");
      row.className = "profile-weight-entry";
      row.dataset.weightId = entry.id;
      const identity = document.createElement("div");
      identity.className = "profile-weight-entry__identity";
      const weight = document.createElement("strong");
      weight.className = "profile-weight-entry__weight";
      weight.textContent = `${numbers.format(entry.weightKg)} kg`;
      const validity = document.createElement("div");
      validity.className = "profile-weight-entry__date";
      const date = document.createElement("time");
      date.dateTime = entry.validFrom;
      date.textContent = dates.format(new Date(`${entry.validFrom}T00:00:00Z`));
      validity.append(`${messages.validFrom} `, date);
      identity.append(weight, validity);
      const actions = document.createElement("div");
      actions.className = "profile-weight-entry__actions";
      row.append(identity, actions);
      for (const action of ["edit", "delete"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn btn-sm profile-weight-entry__action${action === "delete" ? " is-delete" : ""}`;
        button.textContent = messages[action];
        button.addEventListener("click", async () => {
          if (busy || readOnly) return;
          if (action === "edit") {
            editingId = entry.id;
            dateInput.value = entry.validFrom;
            weightInput.value = entry.weightKg;
            cancel.hidden = false;
            markEditing();
            dateInput.focus();
            return;
          }
          lock(true);
          const accepted = await confirmModal({
            title: messages.delete,
            message: messages.confirmDelete,
            acceptLabel: messages.delete,
            cancelLabel: messages.cancel,
            acceptClass: "btn-danger"
          });
          if (!accepted || readOnly) { lock(false); return; }
          status.textContent = "";
          try {
            await request(`/${entry.id}`, { method: "DELETE" });
            if (editingId === entry.id) reset();
            await load();
          } catch (error) { status.textContent = error.message; }
          finally { lock(false); }
        });
        actions.append(button);
      }
      list.append(row);
    }
    markEditing();
  }

  cancel.addEventListener("click", reset);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || readOnly) return;
    lock(true);
    status.textContent = "";
    try {
      await request(editingId ? `/${editingId}` : "", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({ validFrom: dateInput.value, weightKg: weightInput.value })
      });
      reset();
      await load();
      status.textContent = messages.saved;
    } catch (error) { status.textContent = error.message; }
    finally { lock(false); }
  });
  window.addEventListener("profile-account-state", event => {
    readOnly = event.detail !== "active";
    lock(busy);
  });
  reset();
  lock(true);
  load().catch(error => { status.textContent = error.message; }).finally(() => lock(false));
}
