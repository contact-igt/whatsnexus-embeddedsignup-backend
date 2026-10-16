export class ModelConfigurationError extends Error {
  constructor(message, code = "AI_MODEL_CONFIGURATION", statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateModelId(model) {
  if (typeof model !== "string" || model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:\-]*$/.test(model)) {
    throw new ModelConfigurationError("Provide an exact valid model ID (maximum 200 characters).");
  }
  return model;
}

const requiredBooleans = ["supportsStructuredOutput", "supportsJsonMode", "supportsTemperature", "supportsTopP", "supportsReasoning"];
const fields = new Set([
  "endpoint", "modalities", "purposes", ...requiredBooleans, "reasoningEfforts", "tokenLimitParameter",
  "usageFormat", "defaultReasoningEffort", "maxInputBytes", "maxOutputTokens", "actualModelIds",
  "allowVersionedActuals", "billingCapabilities",
]);

// Which tariff dimensions this project can currently price. Only standardInput +
// standardOutput are billable; cachedInput needs a reviewed cached rate on the
// pricing row; serviceTier controls whether the "default" tier is requested
// explicitly. longContext / cacheWrite / tools are NOT implemented and must
// stay false — a profile may not claim them.
const BILLING_CAP_KEYS = ["standardInput", "cachedInput", "standardOutput", "longContext", "cacheWrite", "tools", "serviceTier"];
const UNSUPPORTED_TARIFFS = ["longContext", "cacheWrite", "tools"];
export const DEFAULT_BILLING_CAPABILITIES = {
  standardInput: true, cachedInput: false, standardOutput: true,
  longContext: false, cacheWrite: false, tools: false, serviceTier: false,
};

export function billingCapabilities(profile) {
  return { ...DEFAULT_BILLING_CAPABILITIES, ...(profile?.billingCapabilities || {}) };
}

const enumList = (values, allowed, label, allowEmpty = false) => {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || new Set(values).size !== values.length || values.some(value => !allowed.includes(value))) {
    throw new ModelConfigurationError(`Invalid ${label}. Allowed: ${allowed.join(", ")}.`);
  }
};

// Explicit, reviewed opt-in: OpenAI resolves an alias like "gpt-4o" to a dated
// snapshot ("gpt-4o-2024-08-06") in response.model. When the reviewer sets
// allowVersionedActuals, an actual model of the form "<approved>-<one version
// token>" is accepted as the same model. This is an identity check only; billing
// always uses the approved pricing row, never a prefix guess.
// The remainder after "<approved>" must be exactly one version token, e.g.
// "-2024-08-06", "-0125", "-latest". Anchored both ends so "gpt-4o" never
// swallows "gpt-4o-mini-2024-07-18".
const VERSION_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{4,}|latest)$/;

export function matchesApprovedModel(profile, actualModel) {
  return !!resolveApprovedModel(profile, actualModel).matched;
}

/**
 * Resolve a provider-returned model id to exactly one approved id, or explain why not.
 * @returns {{ matched: string|null, kind: "exact"|"versioned"|null, reason: string|null }}
 */
export function resolveApprovedModel(profile, actualModel) {
  if (typeof actualModel !== "string" || !actualModel) return { matched: null, kind: null, reason: "empty or non-string model id" };
  try { validateModelId(actualModel); } catch { return { matched: null, kind: null, reason: "malformed model id" }; }
  const ids = profile?.actualModelIds || [];
  if (ids.includes(actualModel)) return { matched: actualModel, kind: "exact", reason: null };
  if (!profile?.allowVersionedActuals) return { matched: null, kind: null, reason: "no exact approved id; versioned matching disabled" };
  const hits = ids.filter(approved =>
    actualModel.length > approved.length &&
    actualModel.slice(0, approved.length) === approved &&
    VERSION_SUFFIX.test(actualModel.slice(approved.length)),
  );
  if (hits.length === 1) return { matched: hits[0], kind: "versioned", reason: null };
  if (hits.length > 1) return { matched: null, kind: null, reason: `ambiguous: matches ${hits.join(", ")}` };
  return { matched: null, kind: null, reason: "no exact or versioned approved id" };
}

