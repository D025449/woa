import pool from "./database.js";

export const USER_ACCOUNT_BACKUP_FORMAT = "cwa24-user-account-backup";
export const USER_ACCOUNT_BACKUP_VERSION = 1;

function requiredString(value, field, maxLength = 255) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid ${field}.`);
  }
  return normalized;
}

function optionalString(value, maxLength = 255) {
  if (value == null || value === "") {
    return null;
  }
  return String(value).slice(0, maxLength);
}

function optionalDate(value, field) {
  if (value == null || value === "") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field}.`);
  }
  return date;
}

function arrayOrEmpty(value, field) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function mapBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    map.set(String(row[key]), row);
  }
  return map;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = String(row[key]);
    const entries = map.get(value) || [];
    entries.push(row);
    map.set(value, entries);
  }
  return map;
}

export function buildUserAccountBackupFilename(createdAt = new Date()) {
  const timestamp = new Date(createdAt).toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `cwa24-user-accounts-${timestamp}.json`;
}

export function validateUserAccountBackup(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Account backup must be a JSON object.");
  }
  if (payload.format !== USER_ACCOUNT_BACKUP_FORMAT) {
    throw new Error("Unsupported account backup format.");
  }
  if (payload.version !== USER_ACCOUNT_BACKUP_VERSION) {
    throw new Error(`Unsupported account backup version: ${payload.version}.`);
  }

  const users = arrayOrEmpty(payload.users, "users");
  const authSubs = new Set();
  const providerOrderIds = new Set();
  for (const [index, user] of users.entries()) {
    const authSub = requiredString(user?.authSub, `users[${index}].authSub`);
    requiredString(user?.email, `users[${index}].email`);
    if (authSubs.has(authSub)) {
      throw new Error(`Duplicate authSub in account backup: ${authSub}`);
    }
    authSubs.add(authSub);

    for (const [orderIndex, order] of arrayOrEmpty(user.paymentOrders, `users[${index}].paymentOrders`).entries()) {
      const providerOrderId = requiredString(
        order?.providerOrderId,
        `users[${index}].paymentOrders[${orderIndex}].providerOrderId`,
        120
      );
      requiredString(order?.planCode, `users[${index}].paymentOrders[${orderIndex}].planCode`, 40);
      if (providerOrderIds.has(providerOrderId)) {
        throw new Error(`Duplicate providerOrderId in account backup: ${providerOrderId}`);
      }
      providerOrderIds.add(providerOrderId);
    }

    if (user.membership) {
      requiredString(user.membership.planCode, `users[${index}].membership.planCode`, 40);
    }
    for (const role of arrayOrEmpty(user.roles, `users[${index}].roles`)) {
      if (role?.role !== "admin") {
        throw new Error(`Unsupported account role: ${role?.role || "missing"}`);
      }
    }
    for (const [preferenceIndex, preference] of arrayOrEmpty(
      user.viewPreferences,
      `users[${index}].viewPreferences`
    ).entries()) {
      requiredString(preference?.viewKey, `users[${index}].viewPreferences[${preferenceIndex}].viewKey`, 80);
      if (!preference?.state || typeof preference.state !== "object" || Array.isArray(preference.state)) {
        throw new Error(`users[${index}].viewPreferences[${preferenceIndex}].state must be an object.`);
      }
    }
  }
  return payload;
}

