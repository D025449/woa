import pool from "./database.js";

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateWeightDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < "0001-01-01" || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw invalid("Date must be a valid calendar date (YYYY-MM-DD).");
  }
  return value;
}

export function validateWeightEntry(payload = {}) {
  const validFrom = validateWeightDate(payload?.validFrom);
  const raw = payload?.weightKg;
  const weightKg = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500 ||
      Math.abs(weightKg * 100 - Math.round(weightKg * 100)) > 1e-7) {
    throw invalid("Weight must be greater than 0 and at most 500 kg, with at most two decimal places.");
  }
  return { validFrom, weightKg };
}

function entry(row) {
  return { id: String(row.id), validFrom: row.valid_from, weightKg: Number(row.weight_kg) };
}

export default class UserWeightHistoryService {
  static async list(userId) {
    const { rows } = await pool.query(`
      SELECT id, valid_from::text, weight_kg FROM user_weight_history
      WHERE user_id = $1 ORDER BY valid_from DESC
    `, [userId]);
    return rows.map(entry);
  }

  static async resolve(userId, date) {
    validateWeightDate(date);
    const { rows } = await pool.query(`
      SELECT COALESCE(h.weight_kg, p.weight_kg) AS weight_kg,
        h.valid_from::text,
        CASE WHEN h.id IS NOT NULL THEN 'history'
             WHEN p.weight_kg IS NOT NULL THEN 'profile' ELSE NULL END AS source
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT id, valid_from, weight_kg FROM user_weight_history
        WHERE user_id = u.id AND valid_from <= $2::date
        ORDER BY valid_from DESC LIMIT 1
      ) h ON TRUE
      WHERE u.id = $1
    `, [userId, date]);
    if (!rows.length) throw invalid("User not found", 404);
    const row = rows[0];
    return { date, weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
      validFrom: row.valid_from ?? null, source: row.source };
  }

  static async save(userId, payload, id = null) {
    const { validFrom, weightKg } = validateWeightEntry(payload);
    if (id !== null && !/^[1-9]\d*$/.test(String(id))) throw invalid("Invalid entry ID.");
    try {
      const { rows } = id === null
        ? await pool.query(`
          INSERT INTO user_weight_history (user_id, valid_from, weight_kg)
          VALUES ($1, $2, $3) RETURNING id, valid_from::text, weight_kg
        `, [userId, validFrom, weightKg])
        : await pool.query(`
          UPDATE user_weight_history SET valid_from = $3, weight_kg = $4
          WHERE user_id = $1 AND id = $2 RETURNING id, valid_from::text, weight_kg
        `, [userId, id, validFrom, weightKg]);
      if (!rows.length) throw invalid("Weight entry not found", 404);
      return entry(rows[0]);
    } catch (error) {
      if (error.code === "23505") throw invalid("A weight entry already exists for this date.", 409);
      throw error;
    }
  }

  static async remove(userId, id) {
    if (!/^[1-9]\d*$/.test(String(id))) throw invalid("Invalid entry ID.");
    const result = await pool.query("DELETE FROM user_weight_history WHERE user_id = $1 AND id = $2", [userId, id]);
    if (!result.rowCount) throw invalid("Weight entry not found", 404);
  }
}
