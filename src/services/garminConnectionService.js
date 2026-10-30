import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import pool from "./database.js";

function encryptionKey() {
  const value = process.env.GARMIN_API_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw Object.assign(new Error("Garmin key storage is not configured on this server."), { statusCode: 503 });
  }
  return Buffer.from(value, "hex");
}

export function encryptGarminKey(userId, apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`garmin:${userId}`));
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptGarminKey(userId, envelope) {
  const [version, iv, tag, data] = envelope.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Invalid Garmin key envelope");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(`garmin:${userId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export default class GarminConnectionService {
  static async status(userId) {
    const { rows } = await pool.query(
      "SELECT updated_at FROM user_garmin_connections WHERE user_id = $1", [userId]
    );
    return { configured: rows.length > 0, updatedAt: rows[0]?.updated_at || null };
  }

  static async save(userId, apiKey) {
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.trim().length > 8192 || /\s/.test(apiKey.trim())) {
      throw Object.assign(new Error("Enter a valid Garmin API key (without whitespace)."), { statusCode: 400 });
    }
    const encrypted = encryptGarminKey(userId, apiKey.trim());
    const { rows } = await pool.query(`
      INSERT INTO user_garmin_connections (user_id, api_key_encrypted)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE
      SET api_key_encrypted = EXCLUDED.api_key_encrypted, updated_at = NOW()
      RETURNING updated_at
    `, [userId, encrypted]);
    return { configured: true, updatedAt: rows[0].updated_at };
  }

  static async remove(userId) {
    await pool.query("DELETE FROM user_garmin_connections WHERE user_id = $1", [userId]);
  }
}
