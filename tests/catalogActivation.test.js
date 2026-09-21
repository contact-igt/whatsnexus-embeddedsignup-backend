import { jest } from "@jest/globals";
import { credentialFingerprint } from "../src/utils/ai/modelAccess.js";

/**
 * Activating a model must work when its pricing rule is still INACTIVE (the normal state before
 * activation). Regression: activateCatalog judged readiness against the inactive rule and refused
 * with "Pricing rule is not active." for a model that the list showed as "Ready to activate".
 */
const MODEL = "gpt-4o-mini";
const API_KEY = "test-platform-key";
const fingerprint = credentialFingerprint({ apiKey: API_KEY });

const profile = {
  endpoint: "chat_completions", usageFormat: "chat_completions",
  modalities: ["text", "image_input"], purposes: ["input", "output", "vision"],
  supportsStructuredOutput: true, supportsJsonMode: true, supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [], tokenLimitParameter: "max_tokens",
  maxInputBytes: 2000000, maxOutputTokens: 8000, allowVersionedActuals: true,
  billingCapabilities: { standardInput: true, cachedInput: false, standardOutput: true, longContext: false, cacheWrite: false, tools: false, serviceTier: false },
  actualModelIds: [MODEL, "gpt-4o-mini-2024-07-18"],
};

const priceFields = (over = {}) => ({
  id: 1, model: MODEL, input_rate: 0.15, output_rate: 0.6, cached_input_price_per_million: 0.075,
  markup_percent: 10, usd_to_inr_rate: 90, pricing_version: 2, category: "budget", recommended_for: "both",
  is_active: false, ...over,
});
// behaves like a Sequelize instance: fields as properties + toJSON() + update()
const priceInstance = (over) => {
  const fields = priceFields(over);
  return { ...fields, toJSON: () => ({ ...fields }), update: jest.fn(async function (patch) { Object.assign(this, patch); Object.assign(fields, patch); }) };
};
const catalogEntry = (over = {}) => ({
  id: 9, provider: "openai", model: MODEL, review_status: "approved", lifecycle_status: "available",
  request_profile: profile, test_status: "passed",
  test_result: { credentialScope: "platform", credentialFingerprint: fingerprint, success: true },
  update: jest.fn(async () => {}), ...over,
});

let entry;
let price;
const db = {
  sequelize: { transaction: async (cb) => cb({ LOCK: { UPDATE: "UPDATE" } }) },
  AiModelCatalog: { findByPk: jest.fn(async () => entry), findAll: jest.fn(async () => [entry]) },
  AiPricing: { findOne: jest.fn(async () => price), findAll: jest.fn(async () => (price ? [{ ...price.toJSON?.() }] : [])) },
  AiModelSync: { findOne: jest.fn(async () => null) },
  AdminAuditLog: { create: jest.fn(async () => ({})) },
};
jest.unstable_mockModule("../src/database/index.js", () => ({ default: db }));
jest.unstable_mockModule("../src/utils/ai/getOpenAIClient.js", () => ({
  getOpenAIClient: async () => ({ apiKey: API_KEY, models: { retrieve: async () => ({ id: MODEL }) } }),
  invalidateOpenAIClient: () => {},
}));

const { activateCatalog, listCatalog } = await import("../src/models/AiModelCatalogModel/catalog.service.js");
const { activationBlockers } = await import("../src/utils/ai/modelProfile.js");

beforeEach(() => {
  entry = catalogEntry();
  price = priceInstance();
  db.AdminAuditLog.create.mockClear();
});

describe("activateCatalog with an INACTIVE pricing rule (the normal pre-activation state)", () => {
  test("activates: the pricing rule is switched on and the audit row is written", async () => {
    await expect(activateCatalog(9, true, "admin")).resolves.toBeUndefined();
    expect(price.update).toHaveBeenCalledWith({ is_active: true }, expect.anything());
    expect(entry.update).toHaveBeenCalledWith(expect.objectContaining({ activated_by: "admin" }), expect.anything());
    expect(db.AdminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test("still refuses when a REAL blocker exists: no cached-input rate", async () => {
    price = priceInstance({ cached_input_price_per_million: null });
    await expect(activateCatalog(9, true, "admin")).rejects.toThrow(/cached-input rate/i);
    expect(price.update).not.toHaveBeenCalled();
  });

  test("still refuses when the test has not passed", async () => {
    entry = catalogEntry({ test_status: "not_tested" });
    await expect(activateCatalog(9, true, "admin")).rejects.toThrow(/live compatibility test/i);
  });

  test("still refuses when the model is not approved", async () => {
    entry = catalogEntry({ review_status: "pending" });
    await expect(activateCatalog(9, true, "admin")).rejects.toThrow(/requires approval/i);
  });

  test("still refuses when there is no pricing row at all", async () => {
    price = null;
    await expect(activateCatalog(9, true, "admin")).rejects.toThrow(/pricing/i);
  });

  test("never says 'Pricing rule is not active.' for an inactive rule", async () => {
    const err = await activateCatalog(9, true, "admin").catch((e) => e);
    expect(err?.message ?? "").not.toMatch(/Pricing rule is not active/i);
  });

  test("deactivation is unaffected", async () => {
    price = priceInstance({ is_active: true });
    await activateCatalog(9, false, "admin");
    expect(price.update).toHaveBeenCalledWith({ is_active: false }, expect.anything());
  });
});

describe("the list and the activation agree", () => {
  test("a ready model with an inactive rule shows 'Ready to activate' with no blockers — as raw 0/1 rows AND as booleans", async () => {
    for (const is_active of [0, false]) {
      price = priceInstance({ is_active });
      db.AiPricing.findAll.mockImplementationOnce(async () => [{ ...priceFields({ is_active }) }]);
      const { models } = await listCatalog();
      expect(models[0].blockers).toEqual([]);
      expect(models[0].state).toBe("Ready to activate");
    }
  });

  test("the list reports the same real blocker the activation refuses on", async () => {
    price = priceInstance({ cached_input_price_per_million: null });
    db.AiPricing.findAll.mockImplementationOnce(async () => [{ ...priceFields({ cached_input_price_per_million: null }) }]);
    const { models } = await listCatalog();
    expect(models[0].blockers.join(" ")).toMatch(/cached-input rate/i);
    await expect(activateCatalog(9, true, "admin")).rejects.toThrow(/cached-input rate/i);
  });
});

describe("the RUNTIME guard is unchanged", () => {
  test("activationBlockers still reports an inactive pricing rule when evaluated as-is (runtime path)", () => {
    const blockers = activationBlockers(catalogEntry(), priceFields({ is_active: false }), { forActivation: false });
    expect(blockers.join(" ")).toMatch(/Pricing rule is not active/i);
  });
});
