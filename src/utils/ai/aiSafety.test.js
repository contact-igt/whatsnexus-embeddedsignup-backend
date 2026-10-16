/**
 * Pure-logic tests for the H2 / M5 / L3 / L5 helpers.
 * Run: node --test src/utils/ai/aiSafety.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyTestFailure } from "./testFailureClassifier.js";
import { sanitizeErrorForAdmin, redactSecrets } from "./modelAccess.js";
import { classifyResponseOutcome, messagesHaveImageInput } from "./modelExecutor.js";
import { tenantSafeAvailability } from "./modelRuntime.js";
import { ModelConfigurationError } from "./modelProfile.js";

test("classifyTestFailure: transient", () => {
  for (const e of [
    Object.assign(new Error("x"), { status: 429 }),
    Object.assign(new Error("x"), { status: 500 }),
    Object.assign(new Error("x"), { status: 503 }),
    Object.assign(new Error("connection timeout"), {}),
    Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("x"), { name: "APIConnectionError" }),
    new Error("some mystery error"),
  ]) {
    assert.equal(classifyTestFailure(e).failureClass, "transient", e.message);
  }
});

test("classifyTestFailure: definitive", () => {
  for (const code of ["AI_MODEL_MAPPING", "AI_OUTPUT_INVALID", "AI_OUTPUT_INCOMPLETE", "AI_MODEL_MODALITY"]) {
    assert.equal(classifyTestFailure(new ModelConfigurationError("x", code)).failureClass, "definitive", code);
  }
  assert.equal(classifyTestFailure(Object.assign(new Error("bad request"), { status: 400 })).failureClass, "definitive");
});

test("classifyTestFailure: configuration", () => {
  for (const code of ["AI_MODEL_ACCESS", "AI_PRICING_MISSING", "AI_TARIFF_UNSUPPORTED"]) {
    assert.equal(classifyTestFailure(new ModelConfigurationError("x", code)).failureClass, "configuration", code);
  }
  assert.equal(classifyTestFailure(Object.assign(new Error("x"), { status: 401 })).failureClass, "configuration");
});

test("classifyTestFailure carries the failing check", () => {
  assert.equal(classifyTestFailure(new Error("x"), "vision").failingCheck, "vision");
});

test("redactSecrets / sanitizeErrorForAdmin never leak keys, prompts, or stacks", () => {
  assert.equal(redactSecrets("key sk-abcdef0123456789 here"), "key [redacted] here");
  const withKey = Object.assign(new Error("Incorrect API key provided: sk-proj-SECRETSECRETSECRET. Also Bearer abc.def"), { code: "AI_X" });
  const safe = sanitizeErrorForAdmin(withKey, "text");
  assert.doesNotMatch(safe, /sk-proj-SECRET/);
  assert.doesNotMatch(safe, /Bearer abc/);
  assert.match(safe, /^\[text\]/);
  assert.equal(sanitizeErrorForAdmin(Object.assign(new Error("x"), { status: 429 })), "Rate limited by OpenAI — retry later.");
  assert.match(sanitizeErrorForAdmin(new ModelConfigurationError("x", "AI_MODEL_MAPPING")), /approved mapping/);
});

test("classifyResponseOutcome", () => {
  const base = { refusal: null, incomplete: false, content: "ok", finishReason: "stop", incompleteReason: null };
  assert.equal(classifyResponseOutcome(base), "success");
  assert.equal(classifyResponseOutcome({ ...base, refusal: "no" }), "refusal");
  assert.equal(classifyResponseOutcome({ ...base, incomplete: true, incompleteReason: "length" }), "token_exhausted");
  assert.equal(classifyResponseOutcome({ ...base, incomplete: true, incompleteReason: "max_output_tokens" }), "token_exhausted");
  assert.equal(classifyResponseOutcome({ ...base, incomplete: true, incompleteReason: "content_filter" }), "content_filtered");
  assert.equal(classifyResponseOutcome({ ...base, incomplete: true, incompleteReason: "stop" }), "incomplete");
  assert.equal(classifyResponseOutcome({ ...base, content: "" }), "incomplete");
  assert.equal(classifyResponseOutcome({ ...base, content: "not json" }, { type: "json_object" }), "invalid_structured_output");
  assert.equal(classifyResponseOutcome({ ...base, content: '{"ok":true}' }, { type: "json_object" }), "success");
});

test("messagesHaveImageInput inspects structure, not text", () => {
  assert.equal(messagesHaveImageInput([{ role: "user", content: 'talk about "image_url"' }]), false);
  assert.equal(messagesHaveImageInput([{ role: "user", content: [{ type: "text", text: "x" }] }]), false);
  assert.equal(messagesHaveImageInput([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] }]), true);
  assert.equal(messagesHaveImageInput([{ role: "user", content: [{ type: "input_image", image_url: "data:..." }] }]), true);
});

test("tenantSafeAvailability leaks nothing internal", () => {
  const internal = new ModelConfigurationError("Model requires approval. Invalid pricing version. Credential resolution failed for tenant TT1.", "AI_MODEL_UNAVAILABLE");
  const safe = tenantSafeAvailability(internal);
  assert.equal(safe.code, "MODEL_UNAVAILABLE");
  assert.doesNotMatch(safe.message, /pricing version|approval|credential|TT1|blocker/i);
  assert.equal(tenantSafeAvailability(new ModelConfigurationError("x", "AI_MODEL_ACCESS")).code, "MODEL_NOT_AVAILABLE_FOR_ACCOUNT");
  assert.equal(tenantSafeAvailability(new ModelConfigurationError("x", "AI_MODEL_ACCESS_UNKNOWN")).availability, "unknown");
});
