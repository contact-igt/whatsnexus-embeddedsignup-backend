import { createHash } from "node:crypto";
import { ModelConfigurationError, validateModelId } from "./modelProfile.js";

const access = new Map();
const TTL = 60000;
// Membership sets from one models.list() call, keyed by scope + credential
// fingerprint. Used for the tenant-facing "available models" listing so it does
// NOT make one models.retrieve() call per model.
const listCache = new Map();
const LIST_TTL = 120000;

export const credentialFingerprint = client => createHash("sha256").update(client.apiKey || "").digest("hex");
export function invalidateModelAccess(tenantId) {
  if (!tenantId) { access.clear(); listCache.clear(); return; }
  for (const key of access.keys()) if (key.startsWith(`${tenantId}:`)) access.delete(key);
  for (const key of listCache.keys()) if (key.startsWith(`${tenantId}:`)) listCache.delete(key);
}

/**
 * Exact model ids this credential can access, from a SINGLE models.list() call.
 * Cached per (scope, fingerprint) for LIST_TTL. Returns null when the provider
 * list is unavailable (caller should then treat availability as "unknown", not
 * "accessible"). Never caches or returns the raw credential.
 */
export async function listAccessibleModels(client, tenantId) {
  const key = `${tenantId || "platform"}:${credentialFingerprint(client)}`;
  const hit = listCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.set;
  try {
    const ids = new Set();
    let page = await client.models.list({ timeout: 15000, maxRetries: 0 });
    let pages = 0;
    while (page) {
      if (++pages > 50 || !Array.isArray(page.data)) break;
      for (const m of page.data) if (typeof m?.id === "string") ids.add(m.id);
      if (typeof page.hasNextPage === "function" && page.hasNextPage()) page = await page.getNextPage();
      else break;
    }
    if (listCache.size >= 500) listCache.clear();
    listCache.set(key, { set: ids, expires: Date.now() + LIST_TTL });
    return ids;
  } catch {
    return null;
  }
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

// Redact anything that could carry a secret or prompt content, then cap length.
const SECRET_RX = /\b(sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+|org-[A-Za-z0-9]{6,})\b/gi;
export function redactSecrets(text) {
  return String(text ?? "").replace(SECRET_RX, "[redacted]");
}

/**
 * An actionable-but-safe one-liner for the admin UI / test-attempt history.
 * Never includes API keys, auth headers, request bodies, prompt content, or a
 * raw provider response — only a status/code and a short reason.
 */
export function sanitizeErrorForAdmin(error, failingCheck = null) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = error?.code || null;
  const prefix = failingCheck ? `[${failingCheck}] ` : "";

  if (status === 429) return `${prefix}Rate limited by OpenAI — retry later.`;
  if (status === 401) return `${prefix}OpenAI authentication failed for this credential.`;
  if (status === 403 || code === "AI_MODEL_ACCESS") return `${prefix}This credential cannot access the model.`;
  if (status >= 500) return `${prefix}OpenAI returned a server error (${status}) — retry later.`;
  if (code === "AI_MODEL_MAPPING") return `${prefix}Returned model did not match the approved mapping.`;
  if (code === "AI_OUTPUT_INVALID") return `${prefix}Structured-output check returned invalid JSON.`;
  if (code === "AI_OUTPUT_INCOMPLETE") return `${prefix}Test response was refused, incomplete, or empty.`;
  if (code === "AI_MODEL_MODALITY") return `${prefix}Image-input test is unsupported by this model.`;
  if (code === "AI_TARIFF_UNSUPPORTED") return `${prefix}Pricing/tariff configuration is incomplete for this model.`;
  if (code && code.startsWith("AI_")) return `${prefix}${redactSecrets(error.message).slice(0, 180)}`;
  if (/timeout|timed out|network|ECONN|ETIMEDOUT/i.test(String(error?.message))) return `${prefix}Network/timeout talking to OpenAI — retry later.`;
  return `${prefix}Compatibility test failed${status ? ` (${status})` : ""}.`;
}
