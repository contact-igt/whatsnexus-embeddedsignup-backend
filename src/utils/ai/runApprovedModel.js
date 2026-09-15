import { randomUUID } from "node:crypto";
import { resolveModel as defaultResolveModel } from "./modelRuntime.js";
import { executeProviderRequest as defaultExecuteProviderRequest, normalizeModelResponse, classifyResponseOutcome, requestByteSize } from "./modelExecutor.js";
import { ModelConfigurationError, assertBillingReadiness, classifyBillingOutcome } from "./modelProfile.js";
import { trackAiTokenUsage as defaultTrackAiTokenUsage } from "./trackAiTokenUsage.js";
import { recordBillingReconciliation as defaultRecordBillingReconciliation } from "../billing/billingHealthMonitor.js";

const OUTCOME_ERROR = {
  refusal: ["AI response was refused by the model.", "AI_OUTPUT_INCOMPLETE"],
  content_filtered: ["AI response was blocked by the content filter.", "AI_OUTPUT_INCOMPLETE"],
  incomplete: ["AI response was incomplete or empty.", "AI_OUTPUT_INCOMPLETE"],
  token_exhausted: ["AI response was cut off before completion.", "AI_OUTPUT_INCOMPLETE"],
  invalid_structured_output: ["AI returned invalid structured output.", "AI_OUTPUT_INVALID"],
};

/**
 * Resolve → preflight tariff → call provider → normalise → classify → bill,
 * preserving the outward callAI() contract. Deps are injectable for tests.
 *
 * Billing policy (see docs/ai-model-catalog/deployment-and-rollback.md):
 *   - provider returned valid billable usage → record + charge once, tagging the
 *     outcome; if the application result is unusable, ALSO raise a controlled
 *     AI error (never a silent empty success).
 *   - usage missing / invalid, or unmappable to the approved tariff → NO charge,
 *     a structured reconciliation event, and a controlled error.
 */
