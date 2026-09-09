/**
 * Backfill verified cached-input rates onto active AiPricing rows and flip the
 * matching catalog profile's billingCapabilities.cachedInput to true.
 *
 *   node src/scripts/backfillAiCachedInputPricing.js --dry-run
 *   node src/scripts/backfillAiCachedInputPricing.js --apply
 *
 * Rules:
 *   - rates come only from src/config/aiCachedInputPricing.js (reviewed config)
 *   - never overwrites an existing non-null cached-input rate
 *   - --apply required for any write; --dry-run just reports
 *   - increments pricing_version when a cached rate is added
 *   - historical AiTokenUsage / BillingLedger snapshots are never touched
 *   - unverified / unknown models are reported as blocked, not modified
 */
import { pathToFileURL } from "node:url";
import { CACHED_INPUT_PRICING_REVIEWED_ON, reviewedCachedRate } from "../config/aiCachedInputPricing.js";
import { billingCapabilities } from "../utils/ai/modelProfile.js";

const parseProfile = v => {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
};

/**
 * @param {object} opts
 * @param {import("../database/index.js").default} opts.db
 * @param {boolean} [opts.apply=false]
 * @returns {Promise<{ applied: Array, blocked: Array, skipped: Array, reviewedOn: string }>}
 */
export async function backfillCachedInputPricing({ db, apply = false }) {
  const prices = await db.AiPricing.findAll({ where: { is_active: true }, raw: true });
  const applied = [];
  const blocked = [];
  const skipped = [];

  for (const price of prices) {
    const { rate, verified, known } = reviewedCachedRate(price.model);

    if (price.cached_input_price_per_million != null) {
      skipped.push({ model: price.model, reason: "already has a cached-input rate", rate: Number(price.cached_input_price_per_million) });
      continue;
    }
    if (!known || !verified || rate == null) {
      blocked.push({ model: price.model, reason: known ? "cached rate not verified in config" : "no reviewed cached rate", cached_input_execution: "blocked" });
      continue;
    }

    const fromVersion = Number(price.pricing_version) || 1;
    const toVersion = fromVersion + 1;
    const catalog = await db.AiModelCatalog.findOne({ where: { provider: "openai", model: price.model } });
    const profile = catalog ? parseProfile(catalog.request_profile) : null;
    const nextCaps = { ...billingCapabilities(profile), cachedInput: true };

    if (apply) {
      await db.sequelize.transaction(async transaction => {
        await db.AiPricing.update(
          { cached_input_price_per_million: rate, pricing_version: toVersion },
          { where: { id: price.id, cached_input_price_per_million: null }, transaction },
        );
        if (catalog && profile) {
          await catalog.update({ request_profile: { ...profile, billingCapabilities: nextCaps } }, { transaction });
        }
      });
    }
    applied.push({
      model: price.model, rate, pricing_version_from: fromVersion, pricing_version_to: toVersion,
      catalog_profile: catalog ? "billingCapabilities.cachedInput -> true" : "no catalog row (rate only)",
    });
  }

  return { applied, blocked, skipped, reviewedOn: CACHED_INPUT_PRICING_REVIEWED_ON };
}

function report(result, apply) {
  console.log(`\nCached-input pricing backfill  (config reviewed ${result.reviewedOn})`);
  console.log(apply ? "MODE: APPLY (writing)\n" : "MODE: DRY RUN (no writes)\n");
  const rows = arr => arr.length ? arr.map(r => "  " + JSON.stringify(r)).join("\n") : "  (none)";
  console.log(`APPLIED / WOULD APPLY (${result.applied.length}):\n${rows(result.applied)}`);
  console.log(`\nBLOCKED for cached-input execution (${result.blocked.length}):\n${rows(result.blocked)}`);
  console.log(`\nSKIPPED — already priced (${result.skipped.length}):\n${rows(result.skipped)}`);
  if (result.blocked.length) console.log("\n⚠  Blocked models will trigger a reconciliation event if OpenAI returns cached tokens. Add verified rates to src/config/aiCachedInputPricing.js.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) {
    console.error("Pass exactly one of --dry-run or --apply");
    process.exit(2);
  }
  const { default: db } = await import("../database/index.js");
  try {
    const result = await backfillCachedInputPricing({ db, apply });
    report(result, apply);
  } finally {
    await db.sequelize.close();
  }
}
