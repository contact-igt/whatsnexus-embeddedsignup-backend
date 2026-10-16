import { logger } from "../logger.js";

/**
 * Verify the AI model catalog migrations have been applied. Cheap, read-only,
 * dialect-agnostic (uses describeTable). Returns a list of problems; empty = ok.
 */
export async function checkCatalogSchema(db) {
  const problems = [];
  const qi = db.sequelize.getQueryInterface();

  const describe = async (table) => {
    try { return await qi.describeTable(table); } catch { return null; }
  };

  const catalog = await describe("ai_model_catalog");
  if (!catalog) problems.push("table ai_model_catalog is missing — run migrations/20260910_ai_model_catalog.js");
  else if (!catalog.request_profile) problems.push("ai_model_catalog.request_profile column is missing");

  const sync = await describe("ai_model_sync");
  if (!sync) problems.push("table ai_model_sync is missing — run migrations/20260910_ai_model_catalog.js");

  const pricing = await describe("ai_pricing");
  if (pricing && !pricing.cached_input_price_per_million) {
    problems.push("ai_pricing.cached_input_price_per_million column is missing — run migrations/20260910_ai_model_catalog.js");
  }

  const usage = await describe("ai_token_usage");
  if (usage) {
    for (const col of ["requested_model", "actual_model", "pricing_rule_id", "endpoint", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"]) {
      if (!usage[col]) problems.push(`ai_token_usage.${col} column is missing — run migrations/20260910_ai_model_catalog.js`);
    }
  }

  return problems;
}

/**
 * Startup preflight. In production (auto-migrate off) a missing migration is
 * fatal — fail fast with a clear message rather than limping along.
 */
export async function assertCatalogSchema(db, { fatal }) {
  const problems = await checkCatalogSchema(db);
  if (!problems.length) {
    logger.info("[SCHEMA-PREFLIGHT] AI model catalog schema OK");
    return;
  }
  const message = `[SCHEMA-PREFLIGHT] AI model catalog schema is not up to date:\n  - ${problems.join("\n  - ")}`;
  if (fatal) {
    logger.error(message);
    throw new Error("AI model catalog migrations have not been applied. Run migrations before deploying.");
  }
  logger.warn(message);
}