export default class UserAccountBackupService {
  static async exportAll() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const usersResult = await client.query(`
        SELECT id, auth_sub, email, email_verified, display_name, account_status,
               deletion_requested_at, deletion_scheduled_for, deleted_at, created_at, updated_at
        FROM users
        ORDER BY id
      `);
      const profilesResult = await client.query(`
        SELECT user_id, phone, date_of_birth, weight_kg, height_cm, address_line1,
               address_line2, postal_code, city, country, language, distance_unit,
               speed_unit, default_workout_scope, show_sudoku, created_at, updated_at
        FROM user_profiles
      `);
      const membershipsResult = await client.query(`
        SELECT m.user_id, p.code AS plan_code, m.status,
               source.provider_order_id AS source_provider_order_id,
               m.started_at, m.current_period_start, m.current_period_end, m.updated_at
        FROM user_memberships m
        INNER JOIN account_plans p ON p.id = m.plan_id
        LEFT JOIN payment_orders source ON source.id = m.source_payment_order_id
      `);
      const ordersResult = await client.query(`
        SELECT o.user_id, p.code AS plan_code, o.provider, o.provider_order_id,
               o.status, o.amount, o.currency, o.capture_id, o.created_at, o.updated_at
        FROM payment_orders o
        INNER JOIN account_plans p ON p.id = o.plan_id
        ORDER BY o.user_id, o.created_at, o.id
      `);
      const rolesResult = await client.query(`
        SELECT r.uid, r.role, r.granted_at, grantor.auth_sub AS granted_by_auth_sub
        FROM user_roles r
        LEFT JOIN users grantor ON grantor.id = r.granted_by_uid
        ORDER BY r.uid, r.role
      `);
      const preferencesResult = await client.query(`
        SELECT p.uid, p.view_key, p.state, p.version, p.updated_at
        FROM user_view_preferences p
        ORDER BY p.uid, p.view_key
      `);
      await client.query("COMMIT");

      const profiles = mapBy(profilesResult.rows, "user_id");
      const memberships = mapBy(membershipsResult.rows, "user_id");
      const orders = groupBy(ordersResult.rows, "user_id");
      const roles = groupBy(rolesResult.rows, "uid");
      const preferences = groupBy(preferencesResult.rows, "uid");
      const users = usersResult.rows.map((user) => {
        const profile = profiles.get(String(user.id));
        const membership = memberships.get(String(user.id));
        return {
          authSub: user.auth_sub,
          email: user.email,
          emailVerified: Boolean(user.email_verified),
          displayName: user.display_name,
          accountStatus: user.account_status,
          deletionRequestedAt: user.deletion_requested_at,
          deletionScheduledFor: user.deletion_scheduled_for,
          deletedAt: user.deleted_at,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
          profile: profile ? {
            phone: profile.phone,
            dateOfBirth: profile.date_of_birth,
            weightKg: profile.weight_kg,
            heightCm: profile.height_cm,
            addressLine1: profile.address_line1,
            addressLine2: profile.address_line2,
            postalCode: profile.postal_code,
            city: profile.city,
            country: profile.country,
            language: profile.language,
            distanceUnit: profile.distance_unit,
            speedUnit: profile.speed_unit,
            defaultWorkoutScope: profile.default_workout_scope,
            showSudoku: Boolean(profile.show_sudoku),
            createdAt: profile.created_at,
            updatedAt: profile.updated_at
          } : null,
          paymentOrders: (orders.get(String(user.id)) || []).map((order) => ({
            planCode: order.plan_code,
            provider: order.provider,
            providerOrderId: order.provider_order_id,
            status: order.status,
            amount: order.amount,
            currency: order.currency,
            captureId: order.capture_id,
            createdAt: order.created_at,
            updatedAt: order.updated_at
          })),
          membership: membership ? {
            planCode: membership.plan_code,
            status: membership.status,
            sourceProviderOrderId: membership.source_provider_order_id,
            startedAt: membership.started_at,
            currentPeriodStart: membership.current_period_start,
            currentPeriodEnd: membership.current_period_end,
            updatedAt: membership.updated_at
          } : null,
          roles: (roles.get(String(user.id)) || []).map((role) => ({
            role: role.role,
            grantedAt: role.granted_at,
            grantedByAuthSub: role.granted_by_auth_sub
          })),
          viewPreferences: (preferences.get(String(user.id)) || []).map((preference) => ({
            viewKey: preference.view_key,
            state: preference.state,
            version: preference.version,
            updatedAt: preference.updated_at
          }))
        };
      });

