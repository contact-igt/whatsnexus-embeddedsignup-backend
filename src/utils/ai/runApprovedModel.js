import { resolveModel as defaultResolveModel } from "./modelRuntime.js";
import { executeModel as defaultExecuteModel, requestByteSize } from "./modelExecutor.js";
import { ModelConfigurationError, assertBillingReadiness, classifyBillingOutcome } from "./modelProfile.js";
import { trackAiTokenUsage as defaultTrackAiTokenUsage } from "./trackAiTokenUsage.js";
import { recordBillingReconciliation as defaultRecordBillingReconciliation } from "../billing/billingHealthMonitor.js";

/**
 * Resolve → execute → normalize → bill, preserving the outward callAI() contract.
 * Pricing eligibility AND tariff readiness are checked (in resolveModel) BEFORE
 * the provider request. Deps are injectable for tests.
 */
export async function runApprovedModel({ tenantId, purpose, source, ...options }, deps = {}) {
  const {
    resolveModel = defaultResolveModel,
    executeModel = defaultExecuteModel,
    trackAiTokenUsage = defaultTrackAiTokenUsage,
    recordBillingReconciliation = defaultRecordBillingReconciliation,
  } = deps;

  const resolved = await resolveModel(tenantId, purpose);

  // Preflight the tariff again with the concrete request in hand.
  assertBillingReadiness(resolved.profile, resolved.pricing);

  const result = await executeModel(resolved.client, { ...options, model: resolved.model, profile: resolved.profile });
  const usage = result.usage;
  const requestBytes = requestByteSize(options.messages);

  // Post-response safety: only usage dimensions that could not be known before
  // the call are judged here. If the response cannot be mapped to the approved
  // standard-tariff pricing rule, do NOT charge the wallet — record a
  // reconciliation event with everything an operator needs and fail the request.
  const outcome = classifyBillingOutcome({
    profile: resolved.profile,
    price: resolved.pricing,
    usage,
    actualModel: result.actualModel,
    serviceTier: result.rawResponse?.service_tier ?? null,
    requestBytes,
  });

  if (!outcome.chargeable) {
    if (tenantId) {
      await recordBillingReconciliation({
        tenantId, source, reason: outcome.reason,
        requestedModel: resolved.model,
        actualModel: result.actualModel,
        actualModelMapping: outcome.mapping.matched || null,
        pricingRuleId: resolved.pricing.id,
        pricingVersion: resolved.pricing.pricing_version,
        endpoint: result.endpoint,
        serviceTier: result.rawResponse?.service_tier ?? null,
        usage,
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
      actualModelMapping: outcome.mapping.matched,
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
