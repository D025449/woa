import pool from "./database.js";
import { normalizeSupportedLocale } from "../i18n/index.js";

function toNullableString(value, maxLen = 255) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLen);
}

function toNullableNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateInputValue(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const str = String(value);
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

export default class ProfileDBService {
  static async getProfile(userId) {
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.display_name,
        p.phone,
        p.date_of_birth,
        p.weight_kg,
        p.height_cm,
        p.address_line1,
        p.address_line2,
        p.postal_code,
        p.city,
        p.country,
        p.language,
        p.distance_unit,
        p.speed_unit,
        p.default_workout_scope,
        p.updated_at AS profile_updated_at
      FROM users u
      LEFT JOIN user_profiles p
        ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
    `, [userId]);

    if (result.rowCount === 0) {
      const error = new Error("User not found");
      error.statusCode = 404;
      throw error;
    }

    const row = result.rows[0];

    return {
      userId: Number(row.id),
      email: row.email,
      displayName: row.display_name || "",
      phone: row.phone || "",
      dateOfBirth: toDateInputValue(row.date_of_birth),
      weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
      heightCm: row.height_cm == null ? null : Number(row.height_cm),
      addressLine1: row.address_line1 || "",
      addressLine2: row.address_line2 || "",
      postalCode: row.postal_code || "",
      city: row.city || "",
      country: row.country || "",
      language: row.language || "en",
      distanceUnit: row.distance_unit || "km",
      speedUnit: row.speed_unit || "kmh",
      defaultWorkoutScope: row.default_workout_scope || "mine",
      updatedAt: row.profile_updated_at || null
    };
  }

  static async updateProfile(userId, payload = {}) {
    const displayName = toNullableString(payload.displayName, 100);
    const phone = toNullableString(payload.phone, 50);
    const dateOfBirth = toNullableString(payload.dateOfBirth, 10);
    const weightKg = toNullableNumber(payload.weightKg);
    const heightCm = toNullableNumber(payload.heightCm);
    const addressLine1 = toNullableString(payload.addressLine1, 255);
    const addressLine2 = toNullableString(payload.addressLine2, 255);
    const postalCode = toNullableString(payload.postalCode, 20);
    const city = toNullableString(payload.city, 120);
    const country = toNullableString(payload.country, 120);
    const language = normalizeSupportedLocale(payload.language, "en");
    const distanceUnit = normalizeEnum(payload.distanceUnit, ["km", "mi"], "km");
    const speedUnit = normalizeEnum(payload.speedUnit, ["kmh", "mph"], "kmh");
    const defaultWorkoutScope = normalizeEnum(payload.defaultWorkoutScope, ["mine", "shared", "all"], "mine");

    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      const error = new Error("Geburtsdatum muss im Format YYYY-MM-DD sein.");
      error.statusCode = 400;
      throw error;
    }

    if (weightKg != null && (weightKg <= 0 || weightKg > 500)) {
      const error = new Error("Gewicht liegt außerhalb des erlaubten Bereichs.");
      error.statusCode = 400;
      throw error;
    }

    if (heightCm != null && (heightCm <= 0 || heightCm > 300)) {
      const error = new Error("Größe liegt außerhalb des erlaubten Bereichs.");
      error.statusCode = 400;
      throw error;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(`
        UPDATE users
        SET display_name = COALESCE($2, display_name)
        WHERE id = $1
      `, [userId, displayName]);

      await client.query(`
        INSERT INTO user_profiles (
          user_id,
          phone,
          date_of_birth,
          weight_kg,
          height_cm,
          address_line1,
          address_line2,
          postal_code,
          city,
          country,
          language,
          distance_unit,
          speed_unit,
          default_workout_scope
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          phone = EXCLUDED.phone,
          date_of_birth = EXCLUDED.date_of_birth,
          weight_kg = EXCLUDED.weight_kg,
          height_cm = EXCLUDED.height_cm,
          address_line1 = EXCLUDED.address_line1,
          address_line2 = EXCLUDED.address_line2,
          postal_code = EXCLUDED.postal_code,
          city = EXCLUDED.city,
          country = EXCLUDED.country,
          language = EXCLUDED.language,
          distance_unit = EXCLUDED.distance_unit,
          speed_unit = EXCLUDED.speed_unit,
          default_workout_scope = EXCLUDED.default_workout_scope
      `, [
        userId,
        phone,
        dateOfBirth,
        weightKg,
        heightCm,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        country,
        language,
        distanceUnit,
        speedUnit,
        defaultWorkoutScope
      ]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getProfile(userId);
  }
}
