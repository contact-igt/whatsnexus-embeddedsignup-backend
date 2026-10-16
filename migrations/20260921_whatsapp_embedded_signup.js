/**
 * Migration: WhatsApp Embedded Signup (+ Business App coexistence) support
 *
 * Additive and backward-compatible:
 *   - tenants: two feature flags, default 0 (OFF) => every existing organization
 *     keeps the current manual-only WhatsApp Settings experience.
 *   - whatsapp_accounts: nullable connection metadata. NULL connection type is
 *     read by the application as LEGACY_MANUAL, so NO existing row is rewritten.
 *   - admin_audit_log.action_type: appends 'whatsapp_capability_change' to the ENUM
 *     (existing values are preserved in their current order).
 *   - whatsapp_number_identities: NEW append-only table mapping each transport id
 *     (phone_number_id) an organization has used to its canonical E.164 business
 *     number. Empty for every existing organization; no message is touched.
 *
 * Idempotent (each column / enum value is added only if absent).
 * Down removes ONLY the newly introduced columns / enum value.
 *
 * Run (from invictus-chatbot/):
 *   node migrations/20260921_whatsapp_embedded_signup.js
 *   node migrations/20260921_whatsapp_embedded_signup.js down
 */
import db from "../src/database/index.js";

const NEW_AUDIT_ACTION = "whatsapp_capability_change";

const COLUMNS = [
  {
    table: "tenants",
    name: "embedded_signup_enabled",
    ddl: `ALTER TABLE tenants ADD COLUMN embedded_signup_enabled TINYINT(1) NOT NULL DEFAULT 0
            COMMENT 'Super Admin flag: organization may use Meta Embedded Signup'`,
  },
  {
    table: "tenants",
    name: "coexistence_enabled",
    ddl: `ALTER TABLE tenants ADD COLUMN coexistence_enabled TINYINT(1) NOT NULL DEFAULT 0
            COMMENT 'Super Admin flag: organization may onboard an existing WhatsApp Business App number (requires embedded_signup_enabled)'`,
  },
  {
    table: "whatsapp_accounts",
    name: "whatsapp_connection_type",
    ddl: `ALTER TABLE whatsapp_accounts ADD COLUMN whatsapp_connection_type VARCHAR(32) NULL
            COMMENT 'LEGACY_MANUAL | EMBEDDED_STANDARD | EMBEDDED_COEXISTENCE (NULL = LEGACY_MANUAL)'`,
  },
  {
    table: "whatsapp_accounts",
    name: "meta_business_id",
    ddl: `ALTER TABLE whatsapp_accounts ADD COLUMN meta_business_id VARCHAR(64) NULL`,
  },
  {
    table: "whatsapp_accounts",
    name: "meta_embedded_config_id",
    ddl: `ALTER TABLE whatsapp_accounts ADD COLUMN meta_embedded_config_id VARCHAR(64) NULL`,
  },
  {
    table: "whatsapp_accounts",
    name: "connected_at",
    ddl: `ALTER TABLE whatsapp_accounts ADD COLUMN connected_at DATETIME NULL
            COMMENT 'When an Embedded Signup connection was completed'`,
  },
];

const tableExists = async (name) => {
  const [rows] = await db.sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = :name`,
    { replacements: { name } },
  );
  return Number(rows?.[0]?.n || 0) > 0;
};

const columnExists = async (table, name) => {
  const [rows] = await db.sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :name`,
    { replacements: { table, name } },
  );
  return Number(rows?.[0]?.n || 0) > 0;
};

