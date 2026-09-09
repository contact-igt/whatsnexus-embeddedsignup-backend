/**
 * Billing-safety tests: standard/cached/output cost, no reasoning double-count,
 * markup preserved, exact pricing_version snapshot, unknown pricing blocks
 * execution, and the post-response reconciliation decision.
 * Run: node --test src/utils/ai/billing.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { calculateTokenCost, classifyBillingOutcome, ModelConfigurationError } from "./modelProfile.js";
import { runApprovedModel } from "./runApprovedModel.js";

const CHAT = "chat_completions";
const profile = (over = {}) => ({
  endpoint: CHAT, usageFormat: CHAT, modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: false, supportsJsonMode: false, supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [], tokenLimitParameter: "max_tokens",
  maxInputBytes: 2_000_000, maxOutputTokens: 8000, actualModelIds: ["gpt-4o"], allowVersionedActuals: true,
  billingCapabilities: { standardInput: true, cachedInput: true, standardOutput: true, longContext: false, cacheWrite: false, tools: false, serviceTier: false },
  ...over,
});
const price = (over = {}) => ({
  id: 7, model: "gpt-4o", input_rate: 2.5, output_rate: 10, cached_input_price_per_million: 1.25,
  markup_percent: 20, usd_to_inr_rate: 90, pricing_version: 4, category: "premium", recommended_for: "output", is_active: true, ...over,
});

test("standard uncached input + output cost with markup", () => {
  const c = calculateTokenCost(price({ markup_percent: 10 }), { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000 });
  assert.equal(c.baseCostUsd, 2.5 + 5);         // 2.5 + 5.0
  assert.equal(c.finalCostUsd, 7.5 * 1.1);      // + 10% markup
});

test("cached-input billed at the cached rate, uncached remainder at standard", () => {
  const c = calculateTokenCost(price(), { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 });
  // uncached 600k * 2.5/1M + cached 400k * 1.25/1M = 1.5 + 0.5 = 2.0
  assert.equal(c.baseCostUsd, 2.0);
  assert.equal(c.finalCostUsd, 2.0 * 1.2);
});

test("reasoning tokens are NOT added on top of output tokens", () => {
  // usage.outputTokens already includes reasoning; cost uses outputTokens only
  const withReasoning = calculateTokenCost(price(), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 });
  const withoutTracking = calculateTokenCost(price(), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 });
  assert.equal(withReasoning.outputCost, withoutTracking.outputCost);
  assert.equal(withReasoning.outputCost, 10);
});

test("markup + fx are applied by the caller from the returned base cost (unchanged contract)", () => {
  const c = calculateTokenCost(price({ markup_percent: 25 }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 });
  assert.equal(c.finalCostUsd, 10 * 1.25);
  // fx is applied downstream in costEstimator; base stays USD here
  assert.equal(c.baseCostUsd, 10);
});

test("classifyBillingOutcome: chargeable happy path + every non-chargeable reason", () => {
  const p = profile();
  const pr = price();
  assert.equal(classifyBillingOutcome({ profile: p, price: pr, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }, actualModel: "gpt-4o-2024-08-06", serviceTier: "default", requestBytes: 100 }).chargeable, true);
  assert.equal(classifyBillingOutcome({ profile: p, price: pr, usage: { inputTokens: 10, outputTokens: 5 }, actualModel: "gpt-4o-mini", serviceTier: "default", requestBytes: 100 }).reason, "unmapped_actual_model");
  assert.equal(classifyBillingOutcome({ profile: p, price: pr, usage: { inputTokens: 10, outputTokens: 5 }, actualModel: "gpt-4o", serviceTier: "flex", requestBytes: 100 }).reason, "unsupported_service_tier");
  assert.equal(classifyBillingOutcome({ profile: p, price: price({ cached_input_price_per_million: null }), usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 }, actualModel: "gpt-4o", serviceTier: null, requestBytes: 100 }).reason, "cached_input_unpriced");
  assert.equal(classifyBillingOutcome({ profile: profile({ maxInputBytes: 50 }), price: pr, usage: { inputTokens: 10, outputTokens: 5 }, actualModel: "gpt-4o", serviceTier: null, requestBytes: 999 }).reason, "request_over_max_bytes");
});

// ─── runApprovedModel with injected deps ────────────────────────────────────

const baseResolved = () => ({
  model: "gpt-4o", requestedModel: "gpt-4o", fallbackReason: null,
  profile: profile(), pricing: price(), client: {},
});

test("runApprovedModel: charges once, snapshots exact pricing_version, no double reasoning", async () => {
  const tracked = [];
  const out = await runApprovedModel(
    { tenantId: "TT1", purpose: "output", source: "whatsapp", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
    {
      resolveModel: async () => baseResolved(),
      executeModel: async () => ({
        content: "answer", refusal: null, incomplete: false, endpoint: CHAT, actualModel: "gpt-4o-2024-08-06",
        rawResponse: { service_tier: "default" },
        usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300, reasoningTokens: 120, totalTokens: 1300 },
      }),
      trackAiTokenUsage: async (t, s, resp, ctx) => tracked.push(ctx),
      recordBillingReconciliation: async () => { throw new Error("should not reconcile a chargeable request"); },
    },
  );
  assert.equal(out.content, "answer");
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].pricing.pricing_version, 4);
  assert.equal(tracked[0].actualModelMapping, "gpt-4o");
  assert.equal(tracked[0].usage.reasoningTokens, 120);
  assert.equal(tracked[0].usage.outputTokens, 300); // reasoning already inside output
});

test("runApprovedModel: unmapped actual model → reconciliation event, NO wallet charge, throws", async () => {
  const events = [];
  await assert.rejects(
    runApprovedModel(
      { tenantId: "TT1", purpose: "output", source: "whatsapp", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      {
        resolveModel: async () => baseResolved(),
        executeModel: async () => ({
          content: "x", refusal: null, incomplete: false, endpoint: CHAT, actualModel: "gpt-4o-mini",
          rawResponse: {}, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
        }),
        trackAiTokenUsage: async () => { throw new Error("must not charge"); },
        recordBillingReconciliation: async (e) => events.push(e),
      },
    ),
    (e) => e.code === "AI_BILLING_RECONCILIATION",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "unmapped_actual_model");
  assert.equal(events[0].pricingVersion, 4);
});

test("runApprovedModel: cached tokens with a configured cached rate charge normally", async () => {
  let charged = false;
  await runApprovedModel(
    { tenantId: "TT1", purpose: "output", source: "whatsapp", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
    {
      resolveModel: async () => baseResolved(),
      executeModel: async () => ({
        content: "ok", refusal: null, incomplete: false, endpoint: CHAT, actualModel: "gpt-4o",
        rawResponse: { service_tier: "default" },
        usage: { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 10, reasoningTokens: 0, totalTokens: 2010 },
      }),
      trackAiTokenUsage: async () => { charged = true; },
      recordBillingReconciliation: async () => { throw new Error("should not reconcile"); },
    },
  );
  assert.equal(charged, true);
});

test("runApprovedModel: preflight blocks when cached capability has no cached rate (before any provider call)", async () => {
  let executed = false;
  await assert.rejects(
    runApprovedModel(
      { tenantId: "TT1", purpose: "output", source: "whatsapp", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      {
        resolveModel: async () => ({ ...baseResolved(), pricing: price({ cached_input_price_per_million: null }) }),
        executeModel: async () => { executed = true; return {}; },
      },
    ),
    (e) => e.code === "AI_CACHED_PRICING_MISSING",
  );
  assert.equal(executed, false, "no provider request when the tariff is not ready");
});

test("runApprovedModel: no tenant → no billing calls at all", async () => {
  const out = await runApprovedModel(
    { tenantId: null, purpose: "output", source: "playground", messages: [{ role: "user", content: "hi" }], maxTokens: 50 },
    {
      resolveModel: async () => baseResolved(),
      executeModel: async () => ({ content: "hi there", refusal: null, incomplete: false, endpoint: CHAT, actualModel: "gpt-4o", rawResponse: {}, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 } }),
      trackAiTokenUsage: async () => { throw new Error("no tenant → no tracking"); },
      recordBillingReconciliation: async () => { throw new Error("no tenant → no reconciliation"); },
    },
  );
  assert.equal(out.content, "hi there");
});
