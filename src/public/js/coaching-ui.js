import { createTranslator, getCurrentLocale } from "./i18n.js";

const t = createTranslator("coachingPage");
const currentLocale = getCurrentLocale();

function formatWeekday(day) {
  const labels = {
    mon: t("days.mon"),
    tue: t("days.tue"),
    wed: t("days.wed"),
    thu: t("days.thu"),
    fri: t("days.fri"),
    sat: t("days.sat"),
    sun: t("days.sun")
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

function formatDistance(km) {
  if (km == null || km === "") {
    return "–";
  }

  return `${Number(km).toFixed(1).replace(/\.0$/, "")} km`;
}

function formatSemanticsValue(value) {
  return value ? String(value) : "–";
}

function translateMappedValue(value) {
  const text = value ? String(value) : "";
  if (!text) {
    return text;
  }
  if (text.startsWith("[Adjusted] ")) {
    const inner = translateMappedValue(text.slice(11));
    return `${t("dynamic.sessionNote.adjustedPrefix")} ${inner}`;
  }
  if (text.includes("|")) {
    const [baseKey, paramKey] = text.split("|");
    const direct = t(`dynamic.${baseKey}`, { terrain: t(`dynamic.${paramKey}`) });
    if (!direct.startsWith("coachingPage.dynamic.")) {
      return direct;
    }
  }
  if (text.includes(".")) {
    const direct = t(`dynamic.${text}`);
    if (!direct.startsWith("coachingPage.dynamic.")) {
      return direct;
    }
  }
  return text;
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function formatStatusLabel(value) {
  const labels = {
    on_track: t("status.onTrack"),
    slightly_off: t("status.slightlyOff"),
    off_track: t("status.offTrack"),
    completed: t("status.completed"),
    mostly_completed: t("status.mostlyCompleted"),
    substituted: t("status.substituted"),
    missed: t("status.missed"),
    extra_unplanned: t("status.extraUnplanned")
  };

  return labels[value] || String(value || "–");
}

function formatStatusClass(value) {
  return String(value || "neutral").replace(/_/g, "-");
}

function renderStatusBadge(value) {
  return `<span class="coaching-status-badge coaching-status-badge--${escapeHtml(formatStatusClass(value))}">${escapeHtml(formatStatusLabel(value))}</span>`;
}

function formatDateTime(value) {
  if (!value) {
    return "–";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(currentLocale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDateOnly(value) {
  if (!value) {
    return "–";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(currentLocale, {
    year: "numeric",
    month: "short",
    day: "2-digit"
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
    this.shellElement = document.getElementById("coaching-shell");
    this.heroElement = document.getElementById("coaching-hero");
    this.planningSurfaceElement = document.getElementById("coaching-planning-surface");
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
    this.hasPreviewInteraction = false;
    this.layoutObserver = null;
    this.layoutMeasureRaf = null;

    this.registerEvents();
    this.syncGoalPanels();
    this.loadContext();
    this.loadLatestPlan();
    this.loadPlanHistory();
    this.initLayoutObservers();
    this.scheduleDesktopLayoutMeasure();
  }

  registerEvents() {
    window.addEventListener("resize", () => this.scheduleDesktopLayoutMeasure());
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
    this.summaryRoot?.addEventListener("click", async (event) => {
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

      const applyAdjustmentButton = event.target.closest("[data-apply-adjustment]");
      if (applyAdjustmentButton) {
        await this.applyAdjustment(Number(applyAdjustmentButton.getAttribute("data-apply-adjustment")));
        return;
      }

      const commentaryButton = event.target.closest("[data-generate-commentary]");
      if (commentaryButton) {
        await this.generateCommentary(Number(commentaryButton.getAttribute("data-generate-commentary")));
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
    });
  }

  initLayoutObservers() {
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observerTargets = [
      document.querySelector(".app-topbar"),
      this.heroElement,
      this.planningSurfaceElement
    ].filter(Boolean);

    if (!observerTargets.length) {
      return;
    }

    this.layoutObserver = new ResizeObserver(() => {
      this.scheduleDesktopLayoutMeasure();
    });

    observerTargets.forEach((target) => this.layoutObserver.observe(target));
  }

  scheduleDesktopLayoutMeasure() {
    if (!this.shellElement || !this.planningSurfaceElement) {
      return;
    }

    if (this.layoutMeasureRaf != null) {
      cancelAnimationFrame(this.layoutMeasureRaf);
    }

    this.layoutMeasureRaf = requestAnimationFrame(() => {
      this.layoutMeasureRaf = null;
      this.updateDesktopLayoutMeasure();
    });
  }

  updateDesktopLayoutMeasure() {
    const shell = this.shellElement;
    const planningSurface = this.planningSurfaceElement;

    if (!shell || !planningSurface) {
      return;
    }

    const isDesktopLike = window.matchMedia("(min-width: 1200px)").matches;
    const rect = planningSurface.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.floor(viewportHeight - rect.bottom - 32);
    const bodyMaxHeight = Math.max(280, Math.min(520, Math.floor(availableHeight / 3)));
    const canUseClientLayout = isDesktopLike && availableHeight >= 960;

    shell.classList.toggle("coaching-shell--client", canUseClientLayout);

    if (!canUseClientLayout) {
      shell.style.removeProperty("--coaching-scroll-body-max-height");
      return;
    }

    shell.style.setProperty("--coaching-scroll-body-max-height", `${bodyMaxHeight}px`);
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
    this.hasPreviewInteraction = true;
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
        throw new Error(json?.error || t("errors.planGeneration"));
      }

      this.lastGeneratedPayload = payload;
      this.renderPlan(json.data);
      this.setSaveEnabled(true);
      this.setStatus(t("statusMessages.previewGenerated"), "info");
    } catch (error) {
      this.setSaveEnabled(false);
      this.summaryRoot.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error.message || t("errors.planGeneration"))}</div>`;
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
        throw new Error(json?.error || t("errors.saveTrainingPlan"));
      }

      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(t("statusMessages.planSaved", { name: json.data?.name || t("history.trainingPlan") }), "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || t("errors.saveTrainingPlan"), "danger");
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
        throw new Error(json?.error || t("errors.loadLatestPlan"));
      }

      if (!json.data) {
        return;
      }

      if (this.hasPreviewInteraction) {
        return;
      }

      this.applyPayloadToForm(json.data.input || {});
      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(t("statusMessages.latestPlanLoaded", { name: json.data?.name || t("history.trainingPlan") }), "secondary");
    } catch (error) {
      this.setStatus(error.message || t("errors.loadLatestPlan"), "warning");
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
        throw new Error(json?.error || t("errors.loadSavedPlans"));
      }

      this.renderPlanHistory(Array.isArray(json.data) ? json.data : []);
    } catch (error) {
      this.historyRoot.innerHTML = `<div class="alert alert-warning mb-0">${escapeHtml(error.message || t("errors.loadSavedPlans"))}</div>`;
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
        throw new Error(json?.error || t("errors.loadSavedPlan"));
      }

      this.applyPayloadToForm(json.data.input || {});
      this.renderPlan(json.data);
      this.setSaveEnabled(false);
      this.setStatus(t("statusMessages.planLoaded", { name: json.data?.name || t("history.trainingPlan") }), "secondary");
    } catch (error) {
      this.setStatus(error.message || t("errors.loadSavedPlan"), "warning");
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
        throw new Error(json?.error || t("errors.loadContext"));
      }

      this.renderContext(json.data);
    } catch (error) {
      this.contextRoot.innerHTML = `<div class="alert alert-warning mb-0">${escapeHtml(error.message || t("errors.loadContext"))}</div>`;
    }
  }

  setSubmitting(isSubmitting) {
    if (!this.generateButton) {
      return;
    }

    this.generateButton.disabled = isSubmitting;
    this.generateButton.textContent = isSubmitting ? t("actions.generating") : t("actions.generatePlan");
  }

  setSaveSubmitting(isSubmitting) {
    if (!this.saveButton) {
      return;
    }

    this.saveButton.disabled = isSubmitting || !this.lastGeneratedPayload;
    this.saveButton.textContent = isSubmitting ? t("actions.saving") : t("actions.savePlan");
  }

  setSaveEnabled(isEnabled) {
    if (!this.saveButton) {
      return;
    }

    this.saveButton.disabled = !isEnabled;
    this.saveButton.textContent = t("actions.savePlan");
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
    const localizedGoal = translateMappedValue(summary.goal);
    const planName = data?.name || localizedGoal || t("history.trainingPlan");

    this.summaryRoot.innerHTML = `
      <div class="coaching-result-summary">
        <div class="coaching-result-summary__chips">
          ${this.renderPlanNameChip(planName)}
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.goal"))}</strong><span>${escapeHtml(localizedGoal || t("history.trainingPlan"))}</span></span>
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.weeklyHours"))}</strong><span>${escapeHtml(String(summary.weeklyHours || "–"))} h</span></span>
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.start"))}</strong><span>${escapeHtml(summary.planStartDate ? formatDateOnly(summary.planStartDate) : "–")}</span></span>
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.days"))}</strong><span>${escapeHtml((summary.availableDays || []).map(formatWeekday).join(" · ") || "–")}</span></span>
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.horizon"))}</strong><span>${escapeHtml(String(summary.planHorizonWeeks || "–"))} ${escapeHtml(t("history.weeks"))}</span></span>
          <span class="coaching-result-chip"><strong>${escapeHtml(t("summary.dataMode"))}</strong><span>${escapeHtml(summary.athleteDataMode === "historical" ? t("summary.historicalProfile") : t("summary.currentAthlete"))}</span></span>
          ${summary.planningSignals ? `<span class="coaching-result-chip"><strong>TSB</strong><span>${escapeHtml(String(summary.planningSignals.currentTsb ?? "–"))}</span></span>` : ""}
          ${this.currentPlan?.id ? `<span class="coaching-result-chip"><button class="btn btn-sm btn-outline-primary rounded-pill px-3" type="button" data-review-plan>${escapeHtml(t("actions.reviewPlan"))}</button></span>` : ""}
        </div>
      </div>
    `;

    this.resultRoot.innerHTML = weeks.map((week) => `
      <article class="coaching-week-card">
        <header class="coaching-week-card__header">
          <div>
            <div class="coaching-week-card__eyebrow">${escapeHtml(t("history.week"))} ${escapeHtml(String(week.weekNumber))}</div>
            <h3 class="coaching-week-card__title">${escapeHtml(translateMappedValue(week.theme) || t("history.trainingWeek"))}</h3>
            ${week.review ? `
              <div class="coaching-week-card__review-row">
                ${renderStatusBadge(week.review.status)}
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.completion"))}</strong><span>${escapeHtml(formatPercent(week.review.completionRate || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.missed"))}</strong><span>${escapeHtml(String(week.review.missedCount || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.extra"))}</strong><span>${escapeHtml(String(week.review.extraUnplannedCount || 0))}</span></span>
              </div>
            ` : ""}
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
      return `<span class="coaching-result-chip"><strong>${escapeHtml(t("summary.plan"))}</strong><span>${escapeHtml(planName)}</span></span>`;
    }

    if (!this.editingPlanName) {
      return `
        <span class="coaching-result-chip">
          <strong>${escapeHtml(t("summary.plan"))}</strong>
          <span>${escapeHtml(planName)}</span>
          <button class="btn btn-sm btn-link p-0 text-decoration-none" type="button" data-edit-plan-name>${escapeHtml(t("actions.edit"))}</button>
        </span>
      `;
    }

    return `
      <span class="coaching-result-chip">
        <strong>${escapeHtml(t("summary.plan"))}</strong>
        <input class="form-control form-control-sm" id="coaching-plan-name-input" type="text" value="${escapeHtml(planName)}" style="min-width: 16rem;">
        <button class="btn btn-sm btn-link p-0 text-decoration-none" type="button" data-save-plan-name>${escapeHtml(t("actions.save"))}</button>
        <button class="btn btn-sm btn-link p-0 text-decoration-none text-secondary" type="button" data-cancel-plan-name>${escapeHtml(t("actions.cancel"))}</button>
      </span>
    `;
  }

  renderWeekActionButtons(weekNumber) {
    if (this.editingWeekNumber === Number(weekNumber)) {
      return `
        <button class="btn btn-sm btn-primary rounded-pill px-3" type="button" data-save-week="${escapeHtml(String(weekNumber))}">${escapeHtml(t("actions.saveWeek"))}</button>
        <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-cancel-week="${escapeHtml(String(weekNumber))}">${escapeHtml(t("actions.cancel"))}</button>
      `;
    }

    return `
      <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-edit-week="${escapeHtml(String(weekNumber))}">${escapeHtml(t("actions.editWeek"))}</button>
      <button class="btn btn-sm btn-outline-primary rounded-pill px-3" type="button" data-regenerate-week="${escapeHtml(String(weekNumber))}">${escapeHtml(t("actions.regenerate"))}</button>
    `;
  }

  renderReadOnlyWeek(week) {
    return `
      <div class="coaching-week-card__sessions">
        ${week.review ? `
          <div class="coaching-session-card coaching-session-card--full">
            <div class="coaching-session-card__body coaching-review-panel">
              <div class="d-flex flex-wrap align-items-center gap-2">
                <div class="coaching-session-card__title">${escapeHtml(t("review.weekReview"))}</div>
                ${renderStatusBadge(week.review.status)}
              </div>
              <div class="coaching-review-panel__counts">
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.completion"))}</strong><span>${escapeHtml(formatPercent(week.review.completionRate || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.volume"))}</strong><span>${escapeHtml(formatPercent(week.review.volumeCompliance || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.intensity"))}</strong><span>${escapeHtml(formatPercent(week.review.intensityCompliance || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.objective"))}</strong><span>${escapeHtml(formatPercent(week.review.objectiveCompliance || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.completed"))}</strong><span>${escapeHtml(String(week.review.completedCount || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.mostly"))}</strong><span>${escapeHtml(String(week.review.mostlyCompletedCount || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.substituted"))}</strong><span>${escapeHtml(String(week.review.substitutedCount || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.missed"))}</strong><span>${escapeHtml(String(week.review.missedCount || 0))}</span></span>
                <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.extra"))}</strong><span>${escapeHtml(String(week.review.extraUnplannedCount || 0))}</span></span>
              </div>
              <div class="coaching-review-panel__summary">${escapeHtml(translateMappedValue(week.review.summary) || t("review.noSummary"))}</div>
              ${(week.review.recommendations || []).length ? `
                <div class="coaching-advice-list">
                  <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
                    <div class="coaching-advice-list__title">${escapeHtml(t("review.suggestedNextAdjustment"))}</div>
                    ${this.currentPlan?.id && (this.currentPlan.weeks || []).some((entry) => Number(entry.weekNumber) === Number(week.weekNumber) + 1)
                      ? `<button class="btn btn-sm btn-outline-primary rounded-pill px-3" type="button" data-apply-adjustment="${escapeHtml(String(week.weekNumber))}">${escapeHtml(t("actions.applyAdjustment"))}</button>`
                      : ``}
                  </div>
                  ${(week.review.recommendations || []).map((item) => `
                    <div class="coaching-advice-item coaching-advice-item--${escapeHtml(String(item.severity || "low"))}">
                      <div class="coaching-advice-item__title">${escapeHtml(translateMappedValue(item.title) || t("review.suggestedAdjustment"))}</div>
                      <div class="coaching-session-card__reason">${escapeHtml(translateMappedValue(item.detail) || "")}</div>
                    </div>
                  `).join("")}
                </div>
              ` : ""}
              <div class="coaching-commentary">
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
                  <div class="coaching-commentary__title">${escapeHtml(t("commentary.title"))}</div>
                  ${this.currentPlan?.id
                    ? `<button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-generate-commentary="${escapeHtml(String(week.weekNumber))}">${escapeHtml(week.review.commentary ? t("actions.refreshCommentary") : t("actions.generateCommentary"))}</button>`
                    : ``}
                </div>
                ${week.review.commentary ? this.renderCommentary(week.review.commentary) : `<div class="coaching-session-card__reason">${escapeHtml(t("commentary.noneYet"))}</div>`}
              </div>
              ${(week.extraWorkouts || []).length ? `
                <div class="coaching-extra-list">
                  <div class="coaching-extra-list__title">${escapeHtml(t("review.unplannedWorkouts"))}</div>
                  ${(week.extraWorkouts || []).map((workout) => `
                    <div class="coaching-extra-item">
                      <div class="coaching-extra-item__header">
                        <div class="coaching-extra-item__title">${escapeHtml(t("review.workoutLabel"))} ${escapeHtml(String(workout.workoutId || "–"))} · ${escapeHtml(formatDateOnly(workout.startTime))}</div>
                        ${renderStatusBadge(workout.status)}
                      </div>
                      <div class="coaching-review-panel__counts">
                        <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.duration"))}</strong><span>${escapeHtml(formatDuration(workout.durationHours || 0))}</span></span>
                        <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.distance"))}</strong><span>${escapeHtml(formatDistance(workout.distanceKm))}</span></span>
                        <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.avgPower"))}</strong><span>${escapeHtml(String(workout.avgPower ?? "–"))}</span></span>
                        <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.np"))}</strong><span>${escapeHtml(String(workout.avgNormalizedPower ?? "–"))}</span></span>
                      </div>
                      <div class="coaching-session-card__reason">${escapeHtml(workout.reason || t("review.unplannedReason"))}</div>
                    </div>
                  `).join("")}
                </div>
              ` : ""}
            </div>
          </div>
        ` : ""}
        ${(week.sessions || []).map((session) => `
          <div class="coaching-session-card coaching-session-card--${escapeHtml(session.type || "easy")}">
            <div class="coaching-session-card__day">${escapeHtml(formatWeekday(session.day))}</div>
            <div class="coaching-session-card__body">
              <div class="coaching-session-card__title">${escapeHtml(translateMappedValue(session.title) || t("review.session"))}</div>
              <div class="coaching-session-card__meta">${escapeHtml(formatDuration(session.durationHours || 0))}</div>
              ${session.plannedDate ? `<div class="coaching-session-card__meta"><span><strong>${escapeHtml(t("review.planned"))}</strong> ${escapeHtml(session.plannedDate)}</span></div>` : ""}
              ${session.match ? `
                <div class="coaching-session-card__match">
                  ${renderStatusBadge(session.match.status)}
                  <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.score"))}</strong><span>${escapeHtml(formatPercent(session.match.score || 0))}</span></span>
                  <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.duration"))}</strong><span>${escapeHtml(formatPercent(session.match.durationCompliance || 0))}</span></span>
                  <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.intensity"))}</strong><span>${escapeHtml(formatPercent(session.match.intensityCompliance || 0))}</span></span>
                  <span class="coaching-metric-pill"><strong>${escapeHtml(t("review.objective"))}</strong><span>${escapeHtml(formatPercent(session.match.objectiveCompliance || 0))}</span></span>
                </div>
                ${session.match.reason ? `<div class="coaching-session-card__reason">${escapeHtml(session.match.reason)}</div>` : ""}
              ` : `<div class="coaching-session-card__reason">${escapeHtml(t("review.noSessionReview"))}</div>`}
              <div class="coaching-session-card__meta">
                <span><strong>${escapeHtml(t("review.intensity"))}</strong> ${escapeHtml(translateMappedValue(formatSemanticsValue(session.semantics?.intensity)))}</span>
                <span><strong>${escapeHtml(t("review.objective"))}</strong> ${escapeHtml(translateMappedValue(formatSemanticsValue(session.semantics?.objective)))}</span>
              </div>
              <div class="coaching-session-card__meta">
                <span><strong>${escapeHtml(t("review.zone"))}</strong> ${escapeHtml(formatSemanticsValue(session.semantics?.zone))}</span>
                <span><strong>${escapeHtml(t("review.system"))}</strong> ${escapeHtml(translateMappedValue(formatSemanticsValue(session.semantics?.energySystem)))}</span>
              </div>
              <div class="coaching-session-card__notes">${escapeHtml(translateMappedValue(session.notes) || "")}</div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  renderCommentary(commentary = {}) {
    const highlights = Array.isArray(commentary.highlights) ? commentary.highlights : [];
    const risks = Array.isArray(commentary.risks) ? commentary.risks : [];
    const nextActions = Array.isArray(commentary.next_actions) ? commentary.next_actions : [];

    return `
      <div class="coaching-commentary__section">
        <div class="coaching-commentary__label">${escapeHtml(t("commentary.weekSummary"))}</div>
        <div class="coaching-review-panel__summary">${escapeHtml(commentary.week_summary || t("commentary.noSummary"))}</div>
      </div>
      ${highlights.length ? `
        <div class="coaching-commentary__section">
          <div class="coaching-commentary__label">${escapeHtml(t("commentary.highlights"))}</div>
          <ul class="coaching-commentary__list">
            ${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
      ${risks.length ? `
        <div class="coaching-commentary__section">
          <div class="coaching-commentary__label">${escapeHtml(t("commentary.risks"))}</div>
          <ul class="coaching-commentary__list">
            ${risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
      ${nextActions.length ? `
        <div class="coaching-commentary__section">
          <div class="coaching-commentary__label">${escapeHtml(t("commentary.nextActions"))}</div>
          <ul class="coaching-commentary__list">
            ${nextActions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
      ${commentary.coach_tone ? `
        <div class="coaching-commentary__section">
          <div class="coaching-commentary__label">${escapeHtml(t("commentary.coachTone"))}</div>
          <div class="coaching-session-card__reason">${escapeHtml(commentary.coach_tone)}</div>
        </div>
      ` : ""}
      ${commentary.model ? `<div class="coaching-session-card__reason">${escapeHtml(t("commentary.model"))}: ${escapeHtml(String(commentary.model))}</div>` : ""}
    `;
  }

  renderEditableWeek(week) {
    const weekdayOptions = [
      { value: "mon", label: t("days.mon") },
      { value: "tue", label: t("days.tue") },
      { value: "wed", label: t("days.wed") },
      { value: "thu", label: t("days.thu") },
      { value: "fri", label: t("days.fri") },
      { value: "sat", label: t("days.sat") },
      { value: "sun", label: t("days.sun") }
    ];
    const sessionTypeOptions = [
      { value: "easy", label: t("sessionTypes.easy") },
      { value: "medium", label: t("sessionTypes.medium") },
      { value: "hard", label: t("sessionTypes.hard") },
      { value: "long", label: t("sessionTypes.long") }
    ];

    return `
      <div class="coaching-week-card__sessions coaching-edit-grid" data-week-editor="${escapeHtml(String(week.weekNumber))}">
        <div class="coaching-grid-2">
          <div>
            <label class="coaching-form-label">${escapeHtml(t("editor.weekTheme"))}</label>
            <input class="form-control coaching-form-control" data-week-theme type="text" value="${escapeHtml(week.theme || "")}">
          </div>
          <div>
            <label class="coaching-form-label">${escapeHtml(t("editor.targetHours"))}</label>
            <input class="form-control coaching-form-control" data-week-hours type="number" min="0.25" step="0.25" value="${escapeHtml(String(week.targetHours || 0))}">
          </div>
        </div>
        ${(week.sessions || []).map((session, index) => `
          <section class="coaching-edit-session" data-session-index="${escapeHtml(String(index))}" data-session-id="${escapeHtml(String(session.id || ""))}">
            <div class="coaching-grid-2">
              <div>
                <label class="coaching-form-label">${escapeHtml(t("editor.day"))}</label>
                <select class="form-select coaching-form-select" data-session-day>
                  ${renderOptions(weekdayOptions, session.day)}
                </select>
              </div>
              <div>
                <label class="coaching-form-label">${escapeHtml(t("editor.sessionType"))}</label>
                <select class="form-select coaching-form-select" data-session-type>
                  ${renderOptions(sessionTypeOptions, session.type || "easy")}
                </select>
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">${escapeHtml(t("editor.plannedDate"))}</label>
                <input class="form-control coaching-form-control" type="text" value="${escapeHtml(session.plannedDate || "")}" disabled>
              </div>
              <div>
                <label class="coaching-form-label">${escapeHtml(t("editor.durationHours"))}</label>
                <input class="form-control coaching-form-control" data-session-duration type="number" min="0.25" step="0.25" value="${escapeHtml(String(session.durationHours || 0))}">
              </div>
            </div>
            <div class="mt-2">
              <div>
                <label class="coaching-form-label">${escapeHtml(t("editor.title"))}</label>
                <input class="form-control coaching-form-control" data-session-title type="text" value="${escapeHtml(session.title || "")}">
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">${escapeHtml(t("review.intensity"))}</label>
                <input class="form-control coaching-form-control" data-session-intensity type="text" value="${escapeHtml(session.semantics?.intensity || "")}">
              </div>
              <div>
                <label class="coaching-form-label">${escapeHtml(t("review.zone"))}</label>
                <input class="form-control coaching-form-control" data-session-zone type="text" value="${escapeHtml(session.semantics?.zone || "")}">
              </div>
            </div>
            <div class="coaching-grid-2 mt-2">
              <div>
                <label class="coaching-form-label">${escapeHtml(t("review.objective"))}</label>
                <input class="form-control coaching-form-control" data-session-objective type="text" value="${escapeHtml(session.semantics?.objective || "")}">
              </div>
              <div>
                <label class="coaching-form-label">${escapeHtml(t("review.system"))}</label>
                <input class="form-control coaching-form-control" data-session-system type="text" value="${escapeHtml(session.semantics?.energySystem || "")}">
              </div>
            </div>
            <div class="mt-2">
              <label class="coaching-form-label">${escapeHtml(t("editor.notes"))}</label>
              <textarea class="form-control coaching-form-control" data-session-notes rows="2">${escapeHtml(session.notes || "")}</textarea>
            </div>
            <div class="mt-2 d-flex justify-content-end">
              <button class="btn btn-sm btn-outline-danger rounded-pill px-3" type="button" data-remove-session-index="${escapeHtml(String(index))}" data-remove-session-week="${escapeHtml(String(week.weekNumber))}">${escapeHtml(t("actions.removeSession"))}</button>
            </div>
          </section>
        `).join("")}
        <div class="d-flex justify-content-end">
          <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" type="button" data-add-session="${escapeHtml(String(week.weekNumber))}">${escapeHtml(t("actions.addSession"))}</button>
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
      title: t("editor.newSession"),
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
        throw new Error(json?.error || t("errors.saveWeek"));
      }

      this.editingWeekNumber = null;
      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.weekSaved", { weekNumber }), "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || t("errors.saveWeek"), "danger");
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
        throw new Error(json?.error || t("errors.regenerateWeek"));
      }

      this.editingWeekNumber = null;
      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.weekRegenerated", { weekNumber }), "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || t("errors.regenerateWeek"), "danger");
    }
  }

  async applyAdjustment(weekNumber) {
    if (!this.currentPlan?.id) {
      return;
    }

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/weeks/${encodeURIComponent(weekNumber)}/apply-adjustment`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || t("errors.applyAdjustment"));
      }

      this.editingWeekNumber = null;
      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.adjustmentApplied", { weekNumber, nextWeek: Number(weekNumber) + 1 }), "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || t("errors.applyAdjustment"), "danger");
    }
  }

  async generateCommentary(weekNumber) {
    if (!this.currentPlan?.id) {
      return;
    }

    try {
      const response = await fetch(`/api/coaching/plans/${encodeURIComponent(this.currentPlan.id)}/weeks/${encodeURIComponent(weekNumber)}/commentary`, {
        method: "POST",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || t("errors.generateCommentary"));
      }

      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.commentaryGenerated", { weekNumber }), "success");
    } catch (error) {
      this.setStatus(error.message || t("errors.generateCommentary"), "danger");
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
        throw new Error(json?.error || t("errors.savePlanName"));
      }

      this.editingPlanName = false;
      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.planNameUpdated"), "success");
      await this.loadPlanHistory();
    } catch (error) {
      this.setStatus(error.message || t("errors.savePlanName"), "danger");
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
        throw new Error(json?.error || t("errors.reviewPlan"));
      }

      this.renderPlan(json.data);
      this.setStatus(t("statusMessages.reviewUpdated"), "success");
    } catch (error) {
      this.setStatus(error.message || t("errors.reviewPlan"), "danger");
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
      this.historyRoot.innerHTML = `<p class="coaching-placeholder-copy">${escapeHtml(t("history.empty"))}</p>`;
      return;
    }

    this.historyRoot.innerHTML = `
      <div class="coaching-history-list">
        ${plans.map((plan) => `
          <article class="coaching-history-card">
            <div>
              <h3 class="coaching-history-card__title">${escapeHtml(plan.name || t("history.trainingPlan"))}</h3>
              <div class="coaching-history-card__meta">
                ${escapeHtml(translateMappedValue(plan.summary?.goal) || t("history.trainingPlan"))} ·
                ${escapeHtml(String(plan.weeklyHours ?? "–"))} h ·
                ${escapeHtml(String(plan.planHorizonWeeks || "–"))} ${escapeHtml(t("history.weeks"))} ·
                ${escapeHtml(formatDateTime(plan.createdAt))}
              </div>
            </div>
            <button class="btn btn-outline-secondary btn-sm rounded-pill px-3" type="button" data-plan-id="${escapeHtml(String(plan.id))}">${escapeHtml(t("actions.load"))}</button>
          </article>
        `).join("")}
      </div>
    `;
  }
}
