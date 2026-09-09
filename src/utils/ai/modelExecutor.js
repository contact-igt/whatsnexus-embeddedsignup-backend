import { ModelConfigurationError, normalizeUsage, validateRequestProfile, validateModelId, billingCapabilities } from "./modelProfile.js";

// Serialized-request byte ceiling. This is a coarse safety cap, NOT a token
// count — bytes ≈ 3-4x tokens for English, so byte-bounding at the reviewed
// value is deliberately conservative. maxOutputTokens IS a real token count.
export function requestByteSize(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}

export function buildModelRequest({ model, profile, messages, maxTokens, temperature, topP, responseFormat }) {
  validateModelId(model);
  profile = validateRequestProfile(profile);
  const caps = billingCapabilities(profile);
  if (!Array.isArray(messages) || !messages.length) throw new ModelConfigurationError("Messages are required.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new ModelConfigurationError("Output token budget exceeds the approved profile.");
  const serialized = JSON.stringify(messages);
  if (requestByteSize(messages) > profile.maxInputBytes) throw new ModelConfigurationError("Request exceeds the approved maxInputBytes ceiling.", "AI_REQUEST_TOO_LARGE");
  if (serialized.includes('"image_url"') && !profile.modalities.includes("image_input")) throw new ModelConfigurationError("Image input is not approved.");

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

export async function executeModel(client, options) {
  const params = buildModelRequest(options);
  const raw = options.profile.endpoint === "responses"
    ? await client.responses.create(params, { timeout: 45000, maxRetries: 0 })
    : await client.chat.completions.create(params, { timeout: 45000, maxRetries: 0 });
  return normalizeModelResponse(raw, options.model, options.profile.endpoint);
}
