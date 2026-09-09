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
const fields = new Set(["endpoint", "modalities", "purposes", ...requiredBooleans, "reasoningEfforts", "tokenLimitParameter", "usageFormat", "defaultReasoningEffort", "maxInputTokens", "maxOutputTokens", "actualModelIds", "allowVersionedActuals"]);

// Explicit, reviewed opt-in: OpenAI resolves an alias like "gpt-4o" to a dated
// snapshot ("gpt-4o-2024-08-06") in response.model. When the reviewer sets
// allowVersionedActuals, an actual model of the form "<approved>-<date/version>"
// is accepted as the same model. This is an identity check only; billing still
// uses the approved pricing row, never a prefix guess.
// The remainder after "<approved>" must be exactly one version token, e.g.
// "-2024-08-06", "-0125", "-latest". Anchored both ends so "gpt-4o" never
// swallows "gpt-4o-mini-2024-07-18".
const VERSION_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{4,}|latest)$/;
export function matchesApprovedModel(profile, actualModel) {
  if (typeof actualModel !== "string" || !actualModel) return false;
  if (profile.actualModelIds.includes(actualModel)) return true;
  if (!profile.allowVersionedActuals) return false;
  return profile.actualModelIds.some(approved => VERSION_SUFFIX.test(actualModel.slice(approved.length)) && actualModel.slice(0, approved.length) === approved);
}
const enumList = (values, allowed, label, allowEmpty = false) => {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || new Set(values).size !== values.length || values.some(value => !allowed.includes(value))) {
    throw new ModelConfigurationError(`Invalid ${label}. Allowed: ${allowed.join(", ")}.`);
  }
};

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
  for (const field of ["maxInputTokens", "maxOutputTokens"]) {
    if (!Number.isSafeInteger(profile[field]) || profile[field] < 1 || profile[field] > 1000000) throw new ModelConfigurationError(`${field} must be a positive integer at most 1000000; use the standard-tariff limit.`);
  }
  if (!Array.isArray(profile.actualModelIds) || !profile.actualModelIds.length || profile.actualModelIds.length > 30) throw new ModelConfigurationError("List the exact approved returned model IDs in actualModelIds.");
  profile.actualModelIds.forEach(validateModelId);
  if (profile.allowVersionedActuals !== undefined && typeof profile.allowVersionedActuals !== "boolean") throw new ModelConfigurationError("allowVersionedActuals must be a boolean.");
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
    // total_tokens (e.g. adding a new sub-category) never blocks a real request.
    totalTokens: Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) ? inputTokens + outputTokens : usage.total_tokens,
  };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 0) throw new ModelConfigurationError(`Invalid provider usage: ${key}`, "AI_USAGE_INVALID", 502);
  if (result.cachedInputTokens > result.inputTokens || result.reasoningTokens > result.outputTokens) throw new ModelConfigurationError("Inconsistent provider usage.", "AI_USAGE_INVALID", 502);
  return result;
}

export function calculateTokenCost(price, usage) {
  validatePricing(price);
  const cachedInputTokens = usage.cachedInputTokens || 0;
  if (cachedInputTokens > 0 && price.cached_input_price_per_million == null) throw new ModelConfigurationError("Cached-input pricing is not approved.", "AI_TARIFF_UNSUPPORTED", 409);
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const inputCost = (uncachedInputTokens / 1000000) * Number(price.input_rate);
  const cachedInputCost = (cachedInputTokens / 1000000) * Number(price.cached_input_price_per_million ?? 0);
  const outputCost = (usage.outputTokens / 1000000) * Number(price.output_rate);
  const baseCostUsd = inputCost + cachedInputCost + outputCost;
  return { baseCostUsd, finalCostUsd: baseCostUsd * (1 + Number(price.markup_percent) / 100), inputCost, cachedInputCost, outputCost };
}

export function activationBlockers(catalog, price) {
  const blockers = [];
  if (catalog.review_status !== "approved") blockers.push("Model requires approval.");
  if (["shutdown", "unknown"].includes(catalog.lifecycle_status) || (catalog.shutdown_date && new Date(catalog.shutdown_date).getTime() <= Date.now())) blockers.push("Model availability is not confirmed or has ended.");
  try { validateRequestProfile(catalog.request_profile); } catch (error) { blockers.push(error.message); }
  try { validatePricing(price); } catch (error) { blockers.push(error.message); }
  if (catalog.test_status !== "passed") blockers.push("A successful compatibility test is required.");
  return blockers;
}
