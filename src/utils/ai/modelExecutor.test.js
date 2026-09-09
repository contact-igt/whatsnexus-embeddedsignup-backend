/**
 * Request-builder + response-normalizer tests for both endpoints.
 * Run: node --test src/utils/ai/modelExecutor.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildModelRequest, normalizeModelResponse, executeModel, requestByteSize } from "./modelExecutor.js";

const CHAT = "chat_completions";
const chatProfile = (over = {}) => ({
  endpoint: CHAT, usageFormat: CHAT, modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: true, supportsJsonMode: true, supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [], tokenLimitParameter: "max_tokens",
  maxInputBytes: 2_000_000, maxOutputTokens: 8000, actualModelIds: ["gpt-4o"], ...over,
});
const respProfile = (over = {}) => chatProfile({
  endpoint: "responses", usageFormat: "responses", tokenLimitParameter: "max_output_tokens", ...over,
});
const oSeries = (over = {}) => chatProfile({
  supportsTemperature: false, supportsTopP: false, supportsReasoning: true,
  reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium",
  tokenLimitParameter: "max_completion_tokens", ...over,
});
const msgs = [{ role: "user", content: "hi" }];

// ─── payload snapshots for the five model types ──────────────────────────────

test("snapshot — legacy Chat Completions text model", () => {
  const p = buildModelRequest({ model: "gpt-4o", profile: chatProfile(), messages: msgs, maxTokens: 100, temperature: 0.2, topP: 0.9 });
  assert.deepEqual(p, { model: "gpt-4o", max_tokens: 100, temperature: 0.2, top_p: 0.9, messages: msgs });
  assert.ok(!("service_tier" in p), "service_tier not sent unless profile opts in");
});

test("snapshot — Chat Completions with serviceTier capability", () => {
  const p = buildModelRequest({ model: "gpt-4o", profile: chatProfile({ billingCapabilities: { serviceTier: true } }), messages: msgs, maxTokens: 100 });
  assert.equal(p.service_tier, "default");
});

test("snapshot — o-series / reasoning model (temperature/top_p dropped, reasoning_effort, completion token key)", () => {
  // callAI always passes a default temperature — it must be silently dropped, not error.
  const p = buildModelRequest({ model: "o3", profile: oSeries(), messages: msgs, maxTokens: 100, temperature: 0.01, topP: 0.9 });
  assert.deepEqual(p, { model: "o3", max_completion_tokens: 100, messages: msgs, reasoning_effort: "medium" });
  assert.ok(!("temperature" in p) && !("top_p" in p) && !("max_tokens" in p));
});

test("snapshot — Responses text model", () => {
  const p = buildModelRequest({ model: "gpt-4o", profile: respProfile(), messages: [{ role: "user", content: "hello" }], maxTokens: 200 });
  assert.equal(p.max_output_tokens, 200);
  assert.equal(p.store, false);
  assert.deepEqual(p.input, [{ role: "user", content: "hello" }]);
  assert.ok(!("messages" in p));
  assert.ok(!("max_tokens" in p));
});

test("snapshot — Responses structured output", () => {
  const p = buildModelRequest({
    model: "gpt-4o", profile: respProfile(), messages: msgs, maxTokens: 200,
    responseFormat: { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } },
  });
  assert.deepEqual(p.text, { format: { type: "json_schema", name: "x", strict: true, schema: { type: "object" } } });
});

test("snapshot — Responses vision / image-input model", () => {
  const p = buildModelRequest({
    model: "gpt-4o", profile: respProfile({ modalities: ["text", "image_input"], purposes: ["vision"] }),
    messages: [{ role: "user", content: [{ type: "text", text: "colour?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] }],
    maxTokens: 200,
  });
  assert.deepEqual(p.input[0].content, [
    { type: "input_text", text: "colour?" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
  ]);
});

// ─── guards ─────────────────────────────────────────────────────────────────

test("request rejects over-budget output, oversize input, and unapproved features", () => {
  assert.throws(() => buildModelRequest({ model: "gpt-4o", profile: chatProfile(), messages: msgs, maxTokens: 99999 }), /Output token budget/);
  assert.throws(() => buildModelRequest({ model: "gpt-4o", profile: chatProfile({ maxInputBytes: 10 }), messages: [{ role: "user", content: "this is definitely more than ten bytes" }], maxTokens: 10 }), /maxInputBytes/);
  assert.throws(() => buildModelRequest({ model: "gpt-4o", profile: chatProfile({ supportsJsonMode: false }), messages: msgs, maxTokens: 10, responseFormat: { type: "json_object" } }), /JSON mode is not approved/);
  assert.throws(() => buildModelRequest({ model: "gpt-4o", profile: chatProfile({ supportsStructuredOutput: false }), messages: msgs, maxTokens: 10, responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {} } } }), /Structured output is not approved/);
  assert.throws(() => buildModelRequest({ model: "gpt-4o", profile: chatProfile(), messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }], maxTokens: 10 }), /Image input is not approved/);
});

test("requestByteSize + unicode boundary", () => {
  assert.equal(requestByteSize([{ role: "user", content: "abc" }]), Buffer.byteLength(JSON.stringify([{ role: "user", content: "abc" }])));
  // a 4-byte emoji counts as its UTF-8 length, not 1
  const big = "😀".repeat(5);
  assert.ok(requestByteSize([{ role: "user", content: big }]) >= 20);
});

// ─── normalization ──────────────────────────────────────────────────────────

test("normalize chat: content, refusal, incomplete, token exhaustion", () => {
  const ok = normalizeModelResponse({ model: "gpt-4o-2024-08-06", choices: [{ finish_reason: "stop", message: { content: " hello " } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, "gpt-4o", CHAT);
  assert.equal(ok.content, "hello");
  assert.equal(ok.incomplete, false);
  assert.equal(ok.actualModel, "gpt-4o-2024-08-06");

  const refused = normalizeModelResponse({ model: "gpt-4o", choices: [{ finish_reason: "stop", message: { refusal: "I can't help with that", content: null } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }, "gpt-4o", CHAT);
  assert.equal(refused.refusal, "I can't help with that");
  assert.equal(refused.content, "");

  const cut = normalizeModelResponse({ model: "gpt-4o", choices: [{ finish_reason: "length", message: { content: "partial" } }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } }, "gpt-4o", CHAT);
  assert.equal(cut.incomplete, true);
  assert.equal(cut.incompleteReason, "length");
});

test("normalize responses: output_text join, refusal, incomplete", () => {
  const ok = normalizeModelResponse({
    model: "gpt-4o", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "AB" }, { type: "output_text", text: "C" }] }],
    usage: { input_tokens: 10, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } },
  }, "gpt-4o", "responses");
  assert.equal(ok.content, "ABC");
  assert.equal(ok.usage.reasoningTokens, 1);
  assert.equal(ok.usage.totalTokens, 13);

  const inc = normalizeModelResponse({
    model: "gpt-4o", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "half" }] }],
    usage: { input_tokens: 10, output_tokens: 50 },
  }, "gpt-4o", "responses");
  assert.equal(inc.incomplete, true);
  assert.equal(inc.incompleteReason, "max_output_tokens");

  const ref = normalizeModelResponse({
    model: "gpt-4o", status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    usage: { input_tokens: 10, output_tokens: 2 },
  }, "gpt-4o", "responses");
  assert.equal(ref.refusal, "no");
  assert.equal(ref.content, "");
});

test("executeModel routes to the right SDK method", async () => {
  const calls = [];
  const client = {
    chat: { completions: { create: async p => { calls.push(["chat", p]); return { model: "gpt-4o", choices: [{ finish_reason: "stop", message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; } } },
    responses: { create: async p => { calls.push(["responses", p]); return { model: "gpt-4o", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "y" }] }], usage: { input_tokens: 1, output_tokens: 1 } }; } },
  };
  const a = await executeModel(client, { model: "gpt-4o", profile: chatProfile(), messages: msgs, maxTokens: 10 });
  assert.equal(a.content, "x");
  assert.equal(calls[0][0], "chat");
  const b = await executeModel(client, { model: "gpt-4o", profile: respProfile(), messages: msgs, maxTokens: 10 });
  assert.equal(b.content, "y");
  assert.equal(calls[1][0], "responses");
});
