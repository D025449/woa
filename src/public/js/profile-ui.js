class ProfileUI {
  constructor() {
    this.form = document.getElementById("profile-form");
    this.submitButton = document.getElementById("profile-submit");
    this.errorEl = document.getElementById("profile-error");
    this.successEl = document.getElementById("profile-success");
    this.paymentsErrorEl = document.getElementById("profile-payments-error");
    this.paymentsInfoEl = document.getElementById("profile-payments-info");
    this.membershipSummaryEl = document.getElementById("profile-membership-summary");
    this.plansGridEl = document.getElementById("profile-plans-grid");
    this.plans = [];
    this.membership = null;

    this.registerEvents();
    this.boot();
  }

  registerEvents() {
    this.form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.save();
    });
  }

  async boot() {
    await this.handlePaymentReturnState();
    await this.load();
    await this.loadPlans();
  }

  async load() {
    this.setLoading(true, "Lade ...");
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
      this.showError(err.message || "Profil konnte nicht geladen werden.");
    } finally {
      this.setLoading(false, "Speichern");
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
  }

  async save() {
    if (!this.form) {
      return;
    }

    this.setLoading(true, "Speichere ...");
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
      country: String(formData.get("country") || "").trim()
    };

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
      this.showSuccess("Profil gespeichert.");
    } catch (err) {
      console.error(err);
      this.showError(err.message || "Profil konnte nicht gespeichert werden.");
    } finally {
      this.setLoading(false, "Speichern");
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
      this.membershipSummaryEl.textContent = "Aktuell kein aktives Paid-Abo.";
      return;
    }

    this.membershipSummaryEl.textContent = `Aktueller Plan: ${this.membership.plan.name} (${this.membership.plan.price.toFixed(2)} ${this.membership.plan.currency})`;
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
        throw new Error(result.error || `Plans konnten nicht geladen werden (${response.status})`);
      }

      this.plans = result.data?.plans || [];
      this.membership = result.data?.membership || null;
      this.renderPlans();
      this.updateMembershipSummary();
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || "Plans konnten nicht geladen werden.");
      this.plans = [];
      this.renderPlans();
      this.updateMembershipSummary();
    }
  }

  renderPlans() {
    if (!this.plansGridEl) {
      return;
    }

    if (!Array.isArray(this.plans) || this.plans.length === 0) {
      this.plansGridEl.innerHTML = "<div class=\"text-muted\">Keine Plans verfügbar.</div>";
      return;
    }

    const currentPlanCode = this.membership?.plan?.code || null;

    this.plansGridEl.innerHTML = this.plans.map((plan) => {
      const isCurrent = currentPlanCode && currentPlanCode === plan.code;

      return `
        <article class="profile-plan-card ${isCurrent ? "is-current" : ""}">
          <h3 class="profile-plan-name">${plan.name}</h3>
          <p class="profile-plan-price">${Number(plan.price).toFixed(2)} ${plan.currency}</p>
          <p class="profile-plan-copy">${plan.description || ""}</p>
          <div class="profile-plan-actions">
            <button
              type="button"
              class="btn ${isCurrent ? "btn-outline-secondary" : "btn-dark"} btn-sm"
              data-action="upgrade-plan"
              data-plan-code="${plan.code}"
              ${isCurrent ? "disabled" : ""}>
              ${isCurrent ? "Aktiv" : "Mit PayPal upgraden"}
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
    button.textContent = "Starte ...";

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
        throw new Error(result.error || `Checkout konnte nicht gestartet werden (${response.status})`);
      }

      const approvalUrl = result?.data?.approvalUrl;
      if (!approvalUrl) {
        throw new Error("PayPal approvalUrl fehlt.");
      }

      window.location.href = approvalUrl;
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || "PayPal Checkout konnte nicht gestartet werden.");
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
      this.showPaymentsInfo("Checkout wurde abgebrochen.");
      this.stripPaymentQueryParams();
      return;
    }

    if (paymentState !== "success" || !providerOrderId) {
      this.showPaymentsError("Unvollständige PayPal-Rückkehrparameter.");
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
        throw new Error(result.error || `Capture fehlgeschlagen (${response.status})`);
      }

      this.showPaymentsInfo("Zahlung erfolgreich verarbeitet.");
    } catch (err) {
      console.error(err);
      this.showPaymentsError(err.message || "Zahlung konnte nicht bestätigt werden.");
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
}

new ProfileUI();
