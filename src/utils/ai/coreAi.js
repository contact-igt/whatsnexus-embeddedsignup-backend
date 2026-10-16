import { runApprovedModel } from "./runApprovedModel.js";

/**
 * Token limits by source — prevents runaway token usage.
 */
const TOKEN_LIMITS = {
  language_detect: 80,
  classifier: 500,
  knowledge_search: 50,
  lead_summary: 300,
  smart_reply: 500,
  utility: 150,
  frontend_utility: 500,
  knowledge_process: 3000,
  playground: 1200,
  whatsapp: 1200,
  whatsapp_retry: 1600,
  whatsapp_vision: 1500,
  appointment_agent: 1200,
};

/**
 * Sources that should use the lighter/cheaper input model.
 */
const INPUT_MODEL_SOURCES = [
  "language_detect",
  "classifier",
  "knowledge_search",
  "knowledge_process",
];

/**
 * Centralized AI service — single entry point for ALL OpenAI calls in the project.
 *
 * @param {object} options
 * @param {Array<{role: string, content: string}>} options.messages - OpenAI messages array
 * @param {string} [options.tenant_id] - Tenant ID for model/key resolution and billing
 * @param {string} [options.source="utility"] - Call origin for billing and token limits
 * @param {number} [options.temperature=0.01] - Sampling temperature
 * @param {number} [options.maxTokens] - Override max_tokens (auto-resolved from source if omitted)
 * @param {object} [options.responseFormat] - e.g. { type: "json_object" }
 * @param {number} [options.topP] - top_p sampling parameter
 * @returns {Promise<{content: string, usage: object, raw: object}>}
 */
export const callAI = async ({
  messages,
  tenant_id = null,
  source = "utility",
  temperature = 0.01,
  maxTokens,
  responseFormat,
  topP,
}) => {
  const modelType = INPUT_MODEL_SOURCES.includes(source) ? "input" : "output";
  return runApprovedModel({ tenantId: tenant_id, purpose: modelType, source, messages, temperature, topP, responseFormat, maxTokens: maxTokens || TOKEN_LIMITS[source] || 150 });
};

/**
 * Legacy wrapper — keeps backward compatibility with existing callers.
 * Prefer callAI() for new code.
 */
export const AiService = async (
  system,
  prompt,
  tenant_id = null,
  source = "utility",
) => {
  try {
    const result = await callAI({
      messages: [{ role: system, content: prompt }],
      tenant_id,
      source,
    });
    return result.content;
  } catch (err) {
    console.error("OpenAI error:", err.message);
    throw new Error(`AI generation failed: ${err.message}`);
  }
};
