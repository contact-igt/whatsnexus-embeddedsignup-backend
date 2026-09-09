// Additive + one-time grandfather. Does NOT approve/activate any newly
// discovered model and does not change tenant selections, global defaults, or
// historical billing rows. It only:
//   1. creates the ai_model_catalog / ai_model_sync tables,
//   2. adds new nullable billing/usage columns,
//   3. registers every existing AiPricing model + the seed candidates as catalog
//      rows (pending by default),
//   4. grandfathers models that are ALREADY is_active in AiPricing into an
//      approved+profiled+tested catalog row so current execution keeps working.
import { pathToFileURL } from "node:url";

// Reviewed request profiles for the models this project already runs in
// production. Anything not listed stays pending and cannot execute until an
// admin reviews it through the catalog UI.
const CHAT = "chat_completions";
// billingCapabilities.cachedInput stays false here; the backfill script flips it
// once a verified cached rate is on the pricing row.
const CAPS = { standardInput: true, cachedInput: false, standardOutput: true, longContext: false, cacheWrite: false, tools: false, serviceTier: false };
const base = (over = {}) => ({
  endpoint: CHAT, usageFormat: CHAT,
  modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: true, supportsJsonMode: true,
  supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [],
  tokenLimitParameter: "max_tokens",
  maxInputBytes: 2000000, maxOutputTokens: 8000,
  allowVersionedActuals: true,
  billingCapabilities: { ...CAPS },
  ...over,
});
const reasoning = (over = {}) => base({
  supportsTemperature: false, supportsTopP: false,
  supportsReasoning: true, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium",
  tokenLimitParameter: "max_completion_tokens",
  maxInputBytes: 1200000, maxOutputTokens: 32000,
  ...over,
});
const vision = ["text", "image_input"];

const GRANDFATHER_PROFILES = {
  "gpt-4o": base({ modalities: vision, purposes: ["input", "output", "vision"], actualModelIds: ["gpt-4o", "gpt-4o-2024-11-20", "gpt-4o-2024-08-06", "gpt-4o-2024-05-13"] }),
  "gpt-4o-mini": base({ modalities: vision, purposes: ["input", "output", "vision"], actualModelIds: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"] }),
  "gpt-4.1": base({ modalities: vision, purposes: ["input", "output", "vision"], maxInputBytes: 4000000, actualModelIds: ["gpt-4.1", "gpt-4.1-2025-04-14"] }),
  "gpt-4.1-mini": base({ modalities: vision, purposes: ["input", "output", "vision"], maxInputBytes: 4000000, actualModelIds: ["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"] }),
  "gpt-4.1-nano": base({ modalities: vision, purposes: ["input"], maxInputBytes: 4000000, actualModelIds: ["gpt-4.1-nano", "gpt-4.1-nano-2025-04-14"] }),
  "gpt-5.4": base({ modalities: vision, purposes: ["output", "vision"], actualModelIds: ["gpt-5.4"] }),
  "gpt-5.4-mini": base({ modalities: vision, purposes: ["input", "output", "vision"], actualModelIds: ["gpt-5.4-mini"] }),
  "gpt-5.4-nano": base({ purposes: ["input"], actualModelIds: ["gpt-5.4-nano"] }),
  "o3": reasoning({ modalities: vision, purposes: ["output", "vision"], actualModelIds: ["o3", "o3-2025-04-16"] }),
  "o3-mini": reasoning({ purposes: ["input", "output"], actualModelIds: ["o3-mini", "o3-mini-2025-01-31"] }),
  "o4-mini": reasoning({ modalities: vision, purposes: ["input", "output", "vision"], actualModelIds: ["o4-mini", "o4-mini-2025-04-16"] }),
};

export async function up(db) {
  const qi = db.sequelize.getQueryInterface();
  await db.AiModelCatalog.sync();
  await db.AiModelSync.sync();

  const addMissing = async (model, fields) => {
    const table = model.getTableName();
    const existing = await qi.describeTable(table);
    for (const field of fields) {
      if (!existing[field]) {
        const attribute = model.rawAttributes[field];
        await qi.addColumn(table, field, { type: attribute.type, allowNull: true });
      }
    }
  };
  await addMissing(db.AiPricing, ["cached_input_price_per_million"]);
  await addMissing(db.AiTokenUsage, [
    "requested_model", "actual_model", "pricing_model", "endpoint", "pricing_rule_id",
    "fallback_reason", "input_tokens", "cached_input_tokens", "output_tokens",
    "reasoning_tokens", "cached_input_price_per_million",
  ]);

  const prices = await db.AiPricing.findAll({ raw: true });
  const now = new Date();

  // 1. Register every known model as a catalog row (pending unless grandfathered below).
  const known = [...new Set([...prices.map(p => p.model), "gpt-5.6-luna", "gpt-5.6-terra"])];
  for (const model of known) {
    await db.AiModelCatalog.findOrCreate({
      where: { provider: "openai", model },
      defaults: { review_status: "pending", lifecycle_status: "unknown", test_status: "not_tested", first_seen_at: now },
    });
  }

  // 2. Grandfather models already active in AiPricing so current flows keep working.
  //    New models discovered by sync are never touched here.
  for (const price of prices) {
    if (!price.is_active) continue;
    const profile = GRANDFATHER_PROFILES[price.model];
    if (!profile) {
      console.warn(`[grandfather] active pricing for "${price.model}" has no reviewed profile — leaving it pending. It will stop executing until an admin reviews it.`);
      continue;
    }
    if (price.pricing_version == null) {
      await db.AiPricing.update({ pricing_version: 1 }, { where: { id: price.id } });
    }
    const [entry] = await db.AiModelCatalog.findOrCreate({
      where: { provider: "openai", model: price.model },
      defaults: { first_seen_at: now },
    });
    // Preserve any prior admin review; only fill in a still-pending row.
    if (entry.review_status === "approved") continue;
    await entry.update({
      review_status: "approved",
      lifecycle_status: "available",
      request_profile: profile,
      reviewed_at: now,
      reviewed_by: "system-grandfather",
      // Not a live test — existing tenants keep running; a fresh activation or a
      // new tenant assignment still requires a real passed compatibility test.
      test_status: "legacy_grandfathered",
      last_tested_at: null,
      test_result: { grandfathered: true, status: "legacy_grandfathered", note: `Adopted from pre-existing active AiPricing on ${now.toISOString()}` },
      activated_at: now,
      activated_by: "system-grandfather",
    });
  }
  console.log(`[ai-model-catalog] up complete: ${known.length} catalog rows, ${prices.filter(p => p.is_active && GRANDFATHER_PROFILES[p.model]).length} grandfathered.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "down") throw new Error("Rollback application code; retain the additive catalog and billing-history columns.");
  const { default: db } = await import("../src/database/index.js");
  try { await up(db); } finally { await db.sequelize.close(); }
}
