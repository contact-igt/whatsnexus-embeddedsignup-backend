import { resolveModel } from "./modelRuntime.js";
import { executeModel } from "./modelExecutor.js";
import { ModelConfigurationError, matchesApprovedModel } from "./modelProfile.js";
import { trackAiTokenUsage } from "./trackAiTokenUsage.js";
import { recordHealthEvent } from "../billing/billingHealthMonitor.js";

/**
 * Resolve → execute → normalize → bill, preserving the outward callAI() contract.
 * Pricing eligibility is checked (in resolveModel) BEFORE the provider request.
 */
export async function runApprovedModel({ tenantId, purpose, source, ...options }) {
  const resolved = await resolveModel(tenantId, purpose);
  const result = await executeModel(resolved.client, { ...options, model: resolved.model, profile: resolved.profile });
  const usage = result.usage;
  const supportedTier = !result.rawResponse?.service_tier || result.rawResponse.service_tier === "default";
  const modelMatches = matchesApprovedModel(resolved.profile, result.actualModel);

  // Safety: if the returned model, tariff tier, or token volume cannot be mapped
  // to the approved standard-tariff pricing rule, do NOT charge the wallet.
  // Record the discrepancy for manual reconciliation and fail the request.
  if (!modelMatches || !supportedTier || usage.inputTokens > resolved.profile.maxInputTokens || (usage.cachedInputTokens && resolved.pricing.cached_input_price_per_million == null)) {
    if (tenantId) {
      await recordHealthEvent("billing_failure", tenantId, "AI response requires pricing reconciliation; no wallet charge applied.", {
        source, requested_model: resolved.model, actual_model: result.actualModel,
        pricing_rule_id: resolved.pricing.id, pricing_version: resolved.pricing.pricing_version,
        endpoint: result.endpoint, usage,
        reason: !modelMatches ? "unmapped_actual_model" : !supportedTier ? "unsupported_service_tier" : usage.inputTokens > resolved.profile.maxInputTokens ? "input_over_standard_tariff" : "cached_input_unpriced",
      }).catch(() => {});
    }
    throw new ModelConfigurationError("AI usage requires tariff reconciliation.", "AI_BILLING_RECONCILIATION", 502);
  }

  const legacyUsage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens };
  if (tenantId) {
    await trackAiTokenUsage(tenantId, source, { model: resolved.pricing.model, usage: legacyUsage }, {
      pricing: resolved.pricing,
      requestedModel: resolved.requestedModel,
      actualModel: result.actualModel,
      endpoint: result.endpoint,
      fallbackReason: resolved.fallbackReason,
      usage,
    });
  }

  if (result.refusal || result.incomplete || !result.content) {
    throw new ModelConfigurationError("AI response was refused, incomplete, or empty.", "AI_OUTPUT_INCOMPLETE", 502);
  }
  if (options.responseFormat) {
    try { JSON.parse(result.content); } catch { throw new ModelConfigurationError("AI returned invalid JSON.", "AI_OUTPUT_INVALID", 502); }
  }

  return { ...result, normalizedUsage: usage, usage: { ...legacyUsage, ...usage }, raw: result.rawResponse };
}
