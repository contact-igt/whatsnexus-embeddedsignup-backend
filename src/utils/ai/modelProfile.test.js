/**
 * Pure-logic tests for the AI model catalog runtime.
 * Run: node --test src/utils/ai/modelProfile.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateModelId,
  validateRequestProfile,
  validatePricing,
  assertBillingReadiness,
  billingCapabilities,
  normalizeUsage,
  calculateTokenCost,
  activationBlockers,
  matchesApprovedModel,
  resolveApprovedModel,
  ModelConfigurationError,
} from "./modelProfile.js";

const CHAT = "chat_completions";
const chatProfile = (over = {}) => ({
  endpoint: CHAT, usageFormat: CHAT,
  modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: true, supportsJsonMode: true,
  supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [],
  tokenLimitParameter: "max_tokens",
  maxInputBytes: 2_000_000, maxOutputTokens: 8000,
  actualModelIds: ["gpt-4o"],
  ...over,
});
const validPrice = (over = {}) => ({
  model: "gpt-4o", input_rate: 2.5, output_rate: 10, markup_percent: 10,
  usd_to_inr_rate: 93, pricing_version: 1, category: "premium", recommended_for: "output",
  cached_input_price_per_million: 1.25, is_active: true,
  ...over,
});

test("validateModelId rejects junk, accepts real ids", () => {
  assert.equal(validateModelId("gpt-4o-2024-08-06"), "gpt-4o-2024-08-06");
  assert.throws(() => validateModelId(""), ModelConfigurationError);
  assert.throws(() => validateModelId("has space"), ModelConfigurationError);
  assert.throws(() => validateModelId("x".repeat(201)), ModelConfigurationError);
});

test("validateRequestProfile: happy path + rejects unknown fields and bad combos", () => {
  assert.doesNotThrow(() => validateRequestProfile(chatProfile()));
  assert.throws(() => validateRequestProfile({ ...chatProfile(), bogus: 1 }), /Unsupported request profile field/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), maxInputTokens: 500000 }), /Unsupported request profile field/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), endpoint: "assistants" }), /Unsupported endpoint/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), usageFormat: "responses" }), /Usage format/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), modalities: ["image_input"] }), /Text output is required/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), purposes: ["vision"] }), /Vision requires image_input/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), actualModelIds: [] }), /actualModelIds/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), actualModelIds: ["gpt-4o", "gpt-4o"] }), /duplicate/i);
});

test("maxInputBytes / maxOutputTokens bounds", () => {
  assert.throws(() => validateRequestProfile({ ...chatProfile(), maxInputBytes: 0 }), /maxInputBytes/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), maxInputBytes: 9_000_000 }), /maxInputBytes/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), maxOutputTokens: 2_000_000 }), /maxOutputTokens/);
});

test("billingCapabilities: defaults + validation", () => {
  assert.deepEqual(billingCapabilities({}), {
    standardInput: true, cachedInput: false, standardOutput: true,
    longContext: false, cacheWrite: false, tools: false, serviceTier: false,
  });
  assert.doesNotThrow(() => validateRequestProfile(chatProfile({ billingCapabilities: { cachedInput: true, serviceTier: true } })));
  assert.throws(() => validateRequestProfile(chatProfile({ billingCapabilities: { longContext: true } })), /longContext is not implemented/);
  assert.throws(() => validateRequestProfile(chatProfile({ billingCapabilities: { tools: true } })), /tools is not implemented/);
  assert.throws(() => validateRequestProfile(chatProfile({ billingCapabilities: { standardInput: false } })), /standardInput and standardOutput/);
  assert.throws(() => validateRequestProfile(chatProfile({ billingCapabilities: { bogus: true } })), /Unsupported billingCapabilities key/);
  assert.throws(() => validateRequestProfile(chatProfile({ billingCapabilities: { cachedInput: "yes" } })), /must be a boolean/);
});

test("assertBillingReadiness: cached-input requires a cached rate BEFORE the request", () => {
  const cachedProfile = chatProfile({ billingCapabilities: { cachedInput: true } });
  assert.doesNotThrow(() => assertBillingReadiness(cachedProfile, validPrice()));
  assert.throws(
    () => assertBillingReadiness(cachedProfile, validPrice({ cached_input_price_per_million: null })),
    (e) => e.code === "AI_CACHED_PRICING_MISSING",
  );
  // profile that does not claim cachedInput is fine without a cached rate
  assert.doesNotThrow(() => assertBillingReadiness(chatProfile(), validPrice({ cached_input_price_per_million: null })));
});

test("validateRequestProfile: reasoning rules", () => {
  const r = chatProfile({
    supportsReasoning: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low",
    tokenLimitParameter: "max_completion_tokens", supportsTemperature: false, supportsTopP: false,
  });
  assert.doesNotThrow(() => validateRequestProfile(r));
  assert.throws(() => validateRequestProfile({ ...r, tokenLimitParameter: "max_tokens" }), /completion\/output token limit/);
  assert.throws(() => validateRequestProfile({ ...r, defaultReasoningEffort: "medium" }), /defaultReasoningEffort/);
  assert.throws(() => validateRequestProfile({ ...chatProfile(), reasoningEfforts: ["low"] }), /supportsReasoning/);
});

test("responses endpoint requires matching token param", () => {
  const p = chatProfile({ endpoint: "responses", usageFormat: "responses", tokenLimitParameter: "max_output_tokens" });
  assert.doesNotThrow(() => validateRequestProfile(p));
  assert.throws(() => validateRequestProfile({ ...p, tokenLimitParameter: "max_tokens" }), /Token limit parameter/);
});

test("resolveApprovedModel / matchesApprovedModel: exact, versioned, collision, malformed", () => {
  const p = chatProfile({ actualModelIds: ["gpt-4o", "gpt-4o-mini"], allowVersionedActuals: true });
  assert.deepEqual(resolveApprovedModel(p, "gpt-4o"), { matched: "gpt-4o", kind: "exact", reason: null });
  assert.equal(resolveApprovedModel(p, "gpt-4o-2024-08-06").matched, "gpt-4o");
  assert.equal(resolveApprovedModel(p, "gpt-4o-2024-08-06").kind, "versioned");
  // gpt-4o must NOT swallow gpt-4o-mini-*  (mini is its own approved id → exact wins, but a non-approved mini date must not map to gpt-4o)
  const q = chatProfile({ actualModelIds: ["gpt-4o"], allowVersionedActuals: true });
  assert.equal(matchesApprovedModel(q, "gpt-4o-mini"), false);
  assert.equal(matchesApprovedModel(q, "gpt-4o-mini-2024-07-18"), false);
  assert.equal(matchesApprovedModel(q, "gpt-4o-audio-preview"), false);
  // versioned matching disabled
  const strict = chatProfile({ actualModelIds: ["gpt-4o"], allowVersionedActuals: false });
  assert.equal(matchesApprovedModel(strict, "gpt-4o-2024-08-06"), false);
  // malformed id
  assert.equal(resolveApprovedModel(q, "gpt 4o").matched, null);
  assert.equal(resolveApprovedModel(q, "").matched, null);
  assert.equal(resolveApprovedModel(q, null).matched, null);
});

test("normalizeUsage: chat + responses, no reasoning double-count, derives total", () => {
  const chat = normalizeUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 999, completion_tokens_details: { reasoning_tokens: 10 } } }, "chat_completions");
  assert.deepEqual(chat, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 10, totalTokens: 150 });
  const resp = normalizeUsage({ usage: { input_tokens: 200, output_tokens: 80, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 30 } } }, "responses");
  assert.deepEqual(resp, { inputTokens: 200, cachedInputTokens: 40, outputTokens: 80, reasoningTokens: 30, totalTokens: 280 });
  assert.throws(() => normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 99 } } }, "chat_completions"), /Inconsistent/);
  assert.throws(() => normalizeUsage({}, "chat_completions"), /did not return usage/);
});

test("calculateTokenCost: uncached/cached/output split + markup, blocks unpriced cache, zero cached ok", () => {
  const c = calculateTokenCost(validPrice(), { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500 });
  // uncached 800*2.5 + cached 200*1.25 + output 500*10 = 2000 + 250 + 5000 = 7250 / 1e6 = 0.00725
  assert.ok(Math.abs(c.baseCostUsd - 0.00725) < 1e-9);
  assert.ok(Math.abs(c.finalCostUsd - 0.007975) < 1e-9);
  assert.equal(calculateTokenCost(validPrice(), { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 }).cachedInputCost, 0);
  assert.throws(
    () => calculateTokenCost(validPrice({ cached_input_price_per_million: null }), { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 10 }),
    (e) => e.code === "AI_CACHED_PRICING_MISSING",
  );
  assert.doesNotThrow(() => calculateTokenCost(validPrice({ cached_input_price_per_million: null }), { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 10 }));
});

test("validatePricing: finite non-negative, version, category", () => {
  assert.doesNotThrow(() => validatePricing(validPrice()));
  assert.throws(() => validatePricing(validPrice({ input_rate: -1 })), /input_rate/);
  assert.throws(() => validatePricing(validPrice({ usd_to_inr_rate: 0 })), /usd_to_inr_rate/);
  assert.throws(() => validatePricing(validPrice({ pricing_version: 0 })), /pricing version/);
  assert.throws(() => validatePricing(validPrice({ category: "cheap" })), /category/);
  assert.throws(() => validatePricing(validPrice({ cached_input_price_per_million: -1 })), /cached input price/i);
  assert.throws(() => validatePricing(null), /pricing is required/);
});

test("activationBlockers: activation vs runtime, legacy_grandfathered", () => {
  const passed = { review_status: "approved", lifecycle_status: "available", request_profile: chatProfile(), test_status: "passed" };
  assert.deepEqual(activationBlockers(passed, validPrice(), { forActivation: true }), []);
  assert.deepEqual(activationBlockers(passed, validPrice(), { forActivation: false }), []);

  const legacy = { ...passed, test_status: "legacy_grandfathered" };
  // runtime: acceptable
  assert.deepEqual(activationBlockers(legacy, validPrice(), { forActivation: false }), []);
  // fresh activation: NOT acceptable
  assert.ok(activationBlockers(legacy, validPrice(), { forActivation: true }).some(b => /live compatibility test/i.test(b)));

  const failed = { ...passed, test_status: "failed" };
  assert.ok(activationBlockers(failed, validPrice(), { forActivation: false }).length);

  // billing readiness folded into blockers
  const cachedNoRate = { ...passed, request_profile: chatProfile({ billingCapabilities: { cachedInput: true } }) };
  assert.ok(activationBlockers(cachedNoRate, validPrice({ cached_input_price_per_million: null }), { forActivation: true }).some(b => /cached-input rate/i.test(b)));

  assert.ok(activationBlockers({ ...passed, review_status: "pending" }, validPrice(), { forActivation: true }).length);
  assert.ok(activationBlockers({ ...passed, lifecycle_status: "shutdown" }, validPrice(), { forActivation: true }).length);
  assert.ok(activationBlockers(passed, null, { forActivation: true }).length);
  assert.ok(activationBlockers({ ...passed, shutdown_date: "2000-01-01" }, validPrice(), { forActivation: true }).length);
});
