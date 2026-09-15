/**
 * Additive. Creates ai_model_test_attempts (append-only compatibility-test
 * history) and adds last_test_attempt_at / last_test_failure_class to
 * ai_model_catalog. Touches no tenant selection, pricing, or historical row.
 *
 *   node migrations/20260912_ai_model_test_attempts.js
 */
import { pathToFileURL } from "node:url";

export async function up(db) {
  const qi = db.sequelize.getQueryInterface();
  const Sequelize = db.sequelize.constructor;
  await db.AiModelTestAttempts.sync();

  const catalog = db.AiModelCatalog.getTableName();
  const catalogCols = await qi.describeTable(catalog);
  for (const field of ["last_test_attempt_at", "last_test_failure_class"]) {
    if (!catalogCols[field]) {
      const attr = db.AiModelCatalog.rawAttributes[field];
      await qi.addColumn(catalog, field, { type: attr.type, allowNull: true });
    }
  }

  const usage = db.AiTokenUsage.getTableName();
  const usageCols = await qi.describeTable(usage);
  if (!usageCols.outcome) {
    await qi.addColumn(usage, "outcome", { type: db.AiTokenUsage.rawAttributes.outcome.type, allowNull: true });
  }

  // Widen the billing_ledger.billing_status ENUM (additive — existing rows keep
  // their value). Safe to skip if the column isn't an ENUM on this engine.
  try {
    await qi.changeColumn(db.BillingLedger.getTableName(), "billing_status", {
      type: Sequelize.ENUM("charged", "insufficient_balance", "free", "usage_limit_exceeded"),
      allowNull: false,
      defaultValue: "charged",
    });
  } catch (err) {
    console.warn(`[ai-model-test-attempts] billing_status ENUM widen skipped: ${err.message}`);
  }

  console.log("[ai-model-test-attempts] up complete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "down") throw new Error("Additive only — revert application code, keep the history table.");
  const { default: db } = await import("../src/database/index.js");
  try { await up(db); } finally { await db.sequelize.close(); }
}
