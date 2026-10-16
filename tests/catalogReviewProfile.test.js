import { jest } from "@jest/globals";

/**
 * Model Catalog "Save review": an empty request profile must be treated as
 * "no profile supplied" — never validated as a profile.
 *
 * Regression: the drawer used to seed the textarea with "{}" for models that have no
 * profile, so saving sent request_profile:{} and the API answered the misleading
 * "Unsupported endpoint." instead of "A reviewed request profile is required."
 */
const entry = { id: 6, model: "gpt-4.1", request_profile: null, update: jest.fn(async () => {}) };
const db = {
  sequelize: { transaction: async (cb) => cb({ LOCK: { UPDATE: "UPDATE" } }) },
  AiModelCatalog: { findByPk: jest.fn(async () => entry) },
  AdminAuditLog: { create: jest.fn(async () => ({})) },
};
jest.unstable_mockModule("../src/database/index.js", () => ({ default: db }));

const { reviewCatalog } = await import("../src/models/AiModelCatalogModel/catalog.service.js");

// Reviewed profile for gpt-4.1 (same shape the catalog migration grandfathers).
const validProfile = () => ({
  endpoint: "chat_completions",
  usageFormat: "chat_completions",
  modalities: ["text", "image_input"],
  purposes: ["input", "output", "vision"],
  supportsStructuredOutput: true,
  supportsJsonMode: true,
  supportsTemperature: true,
  supportsTopP: true,
  supportsReasoning: false,
  reasoningEfforts: [],
  tokenLimitParameter: "max_tokens",
  maxInputBytes: 4000000,
  maxOutputTokens: 8000,
  allowVersionedActuals: true,
  billingCapabilities: {
    standardInput: true, cachedInput: false, standardOutput: true,
    longContext: false, cacheWrite: false, tools: false, serviceTier: false,
  },
  actualModelIds: ["gpt-4.1", "gpt-4.1-2025-04-14"],
});

beforeEach(() => {
  entry.request_profile = null;
  entry.update.mockClear();
  db.AdminAuditLog.create.mockClear();
});

describe("reviewCatalog — empty / missing request profile", () => {
  test("approving with an empty {} profile says a profile is REQUIRED (not 'Unsupported endpoint.')", async () => {
    const err = await reviewCatalog(6, { review_status: "approved", lifecycle_status: "available", request_profile: {} }, "admin").catch((e) => e);
    expect(err.message).toMatch(/reviewed request profile is required/i);
    expect(err.message).not.toMatch(/Unsupported endpoint/i);
    expect(entry.update).not.toHaveBeenCalled(); // nothing is written
  });

  test("approving with no profile key at all gives the same clear message", async () => {
    await expect(reviewCatalog(6, { review_status: "approved" }, "admin")).rejects.toThrow(/reviewed request profile is required/i);
    expect(entry.update).not.toHaveBeenCalled();
  });

  test("saving only review/lifecycle status (no profile, not approving) still works and ignores an empty {}", async () => {
    await reviewCatalog(6, { review_status: "pending", lifecycle_status: "available", request_profile: {} }, "admin");
    expect(entry.update).toHaveBeenCalledTimes(1);
    const patch = entry.update.mock.calls[0][0];
    expect("request_profile" in patch).toBe(false); // the empty object is never stored
    expect(patch).toMatchObject({ review_status: "pending", lifecycle_status: "available", reviewed_by: "admin" });
  });
});

describe("reviewCatalog — real profiles are still validated", () => {
  test("a genuinely invalid endpoint is still rejected with the specific message", async () => {
    await expect(
      reviewCatalog(6, { review_status: "approved", request_profile: { ...validProfile(), endpoint: "assistants" } }, "admin"),
    ).rejects.toThrow(/Unsupported endpoint/);
    expect(entry.update).not.toHaveBeenCalled();
  });

  test("a valid reviewed profile is accepted and stored, and resets the compatibility test", async () => {
    await reviewCatalog(6, { review_status: "approved", lifecycle_status: "available", request_profile: validProfile() }, "admin");
    expect(entry.update).toHaveBeenCalledTimes(1);
    const patch = entry.update.mock.calls[0][0];
    expect(patch).toMatchObject({ review_status: "approved", test_status: "not_tested", test_result: null });
    expect(patch.request_profile.endpoint).toBe("chat_completions");
    expect(db.AdminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test("approving an already-profiled model without resending the profile still passes", async () => {
    entry.request_profile = validProfile();
    await reviewCatalog(6, { review_status: "approved", lifecycle_status: "available" }, "admin");
    expect(entry.update).toHaveBeenCalledTimes(1);
  });

  test("unknown fields are still refused", async () => {
    await expect(reviewCatalog(6, { review_status: "approved", is_active: true }, "admin")).rejects.toThrow(/Unsupported catalog update field/);
  });
});
