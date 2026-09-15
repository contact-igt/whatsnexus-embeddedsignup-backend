import db from "../../database/index.js";
import { getOpenAIClient } from "./getOpenAIClient.js";
import { activationBlockers, ModelConfigurationError, validateModelId, validateRequestProfile } from "./modelProfile.js";
import { confirmModelAccess, listAccessibleModels } from "./modelAccess.js";
import { DEFAULT_MODELS } from "../../config/aiDefaults.js";

export { DEFAULT_MODELS };

const parseSettings = value => {
  if (!value) return {};
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value;
};

// Which ai_settings key holds the primary selection for a purpose.
const selectionKey = purpose => (purpose === "vision" ? "vision_model" : `${purpose}_model`);
const fallbackKey = purpose => `${purpose}_fallback_model`;

/**
 * Resolve a single candidate model to a fully-eligible execution context, or throw.
 * @param {string} model
 * @param {"input"|"output"|"vision"} purpose
 * @param {string|null} tenantId
 * @param {object} [opts]
 * @param {import("openai").OpenAI} [opts.client] - reuse an already-built client
 * @param {boolean} [opts.skipAccessCheck] - skip the live credential probe (config-time validation only)
 * @param {boolean} [opts.requireLiveTest] - reject a legacy_grandfathered model
 *   (used when a tenant is choosing/reassigning a model, not for existing runtime)
 */
export async function eligibleModel(model, purpose, tenantId, opts = {}) {
  const { client: suppliedClient, skipAccessCheck = false, requireLiveTest = false, accessibleSet } = opts;
  validateModelId(model);
  if (!["input", "output", "vision"].includes(purpose)) throw new ModelConfigurationError("Invalid model purpose.");
  const [catalog, pricing] = await Promise.all([
    db.AiModelCatalog.findOne({ where: { provider: "openai", model }, raw: true }),
    db.AiPricing.findOne({ where: { model, is_active: true }, raw: true }),
  ]);
  if (!catalog || !pricing) throw new ModelConfigurationError("Model needs an approved catalog profile and active exact pricing.", "AI_MODEL_UNAVAILABLE", 409);
  const blockers = activationBlockers(catalog, pricing, { forActivation: requireLiveTest });
  if (blockers.length) throw new ModelConfigurationError(blockers.join(" "), "AI_MODEL_UNAVAILABLE", 409);
  const profile = validateRequestProfile(catalog.request_profile);
  if (!profile.purposes.includes(purpose)) throw new ModelConfigurationError("Model is not approved for this purpose.", "AI_MODEL_PURPOSE", 409);
  if (purpose === "vision" && !profile.modalities.includes("image_input")) throw new ModelConfigurationError("Model does not support approved image input.", "AI_MODEL_MODALITY", 409);
  let client = suppliedClient || null;
  if (!skipAccessCheck) {
    try {
      client = client || await getOpenAIClient(tenantId);
    } catch {
      throw new ModelConfigurationError("No usable OpenAI credential is configured for this scope.", "AI_MODEL_ACCESS", 403);
    }
    if (accessibleSet instanceof Set) {
      // membership from a single models.list() — used by the listing endpoint
      if (!accessibleSet.has(model)) throw new ModelConfigurationError("Model access could not be confirmed for this credential.", "AI_MODEL_ACCESS", 403);
    } else if (accessibleSet === null) {
      // provider list was unavailable — availability is unknown, not confirmed
      throw new ModelConfigurationError("Model availability could not be confirmed.", "AI_MODEL_ACCESS_UNKNOWN", 503);
    } else {
      await confirmModelAccess(client, tenantId, model);
    }
  }
  return { model, catalog, pricing: Object.freeze({ ...pricing }), profile, client };
}

/**
 * Resolve the model a tenant should use for a purpose, honouring the explicit
 * fallback config. Never mutates the persisted selection.
 * Resolution order: saved selection → explicit eligible fallback → controlled error.
 */
export async function resolveModel(tenantId, purpose = "output") {
  if (!["input", "output", "vision"].includes(purpose)) throw new ModelConfigurationError("Invalid model purpose.");
  const tenant = tenantId
    ? await db.Tenants.findOne({ where: { tenant_id: tenantId, is_deleted: false }, attributes: ["ai_settings"], raw: true })
    : null;
  if (tenantId && !tenant) throw new ModelConfigurationError("Tenant not found.", "TENANT_NOT_FOUND", 404);
  const settings = parseSettings(tenant?.ai_settings);
  const selected = settings[selectionKey(purpose)]
    || (purpose === "vision" ? settings.output_model : null)
    || DEFAULT_MODELS[purpose];

  try {
    return { ...(await eligibleModel(selected, purpose, tenantId)), requestedModel: selected, fallbackReason: null };
  } catch (error) {
    if (!(error instanceof ModelConfigurationError)) throw error;
    const fallback = settings[fallbackKey(purpose)];
    if (!fallback || fallback === selected) throw error;
    const resolved = await eligibleModel(fallback, purpose, tenantId);
    return { ...resolved, requestedModel: selected, fallbackReason: error.code || "AI_MODEL_UNAVAILABLE" };
  }
}

