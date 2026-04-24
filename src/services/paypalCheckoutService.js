const PAYPAL_BASE_URL = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com"
};

function getEnvKey() {
  const env = String(process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  return env === "live" ? "live" : "sandbox";
}

function getBaseUrl() {
  return PAYPAL_BASE_URL[getEnvKey()];
}

function assertConfig() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    const error = new Error("PayPal is not configured. Missing PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET.");
    error.statusCode = 500;
    throw error;
  }
}

async function requestAccessToken() {
  assertConfig();

  const basicAuth = Buffer
    .from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`)
    .toString("base64");

  const response = await fetch(`${getBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload?.access_token) {
    const error = new Error(payload?.error_description || payload?.error || `PayPal auth failed (${response.status})`);
    error.statusCode = 502;
    throw error;
  }

  return payload.access_token;
}

function extractApprovalUrl(orderResponse) {
  const links = Array.isArray(orderResponse?.links) ? orderResponse.links : [];
  const approval = links.find((link) => link.rel === "approve");
  return approval?.href || null;
}

export default class PayPalCheckoutService {
  static getEnvironment() {
    return getEnvKey();
  }

  static async createOrder({
    amount,
    currency,
    planCode,
    userId,
    returnUrl,
    cancelUrl
  }) {
    const accessToken = await requestAccessToken();

    const response = await fetch(`${getBaseUrl()}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: `uid:${userId}|plan:${planCode}`,
            amount: {
              currency_code: currency,
              value: Number(amount).toFixed(2)
            }
          }
        ],
        application_context: {
          user_action: "PAY_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl
        }
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload?.id) {
      const error = new Error(payload?.message || payload?.name || `PayPal create order failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }

    return {
      providerOrderId: payload.id,
      approvalUrl: extractApprovalUrl(payload),
      raw: payload
    };
  }

  static async captureOrder(providerOrderId) {
    const accessToken = await requestAccessToken();

    const response = await fetch(`${getBaseUrl()}/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload?.message || payload?.name || `PayPal capture failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }

    const captureId = payload?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;

    return {
      status: String(payload?.status || "").toLowerCase(),
      captureId,
      raw: payload
    };
  }
}
