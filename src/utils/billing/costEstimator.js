import { calculateTokenCost, ModelConfigurationError } from "../ai/modelProfile.js";
import db from "../../database/index.js";
import { DEFAULT_MARKUP_PERCENT } from "../../config/billing.config.js";
import { getConversionRate } from "./currencyService.js";
import { logger } from "../logger.js";

// Hardcoded fallback rates per message (USD) — used when no DB pricing exists
const DEFAULT_META_RATES = {
  marketing: 0.075,
  utility: 0.015,
  authentication: 0.015,
  service: 0,
};

/**
 * Estimate cost for a Meta WhatsApp message.
 *
 * @param {string} category  - e.g. "marketing", "utility", "authentication", "service"
 * @param {string} country   - ISO country code or "Global"
 * @returns {Promise<{ baseRate: number, markupPercent: number, platformFee: number, totalCostUsd: number, totalCostInr: number, conversionRate: number, pricingVersion: number|null }>}
 */
export const estimateMetaCost = async (category, country = "Global") => {
  let baseRate = 0;
  let markupPercent = DEFAULT_MARKUP_PERCENT;
  let pricingVersion = null;

  // 1. Try exact match
  let pricingRule = await db.PricingTable.findOne({
    where: { category, country },
    raw: true,
  });

  // 2. Try global fallback
  if (!pricingRule) {
    pricingRule = await db.PricingTable.findOne({
      where: { category, country: "Global" },
      raw: true,
    });
  }

  if (pricingRule) {
    baseRate = parseFloat(pricingRule.rate);
    markupPercent = parseFloat(pricingRule.markup_percent);
    pricingVersion = pricingRule.pricing_version || null;
  } else {
    // 3. Hardcoded fallback
    baseRate = DEFAULT_META_RATES[category] || 0;
  }

  const platformFee = baseRate * (markupPercent / 100);
  const totalCostUsd = baseRate + platformFee;

  // Convert USD → INR via centralized currency service
  const { rate: conversionRate } = await getConversionRate("USD", "INR");
  const totalCostInr = totalCostUsd * conversionRate;

  return {
    baseRate,
    markupPercent,
    platformFee,
    totalCostUsd,
    totalCostInr,
    conversionRate,
    pricingVersion,
  };
};

/**
 * Estimate cost for an AI API call.
 *
 * @param {string} rawModel         - Model name (possibly versioned)
 * @param {number} promptTokens     - Number of input tokens
 * @param {number} completionTokens - Number of output tokens
 * @returns {Promise<{ model: string, baseCostUsd: number, markupPercent: number, finalCostUsd: number, finalCostInr: number, conversionRate: number, pricingVersion: number|null, pricingSnapshot: object }>}
 */
export const estimateAiCost = async (rawModel, promptTokens = 0, completionTokens = 0, context = null) => {
  const price = context?.pricing || await db.AiPricing.findOne({ where: { model: rawModel, is_active: true }, raw: true });
  if (!price) throw new ModelConfigurationError("Exact approved model pricing is required.", "AI_PRICING_MISSING", 409);
  if (!context) {
    const catalog = await db.AiModelCatalog.findOne({ where: { model: rawModel, review_status: "approved" }, raw: true });
    if (!catalog) throw new ModelConfigurationError("Model pricing is not approved.");
  }
  const usage = context?.usage || { inputTokens: promptTokens, cachedInputTokens: 0, outputTokens: completionTokens, reasoningTokens: 0, totalTokens: promptTokens + completionTokens };
  const { baseCostUsd, finalCostUsd } = calculateTokenCost(price, usage);
  const { rate: conversionRate } = await getConversionRate("USD", "INR");
  return { model: price.model, baseCostUsd, markupPercent: Number(price.markup_percent), finalCostUsd,
    finalCostInr: finalCostUsd * conversionRate, conversionRate, pricingVersion: price.pricing_version,
    pricingSnapshot: { input_rate: Number(price.input_rate), cached_input_price_per_million: price.cached_input_price_per_million, output_rate: Number(price.output_rate), markup_percent: Number(price.markup_percent), base_cost_usd: baseCostUsd } };
};

export const estimateTotalCost = (metaCost, aiCost) => {
  return (metaCost?.totalCostInr || 0) + (aiCost?.finalCostInr || 0);
};

/**
 * Invalidate AI pricing cache (e.g. after admin pricing update).
 */
export const invalidateAiPricingCache = () => {}; // Runtime pricing is read without a cache.
