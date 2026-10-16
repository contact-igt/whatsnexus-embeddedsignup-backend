/**
 * Decide whether the app may run sequelize.sync({ alter: true }) at startup.
 *
 * Environment is the CANONICAL project selector — ServerEnvironmentConfig.server.line
 * (INVICTUS_SERVER_LINE) — the same value that picks the database connection.
 * NODE_ENV is deliberately NOT consulted: this project does not set it reliably
 * and a missing NODE_ENV must never be read as "not production".
 *
 * @param {object} env - { serverLine, DB_AUTO_MIGRATE, ALLOW_PRODUCTION_SCHEMA_ALTER }
 * @returns {{ isProduction: boolean, autoMigrate: boolean, reason: string }}
 */
export function resolveStartupMigrationMode({ serverLine, DB_AUTO_MIGRATE, ALLOW_PRODUCTION_SCHEMA_ALTER } = {}) {
  const line = String(serverLine || "").trim().toLowerCase();
  const isProduction = line === "production";

  if (isProduction) {
    const allow = ALLOW_PRODUCTION_SCHEMA_ALTER === "true";
    return {
      isProduction: true,
      autoMigrate: allow,
      reason: allow
        ? "production + ALLOW_PRODUCTION_SCHEMA_ALTER=true (explicit override)"
        : "production — explicit-migrations mode (schema preflight only)",
    };
  }

  // non-production
  const autoMigrate = DB_AUTO_MIGRATE !== "false";
  return {
    isProduction: false,
    autoMigrate,
    reason: autoMigrate
      ? `${line || "local"} — auto schema-alter on (set DB_AUTO_MIGRATE=false to disable)`
      : `${line || "local"} — DB_AUTO_MIGRATE=false, explicit-migrations mode`,
  };
}
