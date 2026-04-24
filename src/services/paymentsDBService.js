import pool from "./database.js";

function normalizePlanCode(value) {
  return String(value || "").trim().toLowerCase();
}

export default class PaymentsDBService {
  static async listPlans() {
    const result = await pool.query(`
      SELECT
        id,
        code,
        name,
        description,
        price,
        currency,
        sort_order
      FROM account_plans
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, id ASC
    `);

    return result.rows.map((row) => ({
      id: Number(row.id),
      code: row.code,
      name: row.name,
      description: row.description,
      price: Number(row.price),
      currency: row.currency
    }));
  }

  static async getPlanByCode(planCode) {
    const normalized = normalizePlanCode(planCode);
    const result = await pool.query(`
      SELECT id, code, name, description, price, currency
      FROM account_plans
      WHERE code = $1
        AND is_active = TRUE
      LIMIT 1
    `, [normalized]);

    if (result.rowCount === 0) {
      const error = new Error("Invalid or inactive plan");
      error.statusCode = 400;
      throw error;
    }

    const row = result.rows[0];
    return {
      id: Number(row.id),
      code: row.code,
      name: row.name,
      description: row.description,
      price: Number(row.price),
      currency: row.currency
    };
  }

  static async createPaymentOrder({
    userId,
    planId,
    providerOrderId,
    amount,
    currency,
    approvalUrl,
    rawCreateResponse
  }) {
    const result = await pool.query(`
      INSERT INTO payment_orders (
        user_id,
        plan_id,
        provider,
        provider_order_id,
        status,
        amount,
        currency,
        approval_url,
        raw_create_response
      )
      VALUES ($1, $2, 'paypal', $3, 'created', $4, $5, $6, $7::jsonb)
      RETURNING *
    `, [
      userId,
      planId,
      providerOrderId,
      amount,
      currency,
      approvalUrl,
      JSON.stringify(rawCreateResponse || {})
    ]);

    return result.rows[0];
  }

  static async getPaymentOrderForUser(userId, providerOrderId) {
    const result = await pool.query(`
      SELECT *
      FROM payment_orders
      WHERE user_id = $1
        AND provider = 'paypal'
        AND provider_order_id = $2
      LIMIT 1
    `, [userId, providerOrderId]);

    if (result.rowCount === 0) {
      const error = new Error("Payment order not found");
      error.statusCode = 404;
      throw error;
    }

    return result.rows[0];
  }

  static async markOrderApproved(providerOrderId) {
    await pool.query(`
      UPDATE payment_orders
      SET status = 'approved'
      WHERE provider = 'paypal'
        AND provider_order_id = $1
        AND status = 'created'
    `, [providerOrderId]);
  }

  static async markOrderCanceled(providerOrderId) {
    await pool.query(`
      UPDATE payment_orders
      SET status = 'canceled'
      WHERE provider = 'paypal'
        AND provider_order_id = $1
        AND status <> 'captured'
    `, [providerOrderId]);
  }

  static async markOrderCaptured({ providerOrderId, captureId, rawCaptureResponse }) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const orderResult = await client.query(`
        UPDATE payment_orders
        SET
          status = 'captured',
          capture_id = COALESCE($2, capture_id),
          raw_capture_response = $3::jsonb
        WHERE provider = 'paypal'
          AND provider_order_id = $1
        RETURNING *
      `, [providerOrderId, captureId, JSON.stringify(rawCaptureResponse || {})]);

      if (orderResult.rowCount === 0) {
        const error = new Error("Payment order not found");
        error.statusCode = 404;
        throw error;
      }

      const order = orderResult.rows[0];

      await client.query(`
        INSERT INTO user_memberships (
          user_id,
          plan_id,
          status,
          source_payment_order_id,
          started_at
        )
        VALUES ($1, $2, 'active', $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          status = 'active',
          source_payment_order_id = EXCLUDED.source_payment_order_id,
          started_at = NOW()
      `, [order.user_id, order.plan_id, order.id]);

      await client.query("COMMIT");
      return order;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async getMembershipForUser(userId) {
    const result = await pool.query(`
      SELECT
        m.user_id,
        m.status,
        m.started_at,
        p.code,
        p.name,
        p.price,
        p.currency
      FROM user_memberships m
      INNER JOIN account_plans p
        ON p.id = m.plan_id
      WHERE m.user_id = $1
      LIMIT 1
    `, [userId]);

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      userId: Number(row.user_id),
      status: row.status,
      startedAt: row.started_at,
      plan: {
        code: row.code,
        name: row.name,
        price: Number(row.price),
        currency: row.currency
      }
    };
  }

  static async createWebhookEvent({ providerEventId, eventType, payload }) {
    const result = await pool.query(`
      INSERT INTO payment_webhook_events (
        provider,
        provider_event_id,
        event_type,
        payload,
        processing_status
      )
      VALUES ('paypal', $1, $2, $3::jsonb, 'received')
      ON CONFLICT (provider_event_id) DO NOTHING
      RETURNING id
    `, [providerEventId, eventType || null, JSON.stringify(payload || {})]);

    return result.rowCount > 0;
  }

  static async finalizeWebhookEvent(providerEventId, processingStatus = "processed") {
    await pool.query(`
      UPDATE payment_webhook_events
      SET
        processing_status = $2,
        processed_at = NOW()
      WHERE provider_event_id = $1
    `, [providerEventId, processingStatus]);
  }
}
