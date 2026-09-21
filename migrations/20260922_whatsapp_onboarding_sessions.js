/**
 * Migration: WhatsApp Embedded Signup onboarding sessions (recoverable state machine)
 *
 * NEW table only — no existing table or row is touched. Empty until an Embedded
 * Signup completion is attempted, so existing organizations are unaffected.
 *
 * Holds, per onboarding attempt:
 *   - the state machine position (STARTED … ACTIVE / FAILED / ROLLBACK_REQUIRED)
 *   - the business token and the registration PIN, ENCRYPTED, so a failure after
 *     Meta's /register can be resumed without spending a new auth code or losing the PIN
 *   - active_slot: 1 while in flight, NULL when terminal. UNIQUE(tenant_id, active_slot)
 *     therefore allows at most ONE in-flight onboarding per organization (MySQL
 *     treats NULLs as distinct, so any number of finished rows may coexist)
 *   - the recovery-window metadata for the credential a switch superseded
 *
 * Idempotent. Down drops ONLY this table, and refuses while it holds rows that are
 * the only copy of a PIN / superseded credential.
 *
 * Run (from invictus-chatbot/):
 *   node migrations/20260922_whatsapp_onboarding_sessions.js
 *   node migrations/20260922_whatsapp_onboarding_sessions.js down
 */
import db from "../src/database/index.js";

const TABLE = "whatsapp_onboarding_sessions";

const tableExists = async (name) => {
  const [rows] = await db.sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = :name`,
    { replacements: { name } },
  );
  return Number(rows?.[0]?.n || 0) > 0;
};

const up = async () => {
  if (await tableExists(TABLE)) {
    console.log(`[MIGRATION] ${TABLE} already exists`);
    return;
  }
  await db.sequelize.query(`
    CREATE TABLE ${TABLE} (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      onboarding_id VARCHAR(36) NOT NULL,
      tenant_id VARCHAR(255) NOT NULL,
      connection_type VARCHAR(32) NOT NULL,
      state VARCHAR(32) NOT NULL DEFAULT 'STARTED',
      migration_mode VARCHAR(24) NULL,
      waba_id VARCHAR(64) NULL,
      phone_number_id VARCHAR(64) NULL,
      business_number VARCHAR(24) NULL,
      meta_business_id VARCHAR(64) NULL,
      previous_json TEXT NULL COMMENT 'snapshot of the connection being superseded (decision input)',
      token_enc TEXT NULL,
      token_iv VARCHAR(64) NULL,
      token_tag VARCHAR(64) NULL,
      pin_enc TEXT NULL,
      pin_iv VARCHAR(64) NULL,
      pin_tag VARCHAR(64) NULL,
      key_version INT NOT NULL DEFAULT 1,
      last_error_code VARCHAR(48) NULL,
      attempt_count INT NOT NULL DEFAULT 0,
      lease_until DATETIME NULL COMMENT 'processing lease; guards concurrent completion',
      active_slot TINYINT NULL DEFAULT 1 COMMENT '1 = in flight, NULL = terminal',
      recovery_status VARCHAR(16) NULL COMMENT 'RECOVERABLE | SUPERSEDED | EXPIRED',
      recovery_saved_at DATETIME NULL,
      recovery_expires_at DATETIME NULL,
      recovery_json TEXT NULL COMMENT 'metadata of the superseded connection (no credentials)',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_wa_onboarding_id (onboarding_id),
      UNIQUE KEY unique_wa_onboarding_inflight (tenant_id, active_slot),
      KEY idx_wa_onboarding_recovery (recovery_status, recovery_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log(`[MIGRATION] ${TABLE} created`);
};

const down = async () => {
  if (!(await tableExists(TABLE))) return;
  const [rows] = await db.sequelize.query(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE state = 'ROLLBACK_REQUIRED' OR recovery_status = 'RECOVERABLE' OR active_slot = 1`,
  );
  if (Number(rows?.[0]?.n || 0) > 0) {
    console.log(
      `[MIGRATION] ${TABLE} holds in-flight / rollback-required / recoverable rows; NOT dropped. Resolve them first.`,
    );
    return;
  }
  await db.sequelize.query(`DROP TABLE ${TABLE}`);
  console.log(`[MIGRATION] ${TABLE} dropped`);
};

const run = async () => {
  const direction = process.argv[2] === "down" ? "down" : "up";
  console.log(`[MIGRATION] Running ${direction.toUpperCase()} whatsapp_onboarding_sessions...`);
  try {
    if (direction === "down") await down();
    else await up();
    console.log("[MIGRATION] Done.");
  } catch (err) {
    console.error("[MIGRATION] Failed:", err.message);
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
};

run();