/**
 * Tenant-visible model list for a purpose: the intersection of active pricing,
 * approved catalog, compatible purpose/modality, live lifecycle and (best-effort)
 * credential access. Also surfaces the tenant's saved selection when it is no
 * longer available so the UI can show it with an explanation.
 */
export async function availableModels(tenantId, purpose = "output") {
  if (!["input", "output", "vision"].includes(purpose)) throw new ModelConfigurationError("Invalid model purpose.");
  const [prices, tenant] = await Promise.all([
    db.AiPricing.findAll({ where: { is_active: true }, raw: true }),
    tenantId ? db.Tenants.findOne({ where: { tenant_id: tenantId, is_deleted: false }, attributes: ["ai_settings"], raw: true }) : null,
  ]);
  const settings = parseSettings(tenant?.ai_settings);
  const savedSelection = settings[selectionKey(purpose)] || (purpose === "vision" ? settings.output_model : null) || null;

  // ONE models.list() call for the whole listing (not one retrieve() per model).
  // `accessibleSet` is a Set of accessible ids, or null when the provider list
  // is temporarily unavailable (→ availability "unknown", never "accessible").
  let client = null;
  let accessibleSet;
  if (tenantId) {
    try { client = await getOpenAIClient(tenantId); } catch { client = null; }
    accessibleSet = client ? await listAccessibleModels(client, tenantId) : null;
  }

  const shape = (price, eligible, extra = {}) => ({
    id: price.id,
    model: price.model,
    description: price.description || null,
    recommended_for: price.recommended_for,
    category: price.category,
    purpose,
    modalities: eligible?.profile?.modalities || null,
    lifecycle_status: eligible?.catalog?.lifecycle_status || null,
    input_rate: Number(price.input_rate),
    output_rate: Number(price.output_rate),
    cached_input_price_per_million: price.cached_input_price_per_million == null ? null : Number(price.cached_input_price_per_million),
    usd_to_inr_rate: Number(price.usd_to_inr_rate),
    input_rate_inr: Number(price.input_rate) * Number(price.usd_to_inr_rate),
    output_rate_inr: Number(price.output_rate) * Number(price.usd_to_inr_rate),
    pricing_version: price.pricing_version,
    availability: "available",
    unavailability_reason: null,
    ...extra,
  });

  const models = [];
  let savedEntry = null;
  for (const price of prices) {
    try {
      const eligible = await eligibleModel(price.model, purpose, tenantId, { client, accessibleSet });
      const entry = shape(price, eligible, { is_saved_selection: price.model === savedSelection });
      models.push(entry);
      if (price.model === savedSelection) savedEntry = entry;
    } catch (error) {
      if (!(error instanceof ModelConfigurationError)) throw error;
      if (price.model === savedSelection) {
        const safe = tenantSafeAvailability(error);
        savedEntry = { ...shape(price, null, { is_saved_selection: true }), availability: safe.availability, unavailability_reason: safe.message, unavailability_code: safe.code };
      }
    }
  }

  // Saved selection that has no pricing row at all (e.g. retired) — still surface it.
  if (savedSelection && !savedEntry) {
    savedEntry = {
      id: null, model: savedSelection, description: null, recommended_for: null, category: null, purpose,
      modalities: null, lifecycle_status: null, input_rate: null, output_rate: null,
      cached_input_price_per_million: null, usd_to_inr_rate: null, input_rate_inr: null, output_rate_inr: null,
      pricing_version: null, availability: "unavailable", is_saved_selection: true,
      unavailability_code: "MODEL_UNAVAILABLE",
      unavailability_reason: "This model is no longer offered. Choose a replacement.",
    };
  }

  return { models, saved_selection: savedSelection, saved_selection_entry: savedEntry, purpose };
}

/**
 * Tenant-facing availability mapper — NEVER leaks internal blockers, pricing
 * versions, credential resolution order, DB state, or raw exception messages.
 * The detail stays in server logs / admin APIs.
 */
export function tenantSafeAvailability(error) {
  switch (error?.code) {
    case "AI_MODEL_ACCESS":
      return { availability: "unavailable", code: "MODEL_NOT_AVAILABLE_FOR_ACCOUNT", message: "This model isn't available for your account right now." };
    case "AI_MODEL_ACCESS_UNKNOWN":
      return { availability: "unknown", code: "MODEL_AVAILABILITY_UNKNOWN", message: "Model availability could not be confirmed. Try again shortly." };
    case "AI_TARIFF_UNSUPPORTED":
    case "AI_MODEL_CONFIGURATION":
      return { availability: "unavailable", code: "MODEL_CONFIGURATION_INCOMPLETE", message: "This model is temporarily unavailable." };
    case "AI_MODEL_PURPOSE":
    case "AI_MODEL_MODALITY":
      return { availability: "unavailable", code: "MODEL_NOT_SUPPORTED_HERE", message: "This model can't be used for this setting." };
    case "AI_MODEL_UNAVAILABLE":
      return { availability: "unavailable", code: "MODEL_UNAVAILABLE", message: "This model is currently unavailable." };
    default:
      return { availability: "unknown", code: "MODEL_AVAILABILITY_UNKNOWN", message: "Model availability could not be confirmed." };
  }
}
