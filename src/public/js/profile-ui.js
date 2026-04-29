class ProfileUI {
  constructor() {
    this.messages = window.profileMessages || {};
    this.form = document.getElementById("profile-form");
    this.submitButton = document.getElementById("profile-submit");
    this.errorEl = document.getElementById("profile-error");
    this.successEl = document.getElementById("profile-success");
    this.paymentsErrorEl = document.getElementById("profile-payments-error");
    this.paymentsInfoEl = document.getElementById("profile-payments-info");
    this.membershipSummaryEl = document.getElementById("profile-membership-summary");
    this.usagePanelEl = document.getElementById("profile-usage-panel");
    this.plansGridEl = document.getElementById("profile-plans-grid");
    this.preferencesSaveButton = document.getElementById("profile-save-preferences");
    this.plans = [];
    this.membership = null;
    this.usage = null;
    this.currentLanguage = "en";

    this.registerEvents();
    this.boot();
  }

  registerEvents() {
    this.form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.save();
    });

    this.preferencesSaveButton?.addEventListener("click", async () => {
      await this.save();
    });
  }

  async boot() {
    await this.handlePaymentReturnState();
    await this.load();
    await this.loadPlans();
  }

  async load() {
    this.setLoading(true, this.t("loading", "Loading ..."));
    this.hideProfileMessages();

    try {
      const response = await fetch("/api/profile", {
        method: "GET",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed to load profile (${response.status})`);
      }

      this.fillForm(result.data || {});
    } catch (err) {
      console.error(err);
      this.showError(err.message || this.t("loadProfileError", "Could not load profile."));
    } finally {
      this.setLoading(false, this.t("save", "Save"));
    }
  }

  fillForm(data) {
    const setValue = (name, value) => {
      const input = this.form?.elements?.[name];
      if (input) {
        input.value = value ?? "";
      }
    };

    setValue("displayName", data.displayName);
    setValue("email", data.email);
    setValue("phone", data.phone);
    setValue("dateOfBirth", data.dateOfBirth);
    setValue("weightKg", data.weightKg);
    setValue("heightCm", data.heightCm);
    setValue("addressLine1", data.addressLine1);
    setValue("addressLine2", data.addressLine2);
    setValue("postalCode", data.postalCode);
    setValue("city", data.city);
    setValue("country", data.country);

    const setSelect = (id, value, fallback = "") => {
      const element = document.getElementById(id);
      if (element) {
        element.value = value || fallback;
      }
    };

    setSelect("profile-language", data.language, "en");
    setSelect("profile-distance-unit", data.distanceUnit, "km");
    setSelect("profile-speed-unit", data.speedUnit, "kmh");
    setSelect("profile-default-workout-scope", data.defaultWorkoutScope, "mine");

    this.currentLanguage = String(data.language || "en").toLowerCase();
  }

  async save() {
    if (!this.form) {
      return;
    }

    this.setLoading(true, this.t("saving", "Saving ..."));
    this.hideProfileMessages();

    const formData = new FormData(this.form);
    const payload = {
      displayName: String(formData.get("displayName") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      dateOfBirth: String(formData.get("dateOfBirth") || "").trim(),
      weightKg: String(formData.get("weightKg") || "").trim(),
      heightCm: String(formData.get("heightCm") || "").trim(),
      addressLine1: String(formData.get("addressLine1") || "").trim(),
      addressLine2: String(formData.get("addressLine2") || "").trim(),
      postalCode: String(formData.get("postalCode") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      country: String(formData.get("country") || "").trim(),
      language: String(document.getElementById("profile-language")?.value || "en").trim(),
      distanceUnit: String(document.getElementById("profile-distance-unit")?.value || "km").trim(),
      speedUnit: String(document.getElementById("profile-speed-unit")?.value || "kmh").trim(),
      defaultWorkoutScope: String(document.getElementById("profile-default-workout-scope")?.value || "mine").trim()
    };
    const previousLanguage = this.currentLanguage;

    try {
      const response = await fetch("/api/profile", {
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

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed to save profile (${response.status})`);
      }

      this.fillForm(result.data || {});
      this.showSuccess(this.t("profileSaved", "Profile saved."));

      const nextLanguage = String(result.data?.language || payload.language || "en").toLowerCase();
      if (nextLanguage !== previousLanguage) {
        this.showSuccess(this.t("languageUpdatedReloading", "Language updated. Reloading ..."));
        setTimeout(() => {
          window.location.reload();
        }, 250);
      }
    } catch (err) {
      console.error(err);
      this.showError(err.message || this.t("saveProfileError", "Could not save profile."));
    } finally {
      this.setLoading(false, this.t("save", "Save"));
    }
  }

  setLoading(isLoading, label) {
    if (!this.submitButton) {
      return;
    }

    this.submitButton.disabled = isLoading;
    this.submitButton.textContent = label;
  }

  showError(message) {
    if (!this.errorEl) {
      return;
    }

    this.errorEl.textContent = message;
    this.errorEl.classList.remove("d-none");
  }

  showSuccess(message) {
    if (!this.successEl) {
      return;
    }

    this.successEl.textContent = message;
    this.successEl.classList.remove("d-none");
  }

  hideProfileMessages() {
    this.errorEl?.classList.add("d-none");
    this.successEl?.classList.add("d-none");
  }

  showPaymentsError(message) {
    if (!this.paymentsErrorEl) {
      return;
    }
    this.paymentsErrorEl.textContent = message;
    this.paymentsErrorEl.classList.remove("d-none");
  }

  hidePaymentsError() {
    this.paymentsErrorEl?.classList.add("d-none");
  }

  showPaymentsInfo(message) {
    if (!this.paymentsInfoEl) {
      return;
    }
    this.paymentsInfoEl.textContent = message;
    this.paymentsInfoEl.classList.remove("d-none");
  }

  hidePaymentsInfo() {
    this.paymentsInfoEl?.classList.add("d-none");
  }

  updateMembershipSummary() {
    if (!this.membershipSummaryEl) {
      return;
    }

    if (!this.membership?.plan?.name) {
      this.membershipSummaryEl.textContent = this.t("noActiveSubscription", "No active paid subscription.");
      return;
    }

    const end = this.membership.currentPeriodEnd ? new Date(this.membership.currentPeriodEnd) : null;
    const endLabel = end && !Number.isNaN(end.getTime())
      ? end.toLocaleDateString(this.currentLanguage || undefined, { year: "numeric", month: "short", day: "2-digit" })
      : "–";
    const statusPrefix = this.membership.isActive ? this.t("currentPlan", "Current plan") : this.t("expiredPlan", "Expired plan");
    this.membershipSummaryEl.textContent = `${statusPrefix}: ${this.membership.plan.name} (${this.membership.plan.price.toFixed(2)} ${this.membership.plan.currency}) · ${this.t("validUntil", "Valid until")} ${endLabel}`;
  }

  async loadPlans() {
    this.hidePaymentsError();

    try {
      const response = await fetch("/api/payments/plans", {
        method: "GET",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Could not load plans (${response.status})`);
      }

      this.plans = result.data?.plans || [];
      this.membership = result.data?.membership || null;
      this.usage = result.data?.usage || null;
      this.renderPlans();
      this.updateMembershipSummary();
      this.renderUsagePanel();
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || this.t("loadPlansError", "Could not load plans."));
      this.plans = [];
      this.usage = null;
      this.renderPlans();
      this.updateMembershipSummary();
      this.renderUsagePanel();
    }
  }

  renderUsagePanel() {
    if (!this.usagePanelEl) {
      return;
    }

    const items = Array.isArray(this.usage?.items) ? this.usage.items : [];
    if (!items.length) {
      this.usagePanelEl.innerHTML = "";
      return;
    }

    this.usagePanelEl.innerHTML = `
      <div class="small text-muted">${this.t("usageOverview", "Current usage")}</div>
      <div class="profile-usage-grid">
        ${items.map((item) => `
          <div class="profile-usage-card ${item.exceeded ? "is-exceeded" : item.warning ? "is-warning" : ""}">
            <div class="profile-usage-label">${this.escape(item.label || item.featureKey)}</div>
            <div class="profile-usage-meta">${this.escape(String(item.used ?? 0))} / ${this.escape(String(item.limit ?? "–"))} · ${this.escape(item.periodLabel || "")}</div>
            ${item.exceeded
              ? `<div class="profile-usage-warning is-exceeded">${this.t("limitExceeded", "This limit has been exceeded")}</div>`
              : item.warning
                ? `<div class="profile-usage-warning">${this.t("nearLimit", "80% of this limit reached")}</div>`
                : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  renderPlans() {
    if (!this.plansGridEl) {
      return;
    }

    if (!Array.isArray(this.plans) || this.plans.length === 0) {
      this.plansGridEl.innerHTML = `<div class="text-muted">${this.t("noPlansAvailable", "No plans available.")}</div>`;
      return;
    }

    const currentPlanCode = this.membership?.isActive ? (this.membership?.plan?.code || null) : null;

    this.plansGridEl.innerHTML = this.plans.map((plan) => {
      const effectiveCurrentCode = currentPlanCode || "free";
      const isCurrent = effectiveCurrentCode === plan.code;
      const featureList = this.getPlanFeatureList(plan);
      return `
        <article class="profile-plan-card ${isCurrent ? "is-current" : ""}">
          <h3 class="profile-plan-name">${plan.name}</h3>
          <p class="profile-plan-price">${Number(plan.price).toFixed(2)} ${plan.currency}</p>
          <p class="profile-plan-copy">${this.getPlanDescription(plan)}</p>
          <div class="small text-muted mt-2">${this.t("includedLimits", "Included limits")}</div>
          <ul class="profile-plan-features">
            ${featureList.map((line) => `<li>${this.escape(line)}</li>`).join("")}
          </ul>
          <div class="profile-plan-actions">
            <button
              type="button"
              class="btn ${isCurrent ? "btn-outline-secondary" : "btn-dark"} btn-sm"
              data-action="upgrade-plan"
              data-plan-code="${plan.code}"
              ${isCurrent || plan.code === "free" ? "disabled" : ""}>
              ${isCurrent ? this.t("active", "Active") : this.t("upgradeWithPayPal", "Upgrade with PayPal")}
            </button>
          </div>
        </article>
      `;
    }).join("");

    this.plansGridEl.querySelectorAll('[data-action="upgrade-plan"]').forEach((button) => {
      button.addEventListener("click", async () => {
        const planCode = button.getAttribute("data-plan-code");
        if (planCode) {
          await this.startCheckout(planCode, button);
        }
      });
    });
  }

  async startCheckout(planCode, button) {
    this.hidePaymentsError();
    this.hidePaymentsInfo();

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = this.t("starting", "Starting ...");

    try {
      const response = await fetch("/api/payments/checkout/order", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ planCode })
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Could not start checkout (${response.status})`);
      }

      const approvalUrl = result?.data?.approvalUrl;
      if (!approvalUrl) {
        throw new Error(this.t("missingApprovalUrl", "Missing PayPal approvalUrl."));
      }

      window.location.href = approvalUrl;
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || this.t("startCheckoutError", "Could not start PayPal checkout."));
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async handlePaymentReturnState() {
    const params = new URLSearchParams(window.location.search);
    const paymentState = params.get("payment");
    const providerOrderId = params.get("token");

    if (!paymentState) {
      return;
    }

    if (paymentState === "cancel") {
      this.showPaymentsInfo(this.t("checkoutCanceled", "Checkout was canceled."));
      this.stripPaymentQueryParams();
      return;
    }

    if (paymentState !== "success" || !providerOrderId) {
      this.showPaymentsError(this.t("incompleteReturnParameters", "Incomplete PayPal return parameters."));
      this.stripPaymentQueryParams();
      return;
    }

    try {
      const response = await fetch("/api/payments/checkout/capture", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ providerOrderId })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Capture failed (${response.status})`);
      }

      this.showPaymentsInfo(this.t("paymentSuccess", "Payment processed successfully."));
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || this.t("paymentConfirmError", "Could not confirm payment."));
    } finally {
      this.stripPaymentQueryParams();
    }
  }

  stripPaymentQueryParams() {
    const url = new URL(window.location.href);
    url.searchParams.delete("payment");
    url.searchParams.delete("token");
    url.searchParams.delete("PayerID");
    window.history.replaceState({}, "", url.toString());
  }

  t(key, fallback) {
    const value = this.messages?.[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  escape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  getPlanDescription(plan) {
    const code = String(plan?.code || "").toLowerCase();
    if (code === "free") {
      return this.t("starterDescription", "Starter access with limited planning, saved plans, and AI coaching.");
    }
    return plan?.description || "";
  }

  getPlanFeatureList(plan) {
    const limits = plan?.entitlements?.limits || {};
    return [
      `${limits.trainingPlanGenerationPerMonth ?? "–"} ${this.t("featurePlanGenerations", "plan generations / month")}`,
      `${limits.coachCommentaryGenerationPerMonth ?? "–"} ${this.t("featureCoachCommentary", "coach commentary calls / month")}`,
      `${limits.savedPlans ?? "–"} ${this.t("featureSavedPlans", "saved plans")}`,
      `${limits.storedWorkouts ?? "–"} ${this.t("featureStoredWorkouts", "stored workouts")}`
    ];
  }
}

new ProfileUI();