      return {
        format: USER_ACCOUNT_BACKUP_FORMAT,
        version: USER_ACCOUNT_BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        userCount: users.length,
        users
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  static async importAll(input) {
    const backup = validateUserAccountBackup(input);
    const client = await pool.connect();
    const userIds = new Map();
    const paymentOrderIds = new Map();
    const counts = { users: 0, profiles: 0, paymentOrders: 0, memberships: 0, roles: 0, viewPreferences: 0 };

    try {
      await client.query("BEGIN");
      const planCodes = new Set();
      for (const user of backup.users) {
        if (user.membership?.planCode) planCodes.add(user.membership.planCode);
        for (const order of user.paymentOrders || []) planCodes.add(order.planCode);
      }
      const plansResult = await client.query(
        `SELECT id, code FROM account_plans WHERE code = ANY($1::varchar[])`,
        [[...planCodes]]
      );
      const planIds = new Map(plansResult.rows.map((row) => [row.code, row.id]));
      const missingPlans = [...planCodes].filter((code) => !planIds.has(code));
      if (missingPlans.length > 0) {
        throw new Error(`Unknown account plans: ${missingPlans.join(", ")}`);
      }

      for (const user of backup.users) {
        const result = await client.query(`
          INSERT INTO users (
            auth_sub, email, email_verified, display_name, account_status,
            deletion_requested_at, deletion_scheduled_for, deleted_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), COALESCE($10, NOW()))
          ON CONFLICT (auth_sub) DO UPDATE SET
            email = EXCLUDED.email,
            email_verified = EXCLUDED.email_verified,
            display_name = EXCLUDED.display_name,
            account_status = EXCLUDED.account_status,
            deletion_requested_at = EXCLUDED.deletion_requested_at,
            deletion_scheduled_for = EXCLUDED.deletion_scheduled_for,
            deleted_at = EXCLUDED.deleted_at
          RETURNING id
        `, [
          requiredString(user.authSub, "authSub"),
          requiredString(user.email, "email"),
          Boolean(user.emailVerified),
          optionalString(user.displayName, 100),
          optionalString(user.accountStatus, 32) || "active",
          optionalDate(user.deletionRequestedAt, "deletionRequestedAt"),
          optionalDate(user.deletionScheduledFor, "deletionScheduledFor"),
          optionalDate(user.deletedAt, "deletedAt"),
          optionalDate(user.createdAt, "createdAt"),
          optionalDate(user.updatedAt, "updatedAt")
        ]);
        userIds.set(user.authSub, result.rows[0].id);
        counts.users += 1;
      }

      for (const user of backup.users) {
        const userId = userIds.get(user.authSub);
        const profile = user.profile;
        if (profile) {
          await client.query(`
            INSERT INTO user_profiles (
              user_id, phone, date_of_birth, weight_kg, height_cm, address_line1,
              address_line2, postal_code, city, country, language, distance_unit,
              speed_unit, default_workout_scope, show_sudoku, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              COALESCE($16, NOW()), COALESCE($17, NOW())
            )
            ON CONFLICT (user_id) DO UPDATE SET
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
              default_workout_scope = EXCLUDED.default_workout_scope,
              show_sudoku = EXCLUDED.show_sudoku
          `, [
            userId,
            optionalString(profile.phone, 50),
            optionalString(profile.dateOfBirth, 10),
            profile.weightKg ?? null,
            profile.heightCm ?? null,
            optionalString(profile.addressLine1),
            optionalString(profile.addressLine2),
            optionalString(profile.postalCode, 20),
            optionalString(profile.city, 120),
            optionalString(profile.country, 120),
            optionalString(profile.language, 10) || "en",
            optionalString(profile.distanceUnit, 10) || "km",
            optionalString(profile.speedUnit, 10) || "kmh",
            optionalString(profile.defaultWorkoutScope, 10) || "mine",
            Boolean(profile.showSudoku),
            optionalDate(profile.createdAt, "profile.createdAt"),
            optionalDate(profile.updatedAt, "profile.updatedAt")
          ]);
          counts.profiles += 1;
        }

        for (const preference of user.viewPreferences || []) {
          await client.query(`
            INSERT INTO user_view_preferences (uid, view_key, state, version, updated_at)
            VALUES ($1, $2, $3::jsonb, $4, COALESCE($5, NOW()))
            ON CONFLICT (uid, view_key) DO UPDATE SET
              state = EXCLUDED.state,
              version = EXCLUDED.version,
              updated_at = EXCLUDED.updated_at
          `, [
            userId,
            requiredString(preference.viewKey, "viewPreference.viewKey", 80),
            JSON.stringify(preference.state),
            Math.max(1, Number.parseInt(String(preference.version || 1), 10) || 1),
            optionalDate(preference.updatedAt, "viewPreference.updatedAt")
          ]);
          counts.viewPreferences += 1;
        }

        for (const order of user.paymentOrders || []) {
          const orderResult = await client.query(`
            INSERT INTO payment_orders (
              user_id, plan_id, provider, provider_order_id, status,
              amount, currency, capture_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), COALESCE($10, NOW()))
            ON CONFLICT (provider_order_id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              plan_id = EXCLUDED.plan_id,
              provider = EXCLUDED.provider,
              status = EXCLUDED.status,
              amount = EXCLUDED.amount,
              currency = EXCLUDED.currency,
              capture_id = EXCLUDED.capture_id
            RETURNING id
          `, [
            userId,
            planIds.get(order.planCode),
            optionalString(order.provider, 30) || "paypal",
            requiredString(order.providerOrderId, "providerOrderId", 120),
            optionalString(order.status, 30) || "captured",
            order.amount,
            requiredString(order.currency, "currency", 3),
            optionalString(order.captureId, 120),
            optionalDate(order.createdAt, "paymentOrder.createdAt"),
            optionalDate(order.updatedAt, "paymentOrder.updatedAt")
          ]);
          paymentOrderIds.set(order.providerOrderId, orderResult.rows[0].id);
          counts.paymentOrders += 1;
        }
      }

      for (const user of backup.users) {
        const membership = user.membership;
        if (membership) {
          await client.query(`
            INSERT INTO user_memberships (
              user_id, plan_id, status, source_payment_order_id, started_at,
              current_period_start, current_period_end, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
            ON CONFLICT (user_id) DO UPDATE SET
              plan_id = EXCLUDED.plan_id,
              status = EXCLUDED.status,
              source_payment_order_id = EXCLUDED.source_payment_order_id,
              started_at = EXCLUDED.started_at,
              current_period_start = EXCLUDED.current_period_start,
              current_period_end = EXCLUDED.current_period_end
          `, [
            userIds.get(user.authSub),
            planIds.get(membership.planCode),
            optionalString(membership.status, 30) || "active",
            membership.sourceProviderOrderId
              ? paymentOrderIds.get(membership.sourceProviderOrderId) || null
              : null,
            optionalDate(membership.startedAt, "membership.startedAt") || new Date(),
            optionalDate(membership.currentPeriodStart, "membership.currentPeriodStart") || new Date(),
            optionalDate(membership.currentPeriodEnd, "membership.currentPeriodEnd") || new Date(),
            optionalDate(membership.updatedAt, "membership.updatedAt")
          ]);
          counts.memberships += 1;
        }
      }

      for (const user of backup.users) {
        for (const role of user.roles || []) {
          await client.query(`
            INSERT INTO user_roles (uid, role, granted_at, granted_by_uid)
            VALUES ($1, $2, COALESCE($3, NOW()), $4)
            ON CONFLICT (uid, role) DO UPDATE SET
              granted_at = EXCLUDED.granted_at,
              granted_by_uid = EXCLUDED.granted_by_uid
          `, [
            userIds.get(user.authSub),
            role.role,
            optionalDate(role.grantedAt, "role.grantedAt"),
            role.grantedByAuthSub ? userIds.get(role.grantedByAuthSub) || null : null
          ]);
          counts.roles += 1;
        }
      }

      await client.query("COMMIT");
      return counts;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
