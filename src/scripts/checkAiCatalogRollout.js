import db from "../database/index.js";
import { activationBlockers } from "../utils/ai/modelProfile.js";

try {
  const [prices, models, tenants] = await Promise.all([
    db.AiPricing.findAll({ where: { is_active: true }, raw: true }),
    db.AiModelCatalog.findAll({ raw: true }),
    db.Tenants.findAll({ where: { is_deleted: false }, attributes: ["tenant_id", "ai_settings"], raw: true }),
  ]);
  const required = new Set(["gpt-4o", "gpt-4o-mini", ...prices.map(price => price.model)]);
  for (const tenant of tenants) {
    const settings = typeof tenant.ai_settings === "string" ? JSON.parse(tenant.ai_settings) : tenant.ai_settings || {};
    for (const key of ["input_model", "output_model", "input_fallback_model", "output_fallback_model", "vision_fallback_model"]) if (settings[key]) required.add(settings[key]);
  }
  for (const model of required) {
    const catalog = models.find(entry => entry.model === model);
    const blockers = catalog ? activationBlockers(catalog, prices.find(price => price.model === model)) : ["Catalog record missing"];
    if (blockers.length) { process.exitCode = 1; console.error(`${model}: ${blockers.join(" ")}`); }
  }
  if (!process.exitCode) console.log("Catalog review/pricing/test preflight passed. Verify tenant credential access separately before rollout.");
} finally { await db.sequelize.close(); }
