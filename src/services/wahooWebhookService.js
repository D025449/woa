import { timingSafeEqual } from "node:crypto";
import pool from "./database.js";
import Connection, { wahooUserId } from "./wahooConnectionService.js";

export function validWebhookToken(value) {
  if (!Connection.webhookAvailable() || typeof value !== "string") return false;
  const expected = Buffer.from(process.env.WAHOO_WEBHOOK_TOKEN);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function receiveWahooWebhook(payload) {
  if (payload?.event_type !== "workout_summary") return;
  const user = wahooUserId(payload.user);
  const summary = wahooUserId(payload.workout_summary);
  const workout = wahooUserId(payload.workout_summary?.workout);
  // Only identifiers are retained; never trust/download a URL from a webhook.
  await pool.query(`INSERT INTO wahoo_webhook_imports
    (user_id, wahoo_user_id, workout_summary_id, workout_id)
    SELECT c.user_id, c.wahoo_user_id, $2, $3
    FROM user_wahoo_connections c JOIN users u ON u.id = c.user_id
    WHERE c.wahoo_user_id = $1 AND c.auto_import_enabled = TRUE
      AND c.offline_data_granted = TRUE AND u.account_status = 'active'
    ON CONFLICT (user_id, wahoo_user_id, workout_summary_id) DO NOTHING`, [user, summary, workout]);
}