export function validateRequestProfile(profile) {
  // Some MySQL/MariaDB setups return JSON columns as strings (esp. with raw:true).
  if (typeof profile === "string") {
    try { profile = JSON.parse(profile); }
    catch { throw new ModelConfigurationError("The stored request profile is not valid JSON."); }
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new ModelConfigurationError("A reviewed request profile is required.");
  for (const field of Object.keys(profile)) if (!fields.has(field)) throw new ModelConfigurationError(`Unsupported request profile field: ${field}`);
  if (!["chat_completions", "responses"].includes(profile.endpoint)) throw new ModelConfigurationError("Unsupported endpoint.");
  if (profile.usageFormat !== profile.endpoint) throw new ModelConfigurationError("Usage format must match the endpoint.");
  enumList(profile.modalities, ["text", "image_input"], "modalities");
  enumList(profile.purposes, ["input", "output", "vision"], "purposes");
  if (!profile.modalities.includes("text")) throw new ModelConfigurationError("Text output is required.");
  if (profile.purposes.includes("vision") && !profile.modalities.includes("image_input")) throw new ModelConfigurationError("Vision requires image_input.");
  for (const field of requiredBooleans) if (typeof profile[field] !== "boolean") throw new ModelConfigurationError(`${field} must be a boolean.`);
  enumList(profile.reasoningEfforts, ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "reasoningEfforts", !profile.supportsReasoning);
  if (!profile.supportsReasoning && (profile.reasoningEfforts.length || profile.defaultReasoningEffort !== undefined)) throw new ModelConfigurationError("Reasoning settings require supportsReasoning.");
  if (profile.supportsReasoning && !profile.reasoningEfforts.includes(profile.defaultReasoningEffort)) throw new ModelConfigurationError("Select a supported defaultReasoningEffort.");
  const limits = profile.endpoint === "responses" ? ["max_output_tokens"] : ["max_tokens", "max_completion_tokens"];
  if (!limits.includes(profile.tokenLimitParameter)) throw new ModelConfigurationError("Token limit parameter does not match the endpoint.");
  if (profile.supportsReasoning && profile.tokenLimitParameter === "max_tokens") throw new ModelConfigurationError("Reasoning profiles require a completion/output token limit.");
  // maxInputBytes: a serialized-request byte ceiling (NOT a token count). maxOutputTokens is a real token count.
  if (!Number.isSafeInteger(profile.maxInputBytes) || profile.maxInputBytes < 1 || profile.maxInputBytes > 8_000_000) throw new ModelConfigurationError("maxInputBytes must be a positive integer up to 8000000 (serialized request bytes).");
  if (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1 || profile.maxOutputTokens > 1_000_000) throw new ModelConfigurationError("maxOutputTokens must be a positive integer at most 1000000.");
  if (!Array.isArray(profile.actualModelIds) || !profile.actualModelIds.length || profile.actualModelIds.length > 30) throw new ModelConfigurationError("List the exact approved returned model IDs in actualModelIds.");
  profile.actualModelIds.forEach(validateModelId);
  if (new Set(profile.actualModelIds).size !== profile.actualModelIds.length) throw new ModelConfigurationError("actualModelIds must not contain duplicates.");
  if (profile.allowVersionedActuals !== undefined && typeof profile.allowVersionedActuals !== "boolean") throw new ModelConfigurationError("allowVersionedActuals must be a boolean.");

  if (profile.billingCapabilities !== undefined) {
    const bc = profile.billingCapabilities;
    if (!bc || typeof bc !== "object" || Array.isArray(bc)) throw new ModelConfigurationError("billingCapabilities must be an object.");
    for (const key of Object.keys(bc)) if (!BILLING_CAP_KEYS.includes(key)) throw new ModelConfigurationError(`Unsupported billingCapabilities key: ${key}`);
    for (const key of BILLING_CAP_KEYS) if (bc[key] !== undefined && typeof bc[key] !== "boolean") throw new ModelConfigurationError(`billingCapabilities.${key} must be a boolean.`);
    if (bc.standardInput === false || bc.standardOutput === false) throw new ModelConfigurationError("standardInput and standardOutput billing must be enabled.");
    for (const key of UNSUPPORTED_TARIFFS) if (bc[key] === true) throw new ModelConfigurationError(`billingCapabilities.${key} is not implemented — leave it false and keep requests on standard pricing.`);
  }
  return profile;
}

export function validatePricing(price) {
  if (!price) throw new ModelConfigurationError("Exact pricing is required.");
  validateModelId(price.model);
  for (const field of ["input_rate", "output_rate", "markup_percent", "usd_to_inr_rate"]) {
    const raw = price[field];
    const number = Number(raw);
    if (raw === null || raw === undefined || String(raw).trim() === "" || !Number.isFinite(number) || number < 0 || (field === "usd_to_inr_rate" && number === 0)) throw new ModelConfigurationError(`Invalid ${field}.`);
  }
  if (Number(price.markup_percent) > 999.99) throw new ModelConfigurationError("Markup exceeds the supported range.");
  if (price.cached_input_price_per_million != null && (String(price.cached_input_price_per_million).trim() === "" || !Number.isFinite(Number(price.cached_input_price_per_million)) || Number(price.cached_input_price_per_million) < 0)) throw new ModelConfigurationError("Invalid cached input price.");
  if (!Number.isSafeInteger(Number(price.pricing_version)) || Number(price.pricing_version) < 1) throw new ModelConfigurationError("Invalid pricing version.");
  if (!["premium", "mid-tier", "budget", "reasoning"].includes(price.category)) throw new ModelConfigurationError("Invalid pricing category.");
  if (!["input", "output", "both"].includes(price.recommended_for)) throw new ModelConfigurationError("Invalid recommended purpose.");
  return price;
}

// Service tiers that bill at the standard rate.
const STANDARD_SERVICE_TIERS = new Set(["default", "auto", "standard", "", "null"]);

/**
 * POST-response decision: can this usage be charged against the approved
 * standard-tariff pricing rule? Only dimensions that cannot be known before the
 * call are judged here. Returns { chargeable, reason }.
 */
export function classifyBillingOutcome({ profile, price, usage, actualModel, serviceTier, requestBytes }) {
  const mapping = resolveApprovedModel(profile, actualModel);
  if (!mapping.matched) return { chargeable: false, reason: "unmapped_actual_model", mapping };
  if (serviceTier != null && !STANDARD_SERVICE_TIERS.has(String(serviceTier).toLowerCase())) {
    return { chargeable: false, reason: "unsupported_service_tier", mapping };
  }
  if ((usage.cachedInputTokens || 0) > 0 && price.cached_input_price_per_million == null) {
    return { chargeable: false, reason: "cached_input_unpriced", mapping };
  }
  if (Number.isFinite(requestBytes) && Number.isFinite(profile.maxInputBytes) && requestBytes > profile.maxInputBytes) {
    return { chargeable: false, reason: "request_over_max_bytes", mapping };
  }
  return { chargeable: true, reason: null, mapping };
}

/**
 * Preflight, run BEFORE the provider request. Every tariff the approved profile
 * (or a known cache-capable model) can produce must be priced on the selected
 * rule, or a controlled error is raised so no billable request is ever made
 * against an incomplete pricing rule.
 *
 * This is one link in the chain:
 *   eligibleModel / activationBlockers  -> approved | legacy runtime eligibility,
 *                                          valid pricing version, exact pricing row
 *   assertBillingReadiness (here)       -> standard in/out priced, cached priced
 *                                          when caching may occur, no unsupported tariff
 *   buildModelRequest                   -> supported input-size range
 *   classifyBillingOutcome (post-call)  -> exact model mapping, supported service
 *                                          tier, unexpected cached usage
 *
 * @param {object} profile - reviewed request profile
 * @param {object} price    - active AiPricing row
 * @param {object} [opts]
 * @param {boolean} [opts.cacheCapable] - force the cached-rate requirement even
 *   when billingCapabilities.cachedInput is false (the provider may still return
 *   cached tokens). Defaults to the profile's cachedInput capability.
 */
export function assertBillingReadiness(profile, price, opts = {}) {
  validatePricing(price); // rates finite/non-negative, valid pricing_version, category
  if (price.is_active === false) {
    throw new ModelConfigurationError("Pricing rule is not active.", "AI_TARIFF_UNSUPPORTED", 409);
  }
  const bc = billingCapabilities(profile);
  const cacheCapable = opts.cacheCapable === undefined ? bc.cachedInput : !!opts.cacheCapable;
  if (cacheCapable && price.cached_input_price_per_million == null) {
    const err = new ModelConfigurationError(
      "This model's requests can be served partly from the provider cache, but its pricing rule has no cached-input rate.",
      "AI_TARIFF_UNSUPPORTED", 409,
    );
    err.reason = "CACHED_INPUT_RATE_MISSING"; // safe internal reason — never sent to a tenant
    throw err;
  }
  for (const key of UNSUPPORTED_TARIFFS) {
    if (bc[key]) {
      const err = new ModelConfigurationError(`Tariff "${key}" is not supported yet.`, "AI_TARIFF_UNSUPPORTED", 409);
      err.reason = `${key.toUpperCase()}_TARIFF_UNSUPPORTED`;
      throw err;
    }
  }
  return bc;
}

export function normalizeUsage(response, endpoint) {
  const usage = response?.usage;
  if (!usage) throw new ModelConfigurationError("Provider did not return usage.", "AI_USAGE_MISSING", 502);
  const isChat = endpoint === "chat_completions";
  const inputTokens = isChat ? usage.prompt_tokens : usage.input_tokens;
  const outputTokens = isChat ? usage.completion_tokens : usage.output_tokens;
  const result = {
    inputTokens,
    cachedInputTokens: (isChat ? usage.prompt_tokens_details : usage.input_tokens_details)?.cached_tokens ?? 0,
    outputTokens,
    reasoningTokens: (isChat ? usage.completion_tokens_details : usage.output_tokens_details)?.reasoning_tokens ?? 0,
    // Derive the total from the billable parts so a provider accounting change to
    // total_tokens (e.g. a new sub-category) never blocks a real request.
    totalTokens: Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) ? inputTokens + outputTokens : usage.total_tokens,
  };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 0) throw new ModelConfigurationError(`Invalid provider usage: ${key}`, "AI_USAGE_INVALID", 502);
  if (result.cachedInputTokens > result.inputTokens || result.reasoningTokens > result.outputTokens) throw new ModelConfigurationError("Inconsistent provider usage.", "AI_USAGE_INVALID", 502);
  return result;
}

