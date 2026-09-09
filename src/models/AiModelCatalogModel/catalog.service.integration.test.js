/**
 * DB-backed catalog tests. Requires a reachable database (uses a throwaway
 * model id and cleans up after itself). Skips entirely if the DB is unreachable.
 * Run: node --test src/models/AiModelCatalogModel/catalog.service.integration.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import db from "../../database/index.js";
import { listCatalog, reviewCatalog, activateCatalog } from "./catalog.service.js";
import { validateRequestProfile } from "../../utils/ai/modelProfile.js";

const TEST_MODEL = "zz-catalog-itest-model";

let dbUp = false;
try {
  await db.sequelize.authenticate();
  await db.AiModelCatalog.sync();
  await db.AiPricing.destroy({ where: { model: TEST_MODEL } });
  await db.AiModelCatalog.destroy({ where: { model: TEST_MODEL } });
  dbUp = true;
} catch (e) {
  console.warn(`[catalog itest] DB unavailable, skipping: ${e.message}`);
}

const profile = {
  endpoint: "chat_completions", usageFormat: "chat_completions",
  modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: false, supportsJsonMode: false,
  supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [],
  tokenLimitParameter: "max_tokens", maxInputTokens: 100000, maxOutputTokens: 4000,
  actualModelIds: [TEST_MODEL], allowVersionedActuals: false,
};

test.after(async () => {
  if (dbUp) {
    await db.AiPricing.destroy({ where: { model: TEST_MODEL } }).catch(() => {});
    await db.AiModelCatalog.destroy({ where: { model: TEST_MODEL } }).catch(() => {});
    await db.sequelize.close().catch(() => {});
  }
});

test("grandfathered production models resolve to Active with no blockers", { skip: dbUp ? false : "DB unreachable" }, async () => {
  const { models } = await listCatalog();
  const active = models.filter((m) => m.active);
  assert.ok(active.length > 0, "expected at least one grandfathered active model");
  for (const m of active) {
    assert.deepEqual(m.blockers, [], `${m.model} should have no blockers`);
    assert.equal(m.state, "Active");
    assert.ok(validateRequestProfile(m.request_profile));
  }
});

test("a pending model cannot activate; needs approval + profile + pricing + test", { skip: dbUp ? false : "DB unreachable" }, async () => {
  const now = new Date();
  await db.AiModelCatalog.create({ provider: "openai", model: TEST_MODEL, review_status: "pending", lifecycle_status: "available", test_status: "not_tested", first_seen_at: now });

  await assert.rejects(activateCatalog(await idOf(TEST_MODEL), true, "itest"), /approval|profile|pricing|test/i);

  // approve + profile, still no pricing
  await reviewCatalog(await idOf(TEST_MODEL), { review_status: "approved", request_profile: profile, lifecycle_status: "available" }, "itest");
  await assert.rejects(activateCatalog(await idOf(TEST_MODEL), true, "itest"), /pricing/i);

  // add inactive pricing, still not tested
  await db.AiPricing.create({
    model: TEST_MODEL, input_rate: 1, output_rate: 2, markup_percent: 10,
    usd_to_inr_rate: 90, pricing_version: 1, category: "budget", recommended_for: "output", is_active: false,
  });
  await assert.rejects(activateCatalog(await idOf(TEST_MODEL), true, "itest"), /test/i);

  // review resets test status
  const row = await db.AiModelCatalog.findOne({ where: { model: TEST_MODEL }, raw: true });
  assert.equal(row.test_status, "not_tested");
});

test("review rejects unknown profile fields", { skip: dbUp ? false : "DB unreachable" }, async () => {
  await assert.rejects(
    reviewCatalog(await idOf(TEST_MODEL), { review_status: "approved", request_profile: { ...profile, bogusField: 1 } }, "itest"),
    /Unsupported request profile field/,
  );
});

async function idOf(model) {
  const row = await db.AiModelCatalog.findOne({ where: { model }, attributes: ["id"], raw: true });
  return row?.id;
}
