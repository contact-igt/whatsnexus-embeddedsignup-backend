import crypto from "crypto";
import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import { decryptSecret, encryptSecret } from "../../utils/encryption.js";

const TABLE = tableNames.WHATSAPP_ONBOARDING_SESSIONS;
const RECOVERY_DAYS = 7;
const parse = (value) => {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
};
const row = (r) => r && ({ ...r, previous: parse(r.previous_json) });

const secretColumns = (name, value, tenantId) => {
  if (value === undefined) return {};
  if (value === null) return { [`${name}_enc`]: null, [`${name}_iv`]: null, [`${name}_tag`]: null };
  const encrypted = encryptSecret(value, tenantId);
  return { [`${name}_enc`]: encrypted.encrypted_value, [`${name}_iv`]: encrypted.iv, [`${name}_tag`]: encrypted.auth_tag, key_version: encrypted.key_version };
};

export const whatsappOnboardingSessionStore = {
  async create({ tenant_id, connection_type }) {
    const onboarding_id = crypto.randomUUID();
    try {
      await db.sequelize.query(
        `INSERT INTO ${TABLE} (onboarding_id, tenant_id, connection_type, state, active_slot)
         VALUES (?, ?, ?, 'STARTED', 1)`,
        { replacements: [onboarding_id, tenant_id, connection_type] },
      );
    } catch (err) {
      if (err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY") {
        const conflict = new Error("Onboarding slot already taken");
        conflict.code = "SESSION_SLOT_TAKEN";
        throw conflict;
      }
      throw err;
    }
    return this.findInFlight(tenant_id);
  },

  async findInFlight(tenant_id) {
    const [rows] = await db.sequelize.query(
      `SELECT * FROM ${TABLE} WHERE tenant_id = ? AND active_slot = 1 ORDER BY id DESC LIMIT 1`,
      { replacements: [tenant_id] },
    );
    return row(rows[0]);
  },

  async claim(id, leaseSeconds) {
    return db.sequelize.transaction(async (transaction) => {
      const [rows] = await db.sequelize.query(`SELECT * FROM ${TABLE} WHERE id = ? FOR UPDATE`, { replacements: [id], transaction });
      const current = rows[0];
      if (!current || current.active_slot !== 1 || (current.lease_until && new Date(current.lease_until) > new Date())) return null;
      await db.sequelize.query(
        `UPDATE ${TABLE} SET lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND), attempt_count = attempt_count + 1 WHERE id = ?`,
        { replacements: [leaseSeconds, id], transaction },
      );
      return row({ ...current, lease_until: new Date(Date.now() + leaseSeconds * 1000) });
    });
  },

  async release(id) {
    await db.sequelize.query(`UPDATE ${TABLE} SET lease_until = NULL WHERE id = ?`, { replacements: [id] });
  },

  async readSecrets(ob) {
    const [rows] = await db.sequelize.query(
      `SELECT token_enc, token_iv, token_tag, pin_enc, pin_iv, pin_tag, key_version FROM ${TABLE} WHERE id = ? LIMIT 1`,
      { replacements: [ob.id] },
    );
    const r = rows[0] || {};
    return {
      token: decryptSecret({ encrypted_value: r.token_enc, iv: r.token_iv, auth_tag: r.token_tag, key_version: r.key_version }, ob.tenant_id),
      pin: decryptSecret({ encrypted_value: r.pin_enc, iv: r.pin_iv, auth_tag: r.pin_tag, key_version: r.key_version }, ob.tenant_id),
    };
  },

  async update(ob, patch) {
    const fields = {
      state: patch.state,
      waba_id: patch.waba_id,
      phone_number_id: patch.phone_number_id,
      business_number: patch.business_number,
      meta_business_id: patch.meta_business_id,
      migration_mode: patch.migration_mode,
      previous_json: patch.previous === undefined ? undefined : JSON.stringify(patch.previous),
      last_error_code: patch.last_error_code,
      active_slot: patch.active_slot,
      ...secretColumns("token", patch.token, ob.tenant_id),
      ...secretColumns("pin", patch.pin, ob.tenant_id),
    };
    if (patch.wipe) Object.assign(fields, secretColumns("token", null, ob.tenant_id), secretColumns("pin", null, ob.tenant_id));
    if (patch.active_slot === null && ob.previous) {
      Object.assign(fields, {
        recovery_status: "RECOVERABLE",
        recovery_saved_at: new Date(),
        recovery_expires_at: new Date(Date.now() + RECOVERY_DAYS * 86400000),
        recovery_json: JSON.stringify(ob.previous),
      });
    }
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    await db.sequelize.query(
      `UPDATE ${TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
      { replacements: [...entries.map(([, value]) => value), ob.id] },
    );
  },
};
