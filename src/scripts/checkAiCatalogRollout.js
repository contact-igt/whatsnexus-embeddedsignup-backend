/**
 * Pre-rollout preflight. FAILS (exit 1) only if a model that is in use — active
 * pricing, or referenced by a tenant selection — cannot run at runtime
 * (missing catalog row / review / profile / pricing / billing readiness).
 *
 * legacy_grandfathered models are reported as WARNINGS (they run today; a fresh
 * activation or new tenant assignment still needs a real live test).
 *
 *   node src/scripts/checkAiCatalogRollout.js
 */
import db from "../database/index.js";
import { activationBlockers } from "../utils/ai/modelProfile.js";

const parseSettings = v => {
  if (!v) return {};
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } }
  return v;
};

try {
  const [prices, models, tenants] = await Promise.all([
    db.AiPricing.findAll({ where: { is_active: true }, raw: true }),
    db.AiModelCatalog.findAll({ raw: true }),
    db.Tenants.findAll({ where: { is_deleted: false }, attributes: ["tenant_id", "ai_settings"], raw: true }),
  ]);

  const required = new Set(["gpt-4o", "gpt-4o-mini", ...prices.map(p => p.model)]);
  for (const tenant of tenants) {
    const s = parseSettings(tenant.ai_settings);
    for (const key of ["input_model", "output_model", "vision_model", "input_fallback_model", "output_fallback_model", "vision_fallback_model"]) {
      if (s[key]) required.add(s[key]);
    }
  }

  const warnings = [];
  for (const model of required) {
    const catalog = models.find(e => e.model === model);
    const price = prices.find(p => p.model === model);
    if (!catalog) { process.exitCode = 1; console.error(`FAIL ${model}: no catalog record — run migrations/20260910_ai_model_catalog.js`); continue; }
    // Runtime eligibility (legacy_grandfathered acceptable).
    const runtimeBlockers = activationBlockers(catalog, price, { forActivation: false });
    if (runtimeBlockers.length) {
      process.exitCode = 1;
      console.error(`FAIL ${model}: ${runtimeBlockers.join(" ")}`);
      continue;
    }
    if (catalog.test_status === "legacy_grandfathered") {
      warnings.push(`${model}: legacy_grandfathered — runs today, but run a live compatibility test before re-activation or assigning to a new tenant.`);
    }
  }

  for (const w of warnings) console.warn(`WARN ${w}`);

  if (!process.exitCode) {
    console.log("Rollout preflight passed. Verify tenant OpenAI credential access separately.");
  }
} finally {
  await db.sequelize.close();
}