export async function runApprovedModel({ tenantId, purpose, source, correlationId, ...options }, deps = {}) {
  const {
    resolveModel = defaultResolveModel,
    executeProviderRequest = defaultExecuteProviderRequest,
    trackAiTokenUsage = defaultTrackAiTokenUsage,
    recordBillingReconciliation = defaultRecordBillingReconciliation,
  } = deps;
  const corrId = correlationId || randomUUID();

  const resolved = await resolveModel(tenantId, purpose);

  // M1 — every supported OpenAI Chat Completions / Responses request can be
  // served partly from the provider cache, regardless of the profile flag.
  assertBillingReadiness(resolved.profile, resolved.pricing, { cacheCapable: true });

  // Provider call. A throw here means nothing was billed by OpenAI — propagate a
  // controlled error, no reconciliation.
  let raw;
  try {
    raw = await executeProviderRequest(resolved.client, { ...options, model: resolved.model, profile: resolved.profile });
  } catch (error) {
    if (error instanceof ModelConfigurationError) throw error;
    throw new ModelConfigurationError("The AI provider request failed.", "AI_PROVIDER_ERROR", 502);
  }

  // M2 part 1 — a broken usage payload must be reconciled, not lost. The request
  // already cost money at OpenAI.
  let result;
  try {
    result = normalizeModelResponse(raw, resolved.model, resolved.profile.endpoint);
  } catch (error) {
    if (tenantId) {
      await recordBillingReconciliation({
        tenantId, source, reason: "invalid_usage_structure", correlationId: corrId,
        requestedModel: resolved.model, actualModel: typeof raw?.model === "string" ? raw.model.slice(0, 200) : null,
        pricingRuleId: resolved.pricing.id, pricingVersion: resolved.pricing.pricing_version,
        endpoint: resolved.profile.endpoint,
        rawUsageSummary: summariseUsage(raw?.usage),
        error: (error && error.message ? String(error.message) : "usage normalisation failed").slice(0, 300),
      }).catch(() => {});
    }
    throw new ModelConfigurationError("AI usage requires tariff reconciliation.", "AI_BILLING_RECONCILIATION", 502);
  }

  const usage = result.usage;
  const requestBytes = requestByteSize(options.messages);
  const outcome = classifyBillingOutcome({
    profile: resolved.profile, price: resolved.pricing, usage,
    actualModel: result.actualModel, serviceTier: raw?.service_tier ?? null, requestBytes,
  });

  if (!outcome.chargeable) {
    if (tenantId) {
      await recordBillingReconciliation({
        tenantId, source, reason: outcome.reason, correlationId: corrId,
        requestedModel: resolved.model, actualModel: result.actualModel, actualModelMapping: outcome.mapping.matched || null,
        pricingRuleId: resolved.pricing.id, pricingVersion: resolved.pricing.pricing_version,
        endpoint: result.endpoint, serviceTier: raw?.service_tier ?? null,
        usage,
      }).catch(() => {});
    }
    throw new ModelConfigurationError("AI usage requires tariff reconciliation.", "AI_BILLING_RECONCILIATION", 502);
  }

  const responseOutcome = classifyResponseOutcome(result, options.responseFormat);
  const legacyUsage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens };

  if (tenantId) {
    // M2 part 2 — a token-tracking / wallet / ledger failure is reconciled, not
    // swallowed, and the caller gets a controlled error rather than a free call.
    try {
      await trackAiTokenUsage(tenantId, source, { model: resolved.pricing.model, usage: legacyUsage }, {
        pricing: resolved.pricing,
        requestedModel: resolved.requestedModel,
        actualModel: result.actualModel,
        actualModelMapping: outcome.mapping.matched,
        endpoint: result.endpoint,
        fallbackReason: resolved.fallbackReason,
        outcome: responseOutcome,
        correlationId: corrId,
        usage,
      });
    } catch (error) {
      // trackAiTokenUsage already records its own reconciliation event and
      // re-throws with this code — don't double-report.
      if (error?.code !== "AI_BILLING_RECONCILIATION") {
        await recordBillingReconciliation({
          tenantId, source, reason: error?.billingReason || "unknown_tracking_failure", correlationId: corrId,
          requestedModel: resolved.model, actualModel: result.actualModel, actualModelMapping: outcome.mapping.matched,
          pricingRuleId: resolved.pricing.id, pricingVersion: resolved.pricing.pricing_version,
          endpoint: result.endpoint, usage,
          error: (error?.message || "token tracking failed").slice(0, 300),
        }).catch(() => {});
      }
      throw new ModelConfigurationError("AI usage requires tariff reconciliation.", "AI_BILLING_RECONCILIATION", 502);
    }
  }

  // Usable-response gate — AFTER billing (OpenAI charged us for the tokens).
  if (responseOutcome !== "success") {
    const [msg, code] = OUTCOME_ERROR[responseOutcome] || OUTCOME_ERROR.incomplete;
    const err = new ModelConfigurationError(msg, code, 502);
    err.outcome = responseOutcome;
    throw err;
  }

  return { ...result, outcome: responseOutcome, correlationId: corrId, normalizedUsage: usage, usage: { ...legacyUsage, ...usage }, raw };
}

function summariseUsage(u) {
  if (!u || typeof u !== "object") return null;
  const pick = (...keys) => { for (const k of keys) if (Number.isFinite(Number(u[k]))) return Number(u[k]); return null; };
  return {
    input: pick("prompt_tokens", "input_tokens"),
    output: pick("completion_tokens", "output_tokens"),
    total: pick("total_tokens"),
    cached: Number.isFinite(Number(u.prompt_tokens_details?.cached_tokens)) ? Number(u.prompt_tokens_details.cached_tokens)
      : Number.isFinite(Number(u.input_tokens_details?.cached_tokens)) ? Number(u.input_tokens_details.cached_tokens) : null,
  };
}
