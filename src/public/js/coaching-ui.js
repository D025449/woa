function formatWeekday(day) {
  const labels = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun"
  };

  return labels[day] || day;
}

function renderOptions(options, selectedValue) {
  return options.map(({ value, label }) => `
    <option value="${escapeHtml(String(value))}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>
  `).join("");
}

function formatDuration(hours) {
  return `${Number(hours).toFixed(2).replace(/\.00$/, "")} h`;
}

function formatSemanticsValue(value) {
  return value ? String(value) : "–";
}

function formatDateTime(value) {
  if (!value) {
    return "–";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default class CoachingUI {
  constructor() {
    this.form = document.getElementById("coaching-form");
    this.generateButton = document.getElementById("coaching-generate-button");
    this.saveButton = document.getElementById("coaching-save-button");
    this.resultRoot = document.getElementById("coaching-plan-result");
    this.summaryRoot = document.getElementById("coaching-plan-summary");
    this.contextRoot = document.getElementById("coaching-user-context");
    this.statusRoot = document.getElementById("coaching-plan-status");
    this.historyRoot = document.getElementById("coaching-plan-history");
    this.goalEventRadio = document.getElementById("goal-event");
    this.goalPowerRadio = document.getElementById("goal-power");
    this.eventPanel = document.getElementById("event-panel");
    this.powerPanel = document.getElementById("power-focus-panel");
    this.lastGeneratedPayload = null;
    this.currentPlan = null;
    this.editingWeekNumber = null;
    this.editingPlanName = false;

    this.registerEvents();
    this.syncGoalPanels();
    this.loadContext();
    this.loadLatestPlan();
    this.loadPlanHistory();
  }

  registerEvents() {
    this.goalEventRadio?.addEventListener("change", () => this.syncGoalPanels());
    this.goalPowerRadio?.addEventListener("change", () => this.syncGoalPanels());
    this.generateButton?.addEventListener("click", async () => {
      await this.generatePlan();
    });
    this.saveButton?.addEventListener("click", async () => {
      await this.savePlan();
    });
    this.historyRoot?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-plan-id]");
      if (!button) {
        return;
      }

      await this.loadPlanById(button.getAttribute("data-plan-id"));
    });
    this.resultRoot?.addEventListener("click", async (event) => {
      const editButton = event.target.closest("[data-edit-week]");
      if (editButton) {
        this.editingWeekNumber = Number(editButton.getAttribute("data-edit-week"));
        this.renderPlan(this.currentPlan);
        return;
      }

      const cancelButton = event.target.closest("[data-cancel-week]");
      if (cancelButton) {
        this.editingWeekNumber = null;
        this.renderPlan(this.currentPlan);
        return;
      }

      const saveButton = event.target.closest("[data-save-week]");
      if (saveButton) {
        await this.saveEditedWeek(Number(saveButton.getAttribute("data-save-week")));
        return;
      }

      const regenerateButton = event.target.closest("[data-regenerate-week]");
      if (regenerateButton) {
        await this.regenerateWeek(Number(regenerateButton.getAttribute("data-regenerate-week")));
        return;
      }

      const addSessionButton = event.target.closest("[data-add-session]");
      if (addSessionButton) {
        this.addSessionToEditingWeek(Number(addSessionButton.getAttribute("data-add-session")));
        return;
      }

      const removeSessionButton = event.target.closest("[data-remove-session-index]");
      if (removeSessionButton) {
        this.removeSessionFromEditingWeek(
          Number(removeSessionButton.getAttribute("data-remove-session-week")),
          Number(removeSessionButton.getAttribute("data-remove-session-index"))
        );
        return;
      }

      const editPlanNameButton = event.target.closest("[data-edit-plan-name]");
      if (editPlanNameButton) {
        this.editingPlanName = true;
        this.renderPlan(this.currentPlan);
        return;
      }

      const cancelPlanNameButton = event.target.closest("[data-cancel-plan-name]");
      if (cancelPlanNameButton) {
        this.editingPlanName = false;
        this.renderPlan(this.currentPlan);
        return;
      }

      const savePlanNameButton = event.target.closest("[data-save-plan-name]");
      if (savePlanNameButton) {
        await this.savePlanName();
        return;
      }

      const reviewPlanButton = event.target.closest("[data-review-plan]");
      if (reviewPlanButton) {
        await this.reviewCurrentPlan();
      }
    });
  }

  syncGoalPanels() {
    const isPower = !!this.goalPowerRadio?.checked;
    this.powerPanel?.classList.toggle("d-none", !isPower);
    this.eventPanel?.classList.toggle("d-none", isPower);
  }

  collectPayload() {
    const formData = new FormData(this.form);

    return {
      primaryGoal: String(formData.get("primaryGoal") || "event"),
      powerFocus: String(formData.get("powerFocus") || "4min"),
      eventDate: String(formData.get("eventDate") || ""),
      eventDuration: String(formData.get("eventDuration") || ""),
      eventDistance: String(formData.get("eventDistance") || ""),
      eventElevation: String(formData.get("eventElevation") || ""),
      terrainProfile: String(formData.get("terrainProfile") || "rolling"),
      hoursPerWeek: String(formData.get("hoursPerWeek") || ""),
      planStartDate: String(formData.get("planStartDate") || ""),
      days: formData.getAll("days").map(String),
      athleteDataMode: String(formData.get("athleteDataMode") || "current"),
      planHorizon: String(formData.get("planHorizon") || "4"),
      planningStyle: String(formData.get("planningStyle") || "balanced"),
      additionalNotes: String(formData.get("additionalNotes") || "")
    };
  }

  applyPayloadToForm(payload = {}) {
    if (!this.form) {
      return;
    }

    const safePayload = {
      primaryGoal: payload.primaryGoal === "power" ? "power" : "event",
      powerFocus: String(payload.powerFocus || "4min"),
      eventDate: String(payload.eventDate || ""),
      eventDuration: String(payload.eventDuration || ""),
      eventDistance: String(payload.eventDistance || ""),
      eventElevation: String(payload.eventElevation || ""),
      terrainProfile: String(payload.terrainProfile || "rolling"),
      hoursPerWeek: String(payload.hoursPerWeek || ""),
      planStartDate: String(payload.planStartDate || ""),
      days: Array.isArray(payload.days) ? payload.days.map(String) : [],
      athleteDataMode: String(payload.athleteDataMode || "current"),
      planHorizon: String(payload.planHorizon || "4"),
      planningStyle: String(payload.planningStyle || "balanced"),
      additionalNotes: String(payload.additionalNotes || "")
    };

    if (this.goalEventRadio && this.goalPowerRadio) {
      this.goalEventRadio.checked = safePayload.primaryGoal !== "power";
      this.goalPowerRadio.checked = safePayload.primaryGoal === "power";
    }

    const setValue = (selector, value) => {
      const element = this.form.querySelector(selector);
      if (element) {
        element.value = value;
      }
    };

    setValue('[name="powerFocus"]', safePayload.powerFocus);
    setValue('[name="eventDate"]', safePayload.eventDate);
    setValue('[name="eventDuration"]', safePayload.eventDuration);
    setValue('[name="eventDistance"]', safePayload.eventDistance);
    setValue('[name="eventElevation"]', safePayload.eventElevation);
    setValue('[name="terrainProfile"]', safePayload.terrainProfile);
    setValue('[name="hoursPerWeek"]', safePayload.hoursPerWeek);
    setValue('[name="planStartDate"]', safePayload.planStartDate);
    setValue('[name="planHorizon"]', safePayload.planHorizon);
    setValue('[name="additionalNotes"]', safePayload.additionalNotes);

    const athleteModeRadio = this.form.querySelector(`[name="athleteDataMode"][value="${CSS.escape(safePayload.athleteDataMode)}"]`);
    if (athleteModeRadio) {
      athleteModeRadio.checked = true;
    }

    const planningStyleRadio = this.form.querySelector(`[name="planningStyle"][value="${CSS.escape(safePayload.planningStyle)}"]`);
    if (planningStyleRadio) {
      planningStyleRadio.checked = true;
    }

    this.form.querySelectorAll('[name="days"]').forEach((checkbox) => {
      checkbox.checked = safePayload.days.includes(String(checkbox.value));
    });

    this.syncGoalPanels();
    this.lastGeneratedPayload = safePayload;
  }

  async generatePlan() {
    if (!this.form || !this.resultRoot || !this.summaryRoot) {
      return;
    }

    const payload = this.collectPayload();
    this.setSubmitting(true);

    try {
      const response = await fetch("/api/coaching/plan-preview", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Plan generation failed");
      }

      this.lastGeneratedPayload = payload;
      this.renderPlan(json.data);
      this.setSaveEnabled(true);
      this.setStatus("Preview generated. Save it if you want to keep this version.", "info");
    } catch (error) {
      this.setSaveEnabled(false);
      this.summaryRoot.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error.message || "Plan generation failed")}</div>`;
      this.resultRoot.innerHTML = "";
    } finally {
      this.setSubmitting(false);
    }
  }

  async savePlan() {
    if (!this.lastGeneratedPayload) {
      return;
    }

    this.setSaveSubmitting(true);

    try {
      const response = await fetch("/api/coaching/plans", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(this.lastGeneratedPayload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Saving training plan failed");
      }

      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(`Plan saved as ${json.data?.name || "Training Plan"}.`, "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || "Saving training plan failed", "danger");
    } finally {
      this.setSaveSubmitting(false);
    }
  }

  async loadLatestPlan() {
    if (!this.summaryRoot || !this.resultRoot) {
      return;
    }

    try {
      const response = await fetch("/api/coaching/plans/latest", {
        credentials: "include"
      });

      if (response.status === 401) {
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Failed to load latest plan");
      }

      if (!json.data) {
        return;
      }

      this.applyPayloadToForm(json.data.input || {});
      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(`Loaded latest saved plan: ${json.data?.name || "Training Plan"}.`, "secondary");
    } catch (error) {
      this.setStatus(error.message || "Failed to load latest plan", "warning");
    }
  }

  async loadPlanHistory() {
    if (!this.historyRoot) {
      return;
    }

    try {
      const response = await fetch("/api/coaching/plans?limit=10", {
        credentials: "include"
      });

      if (response.status === 401) {
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Failed to load saved plans");
      }

      this.renderPlanHistory(Array.isArray(json.data) ? json.data : []);
    } catch (error) {
      this.historyRoot.innerHTML = `<div class="alert alert-warning mb-0">${escapeHtml(error.message || "Failed to load saved plans")}</div>`;
    }
  }

  async loadPlanById(planId) {
    if (!planId) {
      return;
    }

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(planId)}`, {
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Failed to load saved plan");
      }

      this.applyPayloadToForm(json.data.input || {});
      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(`Loaded saved plan: ${json.data?.name || "Training Plan"}.`, "secondary");
    } catch (error) {
      this.setStatus(error.message || "Failed to load saved plan", "warning");
    }
  }

  async loadContext() {
    if (!this.contextRoot) {
      return;
    }

    try {
      const response = await fetch("/api/coaching/context", {
        credentials: "include"
      });

      if (response.status === 401) {
        return;
      }

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error || "Failed to load context");
      }

      this.renderContext(json.data);
    } catch (error) {
      this.contextRoot.innerHTML = `<div class="alert alert-warning mb-0">${escapeHtml(error.message || "Failed to load context")}</div>`;
    }
  }

  setSubmitting(isSubmitting) {
    if (!this.generateButton) {
      return;
    }

    this.generateButton.disabled = isSubmitting;
    this.generateButton.textContent = isSubmitting ? "Generating..." : "Generate Plan";
  }

  setSaveSubmitting(isSubmitting) {
    if (!this.saveButton) {
      return;
    }

    this.saveButton.disabled = isSubmitting || !this.lastGeneratedPayload;
    this.saveButton.textContent = isSubmitting ? "Saving..." : "Save Plan";
  }

  setSaveEnabled(isEnabled) {
    if (!this.saveButton) {
      return;
    }

    this.saveButton.disabled = !isEnabled;
    this.saveButton.textContent = "Save Plan";
  }

  setStatus(message, variant = "secondary") {
    if (!this.statusRoot) {
      return;
    }

    if (!message) {
      this.statusRoot.innerHTML = "";
      return;
    }

    this.statusRoot.innerHTML = `<div class="alert alert-${escapeHtml(variant)} mb-0">${escapeHtml(message)}</div>`;
  }

  renderPlan(data) {
    this.currentPlan = data || null;
    const summary = data?.summary || {};
    const weeks = Array.isArray(data?.weeks) ? data.weeks : [];
    const planName = data?.name || summary.goal || "Training plan";

    this.summaryRoot.innerHTML = `
      <div class="coaching-result-summary">
        <div class="coaching-result-summary__chips">
          ${this.renderPlanNameChip(planName)}
          <span class="coaching-result-chip"><strong>Goal</strong><span>${escapeHtml(summary.goal || "Training plan")}</span></span>
          <span class="coaching-result-chip"><strong>Weekly Hours</strong><span>${escapeHtml(String(summary.weeklyHours || "–"))} h</span></span>
          <span class="coaching-result-chip"><strong>Start</strong><span>${escapeHtml(String(summary.planStartDate || "–"))}</span></span>
          <span class="coaching-result-chip"><strong>Days</strong><span>${escapeHtml((summary.availableDays || []).map(formatWeekday).join(" · ") || "–")}</span></span>
          <span class="coaching-result-chip"><strong>Horizon</strong><span>${escapeHtml(String(summary.planHorizonWeeks || "–"))} weeks</span></span>
          <span class="coaching-result-chip"><strong>Data Mode</strong><span>${escapeHtml(summary.athleteDataMode === "historical" ? "Historical profile" : "Current athlete")}</span></span>
          ${summary.planningSignals ? `<span class="coaching-result-chip"><strong>TSB</strong><span>${escapeHtml(String(summary.planningSignals.currentTsb ?? "–"))}</span></span>` : ""}
          ${this.currentPlan?.id ? `<span class="coaching-result-chip"><button class="btn btn-sm btn-outline-primary rounded-pill px-3" type="button" data-review-plan>Review Plan</button></span>` : ""}
        </div>
      </div>
    `;

    this.resultRoot.innerHTML = weeks.map((week) => `
      <article class="coaching-week-card">
        <header class="coaching-week-card__header">
          <div>
            <div class="coaching-week-card__eyebrow">Week ${escapeHtml(String(week.weekNumber))}</div>
            <h3 class="coaching-week-card__title">${escapeHtml(week.theme || "Training Week")}</h3>
            ${week.review ? `<div class="coaching-session-card__meta"><span><strong>Status</strong> ${escapeHtml(week.review.status)}</span><span><strong>Completion</strong> ${escapeHtml(`${Math.round((week.review.completionRate || 0) * 100)}%`)}</span></div>` : ""}
          </div>
          <div class="coaching-week-actions">
            <div class="coaching-week-card__hours">${escapeHtml(formatDuration(week.targetHours || 0))}</div>
            ${data?.id ? this.renderWeekActionButtons(week.weekNumber) : ""}
          </div>
        </header>
        ${this.editingWeekNumber === Number(week.weekNumber)
          ? this.renderEditableWeek(week)
          : this.renderReadOnlyWeek(week)}
      </article>
    `).join("");
  }

  renderPlanNameChip(planName) {
    if (!this.currentPlan?.id) {
      return `<span class="coaching-result-chip"><strong>Plan</strong><span>${escapeHtml(planName)}</span></span>`;
    }

    if (!this.editingPlanName) {
      return `
        <span class="coaching-result-chip">
          <strong>Plan</strong>
          <span>${escapeHtml(planName)}</span>
          <button class="btn btn-sm btn-link p-0 text-decoration-none" type="button" data-edit-plan-name>Edit</button>
        </span>
      `;
    }

    return `
      <span class="coaching-result-chip">
        <strong>Plan</strong>
        <input class="form-control form-control-sm" id="coaching-plan-name-input" type="text" value="${escapeHtml(planName)}" style="min-width: 16rem;">
        <button class="btn btn-sm btn-link p-0 text-decoration-none" type="button" data-save-plan-name>Save</button>
        <button class="btn btn-sm btn-link p-0 text-decoration-none text-secondary" type="button" data-cancel-plan-name>Cancel</button>
      </span>
    `;
  }

  renderWeekActionButtons(weekNumber) {
    if (this.editingWeekNumber === Number(weekNumber)) {
      return `
        <button class="btn btn-sm btn-primary rounded-pill px-3" type="button" data-save-week="${escapeHtml(String(weekNumber))}">Save Week</button>
        <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-cancel-week="${escapeHtml(String(weekNumber))}">Cancel</button>
      `;
    }

    return `
      <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-edit-week="${escapeHtml(String(weekNumber))}">Edit Week</button>
      <button class="btn btn-sm btn-outline-primary rounded-pill px-3" type="button" data-regenerate-week="${escapeHtml(String(weekNumber))}">Regenerate</button>
    `;
  }

  renderReadOnlyWeek(week) {
    return `
      <div class="coaching-week-card__sessions">
        ${week.review ? `<div class="coaching-session-card"><div class="coaching-session-card__body"><div class="coaching-session-card__title">Week Review</div><div class="coaching-session-card__meta"><span><strong>Volume</strong> ${escapeHtml(`${Math.round((week.review.volumeCompliance || 0) * 100)}%`)}</span><span><strong>Intensity</strong> ${escapeHtml(`${Math.round((week.review.intensityCompliance || 0) * 100)}%`)}</span><span><strong>Objective</strong> ${escapeHtml(`${Math.round((week.review.objectiveCompliance || 0) * 100)}%`)}</span></div><div class="coaching-session-card__notes">${escapeHtml(week.review.summary || "")}</div></div></div>` : ""}
        ${(week.sessions || []).map((session) => `
          <div class="coaching-session-card coaching-session-card--${escapeHtml(session.type || "easy")}">
            <div class="coaching-session-card__day">${escapeHtml(formatWeekday(session.day))}</div>
            <div class="coaching-session-card__body">
              <div class="coaching-session-card__title">${escapeHtml(session.title || "Session")}</div>
              <div class="coaching-session-card__meta">${escapeHtml(formatDuration(session.durationHours || 0))}</div>
              ${session.match ? `<div class="coaching-session-card__meta"><span><strong>Match</strong> ${escapeHtml(session.match.status || "–")}</span><span><strong>Score</strong> ${escapeHtml(`${Math.round((Number(session.match.score || 0)) * 100)}%`)}</span></div>` : ""}
              <div class="coaching-session-card__meta">
                <span><strong>Intensity</strong> ${escapeHtml(formatSemanticsValue(session.semantics?.intensity))}</span>
                <span><strong>Objective</strong> ${escapeHtml(formatSemanticsValue(session.semantics?.objective))}</span>
              </div>
              <div class="coaching-session-card__meta">
                <span><strong>Zone</strong> ${escapeHtml(formatSemanticsValue(session.semantics?.zone))}</span>
                <span><strong>System</strong> ${escapeHtml(formatSemanticsValue(session.semantics?.energySystem))}</span>
              </div>
              <div class="coaching-session-card__notes">${escapeHtml(session.notes || "")}</div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  renderEditableWeek(week) {
    const weekdayOptions = [
      { value: "mon", label: "Mon" },
      { value: "tue", label: "Tue" },
      { value: "wed", label: "Wed" },
      { value: "thu", label: "Thu" },
      { value: "fri", label: "Fri" },
      { value: "sat", label: "Sat" },
      { value: "sun", label: "Sun" }
    ];
    const sessionTypeOptions = [
      { value: "easy", label: "Easy" },
      { value: "medium", label: "Medium" },
      { value: "hard", label: "Hard" },
      { value: "long", label: "Long" }
    ];

    return `
      <div class="coaching-week-card__sessions coaching-edit-grid" data-week-editor="${escapeHtml(String(week.weekNumber))}">
        <div class="coaching-grid-2">
          <div>
            <label class="coaching-form-label">Week Theme</label>
            <input class="form-control coaching-form-control" data-week-theme type="text" value="${escapeHtml(week.theme || "")}">
          </div>
          <div>
            <label class="coaching-form-label">Target Hours</label>
            <input class="form-control coaching-form-control" data-week-hours type="number" min="0.25" step="0.25" value="${escapeHtml(String(week.targetHours || 0))}">
          </div>
        </div>
        ${(week.sessions || []).map((session, index) => `
          <section class="coaching-edit-session" data-session-index="${escapeHtml(String(index))}" data-session-id="${escapeHtml(String(session.id || ""))}">
            <div class="coaching-grid-2">
              <div>
                <label class="coaching-form-label">Day</label>
                <select class="form-select coaching-form-select" data-session-day>
                  ${renderOptions(weekdayOptions, session.day)}
                </select>
              </div>
              <div>
                <label class="coaching-form-label">Session Type</label>
                <select class="form-select coaching-form-select" data-session-type>
                  ${renderOptions(sessionTypeOptions, session.type || "easy")}
                </select>
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">Duration (h)</label>
                <input class="form-control coaching-form-control" data-session-duration type="number" min="0.25" step="0.25" value="${escapeHtml(String(session.durationHours || 0))}">
              </div>
              <div>
                <label class="coaching-form-label">Title</label>
                <input class="form-control coaching-form-control" data-session-title type="text" value="${escapeHtml(session.title || "")}">
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">Intensity</label>
                <input class="form-control coaching-form-control" data-session-intensity type="text" value="${escapeHtml(session.semantics?.intensity || "")}">
              </div>
              <div>
                <label class="coaching-form-label">Zone</label>
                <input class="form-control coaching-form-control" data-session-zone type="text" value="${escapeHtml(session.semantics?.zone || "")}">
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">Objective</label>
                <input class="form-control coaching-form-control" data-session-objective type="text" value="${escapeHtml(session.semantics?.objective || "")}">
              </div>
              <div>
                <label class="coaching-form-label">System</label>
                <input class="form-control coaching-form-control" data-session-system type="text" value="${escapeHtml(session.semantics?.energySystem || "")}">
              </div>
            </div>
            <div class="mt-2">
              <label class="coaching-form-label">Notes</label>
              <textarea class="form-control coaching-form-control" data-session-notes rows="2">${escapeHtml(session.notes || "")}</textarea>
            </div>
            <div class="mt-2 d-flex justify-content-end">
              <button class="btn btn-sm btn-outline-danger rounded-pill px-3" type="button" data-remove-session-index="${escapeHtml(String(index))}" data-remove-session-week="${escapeHtml(String(week.weekNumber))}">Remove Session</button>
            </div>
          </section>
        `).join("")}
        <div class="d-flex justify-content-end">
          <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-add-session="${escapeHtml(String(week.weekNumber))}">Add Session</button>
        </div>
      </div>
    `;
  }

  addSessionToEditingWeek(weekNumber) {
    if (!this.currentPlan?.weeks) {
      return;
    }

    const week = this.currentPlan.weeks.find((entry) => Number(entry.weekNumber) === Number(weekNumber));
    if (!week) {
      return;
    }

    week.sessions = Array.isArray(week.sessions) ? week.sessions : [];
    week.sessions.push({
      id: null,
      day: "tue",
      type: "easy",
      title: "New Session",
      durationHours: 1,
      notes: "",
      semantics: {
        intensity: "low",
        objective: "",
        zone: "Z1-Z2",
        energySystem: ""
      }
    });

    this.renderPlan(this.currentPlan);
  }

  removeSessionFromEditingWeek(weekNumber, sessionIndex) {
    if (!this.currentPlan?.weeks) {
      return;
    }

    const week = this.currentPlan.weeks.find((entry) => Number(entry.weekNumber) === Number(weekNumber));
    if (!week || !Array.isArray(week.sessions)) {
      return;
    }

    week.sessions.splice(sessionIndex, 1);
    this.renderPlan(this.currentPlan);
  }

  async saveEditedWeek(weekNumber) {
    if (!this.currentPlan?.id || !this.resultRoot) {
      return;
    }

    const editor = this.resultRoot.querySelector(`[data-week-editor="${CSS.escape(String(weekNumber))}"]`);
    if (!editor) {
      return;
    }

    const payload = {
      theme: editor.querySelector("[data-week-theme]")?.value || "",
      targetHours: editor.querySelector("[data-week-hours]")?.value || "",
      sessions: [...editor.querySelectorAll("[data-session-index]")].map((sessionEl) => ({
        id: Number(sessionEl.getAttribute("data-session-id")),
        day: sessionEl.querySelector("[data-session-day]")?.value || "",
        type: sessionEl.querySelector("[data-session-type]")?.value || "easy",
        title: sessionEl.querySelector("[data-session-title]")?.value || "",
        durationHours: sessionEl.querySelector("[data-session-duration]")?.value || "",
        notes: sessionEl.querySelector("[data-session-notes]")?.value || "",
        semantics: {
          intensity: sessionEl.querySelector("[data-session-intensity]")?.value || "",
          objective: sessionEl.querySelector("[data-session-objective]")?.value || "",
          zone: sessionEl.querySelector("[data-session-zone]")?.value || "",
          energySystem: sessionEl.querySelector("[data-session-system]")?.value || ""
        }
      }))
    };

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/weeks/${encodeURIComponent(weekNumber)}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Saving week failed");
      }

      this.editingWeekNumber = null;
      this.renderPlan(json.data);
      this.setStatus(`Week ${weekNumber} saved.`, "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || "Saving week failed", "danger");
    }
  }

  async regenerateWeek(weekNumber) {
    if (!this.currentPlan?.id) {
      return;
    }

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/weeks/${encodeURIComponent(weekNumber)}/regenerate`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Regenerating week failed");
      }

      this.editingWeekNumber = null;
      this.renderPlan(json.data);
      this.setStatus(`Week ${weekNumber} regenerated.`, "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || "Regenerating week failed", "danger");
    }
  }

  async savePlanName() {
    if (!this.currentPlan?.id) {
      return;
    }

    const input = document.getElementById("coaching-plan-name-input");
    const name = input?.value || "";

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/name`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name })
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Saving plan name failed");
      }

      this.editingPlanName = false;
      this.renderPlan(json.data);
      this.setStatus("Plan name updated.", "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || "Saving plan name failed", "danger");
    }
  }

  async reviewCurrentPlan() {
    if (!this.currentPlan?.id) {
      return;
    }

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/review`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Reviewing plan failed");
      }

      this.renderPlan(json.data);
      this.setStatus("Plan review updated from actual workouts.", "success");
    } catch (error) {
      this.setStatus(error.message || "Reviewing plan failed", "danger");
    }
  }

  renderContext(context) {
    if (!this.contextRoot) {
      return;
    }

    const load = context?.latestLoad || {};
    const ftp = context?.latestFtp || {};
    const volume = context?.recentVolume || {};

    this.contextRoot.innerHTML = `
      <div class="coaching-result-summary__chips">
        <span class="coaching-result-chip"><strong>CTL</strong><span>${escapeHtml(String(load.ctl ?? "–"))}</span></span>
        <span class="coaching-result-chip"><strong>ATL</strong><span>${escapeHtml(String(load.atl ?? "–"))}</span></span>
        <span class="coaching-result-chip"><strong>TSB</strong><span>${escapeHtml(String(load.tsb ?? "–"))}</span></span>
        <span class="coaching-result-chip"><strong>FTP</strong><span>${escapeHtml(String(ftp.ftp ?? "–"))} W</span></span>
        <span class="coaching-result-chip"><strong>7d</strong><span>${escapeHtml(String(volume.hours7d ?? "–"))} h</span></span>
        <span class="coaching-result-chip"><strong>28d</strong><span>${escapeHtml(String(volume.hours28d ?? "–"))} h</span></span>
      </div>
    `;
  }

  renderPlanHistory(plans) {
    if (!this.historyRoot) {
      return;
    }

    if (!plans.length) {
      this.historyRoot.innerHTML = `<p class="coaching-placeholder-copy">No saved plans yet.</p>`;
      return;
    }

    this.historyRoot.innerHTML = `
      <div class="coaching-history-list">
        ${plans.map((plan) => `
          <article class="coaching-history-card">
            <div>
              <h3 class="coaching-history-card__title">${escapeHtml(plan.name || "Training Plan")}</h3>
              <div class="coaching-history-card__meta">
                ${escapeHtml(plan.summary?.goal || "Training plan")} ·
                ${escapeHtml(String(plan.weeklyHours ?? "–"))} h ·
                ${escapeHtml(String(plan.planHorizonWeeks || "–"))} weeks ·
                ${escapeHtml(formatDateTime(plan.createdAt))}
              </div>
            </div>
            <button class="btn btn-outline-secondary btn-sm rounded-pill px-3" type="button" data-plan-id="${escapeHtml(String(plan.id))}">Load</button>
          </article>
        `).join("")}
      </div>
    `;
  }
}