const getEnumValues = async (table, column) => {
  const [rows] = await db.sequelize.query(
    `SELECT COLUMN_TYPE AS column_type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
    { replacements: { table, column } },
  );
  const type = rows?.[0]?.column_type;
  if (!type || !/^enum\(/i.test(type)) return null;
  return [...type.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

const enumList = (values) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");

const setEnumValues = async (table, column, values) => {
  await db.sequelize.query(
    `ALTER TABLE ${table} MODIFY COLUMN ${column} ENUM(${enumList(values)}) NOT NULL`,
  );
};

/**
 * Append ONE enum member without ever risking a blocking table copy.
 *
 * Appending a member at the END of an ENUM (no storage-size change) is an in-place,
 * lock-free operation — but only when the server is explicitly asked for it. A
 * plain MODIFY COLUMN lets MySQL silently fall back to COPY on some versions, which
 * would lock admin_audit_log for the duration. So:
 *   1. ALGORITHM=INSTANT            (MySQL >= 8.0.12)
 *   2. ALGORITHM=INPLACE, LOCK=NONE (MySQL 5.6 / 5.7 / 8.0)
 *   3. otherwise SKIP with a warning — never COPY. The application falls back to an
 *      existing audit action_type (see whatsappCapabilities.service.js), so no
 *      functionality depends on this member existing.
 */
const appendEnumValueSafely = async (table, column, values, newValue) => {
  const [sizeRows] = await db.sequelize.query(
    `SELECT TABLE_ROWS AS approx_rows FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = :table`,
    { replacements: { table } },
  );
  console.log(`[MIGRATION] ${table} ~${sizeRows?.[0]?.approx_rows ?? "?"} rows (estimate)`);

  const next = [...values, newValue];
  for (const clause of ["ALGORITHM=INSTANT", "ALGORITHM=INPLACE, LOCK=NONE"]) {
    try {
      await db.sequelize.query(
        `ALTER TABLE ${table} MODIFY COLUMN ${column} ENUM(${enumList(next)}) NOT NULL, ${clause}`,
      );
      console.log(`[MIGRATION] ${table}.${column} += ${newValue} (${clause})`);
      return true;
    } catch (err) {
      console.log(`[MIGRATION] ${clause} not possible (${err.code || err.message}); trying next`);
    }
  }
  console.warn(
    `[MIGRATION] SKIPPED adding '${newValue}' to ${table}.${column}: no non-blocking ALTER is available on this server. ` +
      "Audit rows will use the existing 'tenant_limit_change' action_type instead. Add the value in a maintenance window if you want the dedicated label.",
  );
  return false;
};

const up = async () => {
  for (const c of COLUMNS) {
    if (!(await columnExists(c.table, c.name))) {
      await db.sequelize.query(c.ddl);
      console.log(`[MIGRATION] ${c.table}.${c.name} added`);
    }
  }

  const values = await getEnumValues("admin_audit_log", "action_type");
  if (values && !values.includes(NEW_AUDIT_ACTION)) {
    await appendEnumValueSafely("admin_audit_log", "action_type", values, NEW_AUDIT_ACTION);
  }

  if (!(await tableExists("whatsapp_number_identities"))) {
    await db.sequelize.query(`
      CREATE TABLE whatsapp_number_identities (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL,
        business_number VARCHAR(24) NOT NULL COMMENT 'Canonical E.164 business number',
        phone_number_id VARCHAR(64) NOT NULL,
        waba_id VARCHAR(64) NULL,
        connection_type VARCHAR(32) NULL,
        migration_mode VARCHAR(24) NOT NULL COMMENT 'LEGACY_SEED | FIRST_CONNECTION | SAME_NUMBER | NEW_NUMBER',
        previous_business_number VARCHAR(24) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_wa_identity_tenant_pid (tenant_id, phone_number_id),
        KEY idx_wa_identity_tenant_number (tenant_id, business_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("[MIGRATION] whatsapp_number_identities table created");
  }
};

const down = async () => {
  if (await tableExists("whatsapp_number_identities")) {
    // A NEW_NUMBER decision is what keeps the previous number's history out of the
    // new number's inbox. Dropping it would re-expose that history, so keep it.
    const [rows] = await db.sequelize.query(
      "SELECT COUNT(*) AS n FROM whatsapp_number_identities WHERE migration_mode = 'NEW_NUMBER'",
    );
    if (Number(rows?.[0]?.n || 0) === 0) {
      await db.sequelize.query("DROP TABLE whatsapp_number_identities");
      console.log("[MIGRATION] whatsapp_number_identities dropped");
    } else {
      console.log("[MIGRATION] NEW_NUMBER decisions exist; whatsapp_number_identities kept");
    }
  }

  for (const c of [...COLUMNS].reverse()) {
    if (await columnExists(c.table, c.name)) {
      await db.sequelize.query(`ALTER TABLE ${c.table} DROP COLUMN ${c.name}`);
      console.log(`[MIGRATION] ${c.table}.${c.name} dropped`);
    }
  }

  const values = await getEnumValues("admin_audit_log", "action_type");
  if (values && values.includes(NEW_AUDIT_ACTION)) {
    // Only safe if no rows use it; otherwise leave the (harmless) enum value in place.
    const [rows] = await db.sequelize.query(
      "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action_type = :a",
      { replacements: { a: NEW_AUDIT_ACTION } },
    );
    if (Number(rows?.[0]?.n || 0) === 0) {
      await setEnumValues(
        "admin_audit_log",
        "action_type",
        values.filter((v) => v !== NEW_AUDIT_ACTION),
      );
      console.log(`[MIGRATION] admin_audit_log.action_type -= ${NEW_AUDIT_ACTION}`);
    } else {
      console.log(
        `[MIGRATION] admin_audit_log rows use ${NEW_AUDIT_ACTION}; enum value kept`,
      );
    }
  }
};

const run = async () => {
  const direction = process.argv[2] === "down" ? "down" : "up";
  console.log(`[MIGRATION] Running ${direction.toUpperCase()} whatsapp_embedded_signup...`);
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
