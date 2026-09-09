import { createHash } from "node:crypto";
import { ModelConfigurationError, validateModelId } from "./modelProfile.js";

const access = new Map();
const TTL = 60000;
export const credentialFingerprint = client => createHash("sha256").update(client.apiKey || "").digest("hex");
export function invalidateModelAccess(tenantId) {
  if (!tenantId) return access.clear();
  for (const key of access.keys()) if (key.startsWith(`${tenantId}:`)) access.delete(key);
}

export async function confirmModelAccess(client, tenantId, model, force = false) {
  validateModelId(model);
  const key = `${tenantId || "platform"}:${credentialFingerprint(client)}:${model}`;
  if (!force && (access.get(key) || 0) > Date.now()) return;
  try {
    const result = await client.models.retrieve(model, { timeout: 10000, maxRetries: 0 });
    if (result.id !== model) throw new Error("Invalid model access response");
    if (access.size >= 10000) access.clear();
    access.set(key, Date.now() + TTL);
  } catch {
    throw new ModelConfigurationError("Model access could not be confirmed for this credential.", "AI_MODEL_ACCESS", 403);
  }
}

export function sanitizedProviderError(error) {
  const status = Number(error?.status);
  const messages = { 401: "OpenAI authentication failed.", 403: "OpenAI access denied.", 429: "OpenAI rate limit reached." };
  return { code: messages[status] ? `OPENAI_${status}` : "OPENAI_REQUEST_FAILED", message: messages[status] || "OpenAI request failed or timed out. Previous catalog retained." };
}
