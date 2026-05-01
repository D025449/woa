import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import EntitlementService from "../services/entitlementService.js";
import PaymentsDBService from "../services/paymentsDBService.js";
import PayPalCheckoutService from "../services/paypalCheckoutService.js";

const router = express.Router();

function getBaseUrl(req) {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const host = req.get("host");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${host}`;
}

router.get("/plans", authMiddleware, async (req, res, next) => {
  try {
    const plans = await PaymentsDBService.listPlans();
    const membership = req.user?.id
      ? await PaymentsDBService.getMembershipForUser(req.user.id)
      : null;
    const usage = req.user?.id
      ? await EntitlementService.getUsageOverview(req.user.id)
      : null;

    const enrichedPlans = plans.map((plan) => ({
      ...plan,
      entitlements: EntitlementService.describeTier(plan.tierCode || plan.code)
    }));

    const freePlan = {
      id: 0,
      code: "free",
      name: "Free",
      description: "Starter access with limited planning and AI coaching.",
      price: 0,
      currency: "EUR",
      entitlements: EntitlementService.describeTier("free")
    };

    res.json({
      data: {
        plans: [freePlan, ...enrichedPlans],
        membership,
        usage,
        provider: "paypal",
        environment: PayPalCheckoutService.getEnvironment()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post("/checkout/order", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const plan = await PaymentsDBService.getPlanByCode(req.body?.planCode);

    const baseUrl = getBaseUrl(req);
    const returnUrl = `${baseUrl}/profile?payment=success`;
    const cancelUrl = `${baseUrl}/profile?payment=cancel`;

    const created = await PayPalCheckoutService.createOrder({
      amount: plan.price,
      currency: plan.currency,
      planCode: plan.code,
      userId,
      returnUrl,
      cancelUrl
    });

    await PaymentsDBService.createPaymentOrder({
      userId,
      planId: plan.id,
      providerOrderId: created.providerOrderId,
      amount: plan.price,
      currency: plan.currency,
      approvalUrl: created.approvalUrl,
      rawCreateResponse: created.raw
    });

    res.status(201).json({
      data: {
        provider: "paypal",
        providerOrderId: created.providerOrderId,
        approvalUrl: created.approvalUrl,
        plan: {
          code: plan.code,
          name: plan.name,
          price: plan.price,
          currency: plan.currency
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post("/checkout/capture", authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const providerOrderId = String(req.body?.providerOrderId || "").trim();
    if (!providerOrderId) {
      return res.status(400).json({ error: "Missing providerOrderId" });
    }

    await PaymentsDBService.getPaymentOrderForUser(userId, providerOrderId);

    const captured = await PayPalCheckoutService.captureOrder(providerOrderId);
    const order = await PaymentsDBService.markOrderCaptured({
      providerOrderId,
      captureId: captured.captureId,
      rawCaptureResponse: captured.raw
    });

    res.json({
      data: {
        providerOrderId,
        status: order.status,
        captureId: order.capture_id,
        membership: await PaymentsDBService.getMembershipForUser(userId)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post("/paypal/webhook", async (req, res, next) => {
  try {
    const event = req.body || {};
    const providerEventId = String(event.id || req.headers["paypal-transmission-id"] || "").trim();

    if (!providerEventId) {
      return res.status(400).json({ error: "Missing webhook event id" });
    }

    const isNew = await PaymentsDBService.createWebhookEvent({
      providerEventId,
      eventType: event.event_type,
      payload: event
    });

    if (!isNew) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    try {
      const eventType = String(event.event_type || "");

      if (eventType === "CHECKOUT.BUYER-APPROVED" || eventType === "CHECKOUT.ORDER.APPROVED") {
        const providerOrderId = String(event.resource?.id || "").trim();
        if (providerOrderId) {
          await PaymentsDBService.markOrderApproved(providerOrderId);
        }
      }

      if (eventType === "CHECKOUT.ORDER.COMPLETED" || eventType === "PAYMENT.CAPTURE.COMPLETED") {
        const providerOrderId = String(
          event.resource?.supplementary_data?.related_ids?.order_id || ""
        ).trim();
        const fallbackOrderId = String(event.resource?.id || "").trim();
        const captureId = String(
          event.resource?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
          event.resource?.id ||
          ""
        ).trim() || null;

        const resolvedOrderId = providerOrderId || fallbackOrderId;

        if (resolvedOrderId) {
          await PaymentsDBService.markOrderCaptured({
            providerOrderId: resolvedOrderId,
            captureId,
            rawCaptureResponse: event
          });
        }
      }

      if (
        eventType === "CHECKOUT.ORDER.CANCELED" ||
        eventType === "CHECKOUT.ORDER.VOIDED" ||
        eventType === "CHECKOUT.ORDER.DECLINED"
      ) {
        const providerOrderId = String(event.resource?.id || "").trim();
        if (providerOrderId) {
          await PaymentsDBService.markOrderCanceled(providerOrderId);
        }
      }

      await PaymentsDBService.finalizeWebhookEvent(providerEventId, "processed");
      return res.status(200).json({ ok: true });
    } catch (processError) {
      await PaymentsDBService.finalizeWebhookEvent(providerEventId, "failed");
      throw processError;
    }
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error("payments route failed:", err);
  return res.status(500).json({ error: err?.message || "Payments request failed" });
});

export default router;
