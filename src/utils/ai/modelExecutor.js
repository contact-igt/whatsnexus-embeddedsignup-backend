import { ModelConfigurationError, normalizeUsage, validateRequestProfile, validateModelId, billingCapabilities } from "./modelProfile.js";

// Serialized-request byte ceiling. This is a coarse safety cap, NOT a token
// count — bytes ≈ 3-4x tokens for English, so byte-bounding at the reviewed
// value is deliberately conservative. maxOutputTokens IS a real token count.
export function requestByteSize(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}

// True only when a message carries a real image content part.
export function messagesHaveImageInput(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => Array.isArray(m?.content) && m.content.some(part =>
    part && typeof part === "object" && (
      (part.type === "image_url" && part.image_url) ||
      (part.type === "input_image" && (part.image_url || part.file_id))
    ),
  ));
}

export function buildModelRequest({ model, profile, messages, maxTokens, temperature, topP, responseFormat }) {
  validateModelId(model);
  profile = validateRequestProfile(profile);
  const caps = billingCapabilities(profile);
  if (!Array.isArray(messages) || !messages.length) throw new ModelConfigurationError("Messages are required.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new ModelConfigurationError("Output token budget exceeds the approved profile.");
  if (requestByteSize(messages) > profile.maxInputBytes) throw new ModelConfigurationError("Request exceeds the approved maxInputBytes ceiling.", "AI_REQUEST_TOO_LARGE");
  // Detect image input by INSPECTING structured content parts — not by string
  // matching the serialized JSON (a user typing "image_url" must not trip this).
  if (messagesHaveImageInput(messages) && !profile.modalities.includes("image_input")) throw new ModelConfigurationError("Image input is not approved.");

  // Sampling params: sent ONLY when the reviewed profile allows them. A caller
  // default (e.g. callAI's temperature: 0.01) is dropped, not an error, for a
  // model that doesn't accept it.
  const params = { model, [profile.tokenLimitParameter]: maxTokens };
  if (profile.supportsTemperature && temperature !== undefined) params.temperature = temperature;
  if (profile.supportsTopP && topP !== undefined) params.top_p = topP;

  // Genuinely incompatible combinations — rejected before the provider call.
  if (responseFormat) {
    if (!["json_object", "json_schema"].includes(responseFormat.type)) throw new ModelConfigurationError("Unsupported response format.");
    if (responseFormat.type === "json_object" && !profile.supportsJsonMode) throw new ModelConfigurationError("JSON mode is not approved.");
    if (responseFormat.type === "json_schema" && !profile.supportsStructuredOutput) throw new ModelConfigurationError("Structured output is not approved.");
    if (responseFormat.type === "json_schema" && (!responseFormat.json_schema || typeof responseFormat.json_schema !== "object")) throw new ModelConfigurationError("json_schema payload is required for structured output.");
  }
  if (profile.endpoint === "chat_completions") {
    params.messages = messages;
    if (responseFormat) params.response_format = responseFormat;
    if (profile.supportsReasoning) params.reasoning_effort = profile.defaultReasoningEffort;
  } else {
    params.store = false;
    params.input = messages.map(message => {
      if (!["system", "developer", "user", "assistant"].includes(message.role)) throw new ModelConfigurationError("Unsupported message role.");
      if (typeof message.content === "string") return { role: message.role, content: message.content };
      return { role: message.role, content: message.content.map(part => {
        if (part.type === "text") return { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text };
        if (part.type === "image_url" && profile.modalities.includes("image_input") && message.role === "user") return { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail || "low" };
        throw new ModelConfigurationError("Unsupported message content.");
      }) };
    });
    if (profile.supportsReasoning) params.reasoning = { effort: profile.defaultReasoningEffort };
    if (responseFormat) params.text = { format: responseFormat.type === "json_schema" ? { type: "json_schema", ...responseFormat.json_schema } : responseFormat };
  }
  // Only pin the service tier when the reviewed profile opts in; otherwise let
  // the provider apply its own default. Never request batch / tools / audio /
  // cache-write tiers — those are not priced.
  if (caps.serviceTier) params.service_tier = "default";
  return params;
}

export function normalizeModelResponse(raw, model, endpoint) {
  const usage = normalizeUsage(raw, endpoint);
  const chat = endpoint === "chat_completions";
  const choice = raw.choices?.[0];
  const parts = (raw.output || []).flatMap(item => item.type === "message" ? item.content || [] : []);
  const refusal = chat ? choice?.message?.refusal || null : parts.find(part => part.type === "refusal")?.refusal || null;
  const content = (chat ? choice?.message?.content : parts.filter(part => part.type === "output_text").map(part => part.text).join(""))?.trim() || "";
  const incomplete = chat ? choice?.finish_reason !== "stop" : raw.status !== "completed";
  return { content, finishReason: chat ? choice?.finish_reason || "unknown" : incomplete ? raw.incomplete_details?.reason || raw.status : "stop", refusal, incomplete,
    incompleteReason: incomplete ? (chat ? choice?.finish_reason : raw.incomplete_details?.reason || raw.status) : null,
    requestedModel: model, actualModel: raw.model, endpoint, usage, rawResponse: raw };
}

/**
 * Build + send the provider request. Returns the RAW provider response so the
 * caller can normalise it under its own try/catch (a broken usage payload must
 * be reconciled, not lost). Throws only on a genuine provider/transport error
 * (nothing was billed by OpenAI in that case).
 */
export async function executeProviderRequest(client, options) {
  const params = buildModelRequest(options);
  return options.profile.endpoint === "responses"
    ? client.responses.create(params, { timeout: 45000, maxRetries: 0 })
    : client.chat.completions.create(params, { timeout: 45000, maxRetries: 0 });
}

/** Convenience: send + normalise in one step (used by the compatibility test). */
export async function executeModel(client, options) {
  const raw = await executeProviderRequest(client, options);
  return normalizeModelResponse(raw, options.model, options.profile.endpoint);
}

/**
 * Classify the application-level outcome of a normalised response so billing can
 * record it and the caller can raise the right controlled error.
 * @returns {"success"|"refusal"|"content_filtered"|"incomplete"|"token_exhausted"|"invalid_structured_output"}
 */
export function classifyResponseOutcome(normalized, responseFormat) {
  if (normalized.refusal) return "refusal";
  const reason = normalized.incompleteReason || normalized.finishReason;
  if (normalized.incomplete) {
    if (reason === "length" || reason === "max_output_tokens" || reason === "max_tokens") return "token_exhausted";
    if (reason === "content_filter") return "content_filtered";
    return "incomplete";
  }
  if (!normalized.content) return "incomplete";
  if (responseFormat) {
    try { JSON.parse(normalized.content); } catch { return "invalid_structured_output"; }
  }
  return "success";
}
