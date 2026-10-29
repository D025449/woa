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

  function reset() {
    editingId = null;
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
    if (!entries.length) list.textContent = messages.empty;
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "d-flex gap-2 align-items-center flex-wrap mb-2";
      const text = document.createElement("span");
      text.textContent = `${entry.validFrom} · ${entry.weightKg} kg`;
      row.append(text);
      for (const action of ["edit", "delete"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-sm btn-outline-secondary";
        button.textContent = messages[action];
        button.addEventListener("click", async () => {
          if (busy || readOnly) return;
          if (action === "edit") {
            editingId = entry.id;
            dateInput.value = entry.validFrom;
            weightInput.value = entry.weightKg;
            cancel.hidden = false;
            dateInput.focus();
            return;
          }
          if (!window.confirm(messages.confirmDelete)) return;
          lock(true);
          status.textContent = "";
          try {
            await request(`/${entry.id}`, { method: "DELETE" });
            if (editingId === entry.id) reset();
            await load();
          } catch (error) { status.textContent = error.message; }
          finally { lock(false); }
        });
        row.append(button);
      }
      list.append(row);
    }
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
