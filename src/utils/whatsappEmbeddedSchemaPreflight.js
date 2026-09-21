import { logger } from "./logger.js";

/**
 * Verify the WhatsApp Embedded Signup migrations have been applied.
 *
 * The Sequelize models for tenants / whatsapp_accounts now include the new
 * columns, so deploying the code before the migration would make model queries
 * fail with obscure "Unknown column" errors. Same pattern (and same policy) as
 * utils/ai/catalogSchemaPreflight.js: read-only, dialect-agnostic, and FATAL only
 * in production explicit-migrations mode.
 */
const REQUIRED = [
  {
    table: "tenants",
    columns: ["embedded_signup_enabled", "coexistence_enabled"],
    migration: "20260921_whatsapp_embedded_signup.js",
  },
  {
    table: "whatsapp_accounts",
    columns: ["whatsapp_connection_type", "meta_business_id", "meta_embedded_config_id", "connected_at"],
    migration: "20260921_whatsapp_embedded_signup.js",
  },
  {
    table: "whatsapp_number_identities",
    columns: ["tenant_id", "business_number", "phone_number_id", "migration_mode"],
    migration: "20260921_whatsapp_embedded_signup.js",
  },
  {
    table: "whatsapp_onboarding_sessions",
    columns: ["onboarding_id", "tenant_id", "state", "active_slot", "token_enc", "pin_enc", "recovery_status"],
    migration: "20260922_whatsapp_onboarding_sessions.js",
  },
];

export async function checkWhatsappEmbeddedSchema(db) {
  const problems = [];
  const qi = db.sequelize.getQueryInterface();

  for (const { table, columns, migration } of REQUIRED) {
    let described = null;
    try {
      described = await qi.describeTable(table);
    } catch {
      described = null;
    }
    if (!described) {
      problems.push(`table ${table} is missing — run migrations/${migration}`);
      continue;
    }
    for (const col of columns) {
      if (!described[col]) problems.push(`${table}.${col} column is missing — run migrations/${migration}`);
    }
  }
  return problems;
}

export async function assertWhatsappEmbeddedSchema(db, { fatal }) {
  const problems = await checkWhatsappEmbeddedSchema(db);
  if (!problems.length) {
    logger.info("[SCHEMA-PREFLIGHT] WhatsApp Embedded Signup schema OK");
    return;
  }
  const message = `[SCHEMA-PREFLIGHT] WhatsApp Embedded Signup schema is not up to date:\n  - ${problems.join("\n  - ")}`;
  if (fatal) {
    logger.error(message);
    throw new Error(
      "WhatsApp Embedded Signup migrations have not been applied. Run migrations before deploying.",
    );
  }
  logger.warn(message);
}