export function calculateTokenCost(price, usage) {
  validatePricing(price);
  const cachedInputTokens = usage.cachedInputTokens || 0;
  if (cachedInputTokens > 0 && price.cached_input_price_per_million == null) {
    const err = new ModelConfigurationError("Cached-input pricing is not approved.", "AI_TARIFF_UNSUPPORTED", 409);
    err.reason = "CACHED_INPUT_RATE_MISSING";
    throw err;
  }
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const inputCost = (uncachedInputTokens / 1000000) * Number(price.input_rate);
  const cachedInputCost = (cachedInputTokens / 1000000) * Number(price.cached_input_price_per_million ?? 0);
  const outputCost = (usage.outputTokens / 1000000) * Number(price.output_rate);
  const baseCostUsd = inputCost + cachedInputCost + outputCost;
  return { baseCostUsd, finalCostUsd: baseCostUsd * (1 + Number(price.markup_percent) / 100), inputCost, cachedInputCost, outputCost };
}

const ACTIVATABLE_TEST_STATUSES = new Set(["passed"]);
const RUNTIME_OK_TEST_STATUSES = new Set(["passed", "legacy_grandfathered"]);
export const CATALOG_TEST_STATUSES = ["not_tested", "passed", "failed", "legacy_grandfathered"];

/**
 * @param {object} catalog
 * @param {object} price
 * @param {object} [opts]
 * @param {boolean} [opts.forActivation=true] - true = gating a fresh activation
 *   (requires a real passed live test); false = runtime eligibility for a model
 *   that is already active (legacy_grandfathered is acceptable).
 */
