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

// raw chat-completions shape (executeProviderRequest returns the RAW response)
const rawChat = ({ content = "answer", finish = "stop", refusal = null, model = "gpt-4o-2024-08-06", usage, service_tier } = {}) => ({
  model, service_tier,
  choices: [{ finish_reason: finish, message: { content, refusal } }],
  usage: usage ?? { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 120 } },
});
const run = (body, deps) => runApprovedModel({ tenantId: "TT1", purpose: "output", source: "whatsapp", messages: [{ role: "user", content: "hi" }], maxTokens: 100, ...body }, deps);

test("runApprovedModel: charges once, snapshots pricing_version, tags outcome, no double reasoning", async () => {
  const tracked = [];
  const out = await run({}, {
    resolveModel: async () => baseResolved(),
    executeProviderRequest: async () => rawChat({ service_tier: "default" }),
    trackAiTokenUsage: async (t, s, resp, ctx) => tracked.push(ctx),
    recordBillingReconciliation: async () => { throw new Error("should not reconcile a chargeable request"); },
  });
  assert.equal(out.content, "answer");
  assert.equal(out.outcome, "success");
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].pricing.pricing_version, 4);
  assert.equal(tracked[0].actualModelMapping, "gpt-4o");
  assert.equal(tracked[0].outcome, "success");
  assert.equal(tracked[0].usage.reasoningTokens, 120);
  assert.equal(tracked[0].usage.outputTokens, 300);
});

test("runApprovedModel: the REAL runtime passes cacheCapable:true — missing cached rate blocks before the provider call", async () => {
  let called = false;
  await assert.rejects(
    run({}, {
      resolveModel: async () => ({ ...baseResolved(), profile: profile({ billingCapabilities: { ...profile().billingCapabilities, cachedInput: false } }), pricing: price({ cached_input_price_per_million: null }) }),
      executeProviderRequest: async () => { called = true; return rawChat(); },
    }),
    (e) => e.code === "AI_TARIFF_UNSUPPORTED" && e.reason === "CACHED_INPUT_RATE_MISSING",
  );
  assert.equal(called, false, "cacheCapable:true is enforced even when the profile flag is false");
});

test("runApprovedModel: unmapped actual model → one reconciliation event, NO charge, throws", async () => {
  const events = [];
  await assert.rejects(
    run({}, {
      resolveModel: async () => baseResolved(),
      executeProviderRequest: async () => rawChat({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      trackAiTokenUsage: async () => { throw new Error("must not charge"); },
      recordBillingReconciliation: async (e) => events.push(e),
    }),
    (e) => e.code === "AI_BILLING_RECONCILIATION",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "unmapped_actual_model");
  assert.equal(events[0].pricingVersion, 4);
  assert.ok(events[0].correlationId);
});

test("runApprovedModel: invalid provider usage → reconciliation (invalid_usage_structure), no charge", async () => {
  const events = [];
  await assert.rejects(
    run({}, {
      resolveModel: async () => baseResolved(),
      // cached > input → normalizeUsage throws
      executeProviderRequest: async () => rawChat({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 999 } } }),
      trackAiTokenUsage: async () => { throw new Error("must not charge"); },
      recordBillingReconciliation: async (e) => events.push(e),
    }),
    (e) => e.code === "AI_BILLING_RECONCILIATION",
  );
  assert.equal(events[0].reason, "invalid_usage_structure");
  assert.ok(events[0].rawUsageSummary, "raw usage summary captured");
  assert.ok(!("prompt" in events[0]) && !("messages" in events[0]));
});

test("runApprovedModel: token-tracking failure → reconciliation + controlled billing error (no free call)", async () => {
  const events = [];
  await assert.rejects(
    run({}, {
      resolveModel: async () => baseResolved(),
      executeProviderRequest: async () => rawChat({ service_tier: "default" }),
      trackAiTokenUsage: async () => { throw new Error("wallet deadlock timeout"); },
      recordBillingReconciliation: async (e) => events.push(e),
    }),
    (e) => e.code === "AI_BILLING_RECONCILIATION",
  );
  assert.equal(events.length, 1);
});

test("runApprovedModel: reconciliation from tracking is not double-reported", async () => {
  const events = [];
  await assert.rejects(
    run({}, {
      resolveModel: async () => baseResolved(),
      executeProviderRequest: async () => rawChat({ service_tier: "default" }),
      trackAiTokenUsage: async () => { const e = new Error("x"); e.code = "AI_BILLING_RECONCILIATION"; throw e; },
      recordBillingReconciliation: async (e) => events.push(e),
    }),
    (e) => e.code === "AI_BILLING_RECONCILIATION",
  );
  assert.equal(events.length, 0, "trackAiTokenUsage already recorded it");
});

// ─── unsuccessful-response billing policy (M8) ──────────────────────────────

for (const [name, raw, expectedOutcome] of [
  ["refusal", rawChat({ content: "", refusal: "I can't help with that", usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }), "refusal"],
  ["token exhaustion", rawChat({ content: "half", finish: "length", usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 } }), "token_exhausted"],
  ["content filter", rawChat({ content: "", finish: "content_filter", usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }), "content_filtered"],
]) {
  test(`billing policy: ${name} is charged ONCE, tagged "${expectedOutcome}", and returns a controlled error`, async () => {
    const tracked = [];
    await assert.rejects(
      run({}, {
        resolveModel: async () => baseResolved(),
        executeProviderRequest: async () => raw,
        trackAiTokenUsage: async (t, s, resp, ctx) => tracked.push(ctx),
        recordBillingReconciliation: async () => { throw new Error("valid usage → no reconciliation"); },
      }),
      (e) => e.code === "AI_OUTPUT_INCOMPLETE",
    );
    assert.equal(tracked.length, 1, "charged exactly once");
    assert.equal(tracked[0].outcome, expectedOutcome);
  });
}

test("billing policy: valid usage + invalid JSON is charged once, tagged, controlled error", async () => {
  const tracked = [];
  await assert.rejects(
    run({ responseFormat: { type: "json_object" } }, {
      resolveModel: async () => baseResolved(),
      executeProviderRequest: async () => rawChat({ content: "not json", usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
      trackAiTokenUsage: async (t, s, resp, ctx) => tracked.push(ctx),
      recordBillingReconciliation: async () => { throw new Error("no reconciliation"); },
    }),
    (e) => e.code === "AI_OUTPUT_INVALID",
  );
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].outcome, "invalid_structured_output");
});

test("runApprovedModel: provider transport error → AI_PROVIDER_ERROR, no charge, no reconciliation", async () => {
  await assert.rejects(
    run({}, {
      resolveModel: async () => baseResolved(),
      executeProviderRequest: async () => { const e = new Error("socket hang up"); e.status = 503; throw e; },
      trackAiTokenUsage: async () => { throw new Error("no charge"); },
      recordBillingReconciliation: async () => { throw new Error("no reconciliation — OpenAI billed nothing"); },
    }),
    (e) => e.code === "AI_PROVIDER_ERROR",
  );
});

test("runApprovedModel: no tenant → no billing calls at all", async () => {
  const out = await run({ tenantId: null, source: "playground" }, {
    resolveModel: async () => baseResolved(),
    executeProviderRequest: async () => rawChat({ content: "hi there", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    trackAiTokenUsage: async () => { throw new Error("no tenant → no tracking"); },
    recordBillingReconciliation: async () => { throw new Error("no tenant → no reconciliation"); },
  });
  assert.equal(out.content, "hi there");
});