export function activationBlockers(catalog, price, opts = {}) {
  const { forActivation = true } = opts;
  const blockers = [];
  if (catalog.review_status !== "approved") blockers.push("Model requires approval.");
  if (["shutdown", "unknown"].includes(catalog.lifecycle_status) || (catalog.shutdown_date && new Date(catalog.shutdown_date).getTime() <= Date.now())) blockers.push("Model availability is not confirmed or has ended.");
  let profile = null;
  try { profile = validateRequestProfile(catalog.request_profile); } catch (error) { blockers.push(error.message); }
  try { validatePricing(price); } catch (error) { blockers.push(error.message); }
  if (profile && price) {
    // Runtime treats every supported OpenAI request as cache-capable because
    // the provider may apply prompt caching automatically. Activation and the
    // rollout checker must enforce that same rule, otherwise a model can pass
    // preflight and then fail every live request.
    try { assertBillingReadiness(profile, price, { cacheCapable: true }); } catch (error) { blockers.push(error.message); }
  }
  const okStatuses = forActivation ? ACTIVATABLE_TEST_STATUSES : RUNTIME_OK_TEST_STATUSES;
  if (!okStatuses.has(catalog.test_status)) {
    blockers.push(forActivation ? "A successful live compatibility test is required." : "The model has no passing compatibility status.");
  }
  return blockers;
}
