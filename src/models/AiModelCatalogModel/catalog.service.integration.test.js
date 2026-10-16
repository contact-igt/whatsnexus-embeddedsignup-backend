/**
 * DB-backed catalog tests. Requires a reachable database (uses a throwaway
 * model id and cleans up after itself). Skips entirely if the DB is unreachable.
 * Run: node --test src/models/AiModelCatalogModel/catalog.service.integration.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import db from "../../database/index.js";
import { listCatalog, reviewCatalog, activateCatalog, syncCatalog } from "./catalog.service.js";
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
  tokenLimitParameter: "max_tokens", maxInputBytes: 400000, maxOutputTokens: 4000,
  actualModelIds: [TEST_MODEL], allowVersionedActuals: false,
  billingCapabilities: { standardInput: true, cachedInput: false, standardOutput: true, longContext: false, cacheWrite: false, tools: false, serviceTier: false },
};

test.after(async () => {
  if (dbUp) {
    await db.AiPricing.destroy({ where: { model: TEST_MODEL } }).catch(() => {});
    await db.AiModelCatalog.destroy({ where: { model: TEST_MODEL } }).catch(() => {});
    await db.sequelize.close().catch(() => {});
  }
});

test("grandfathered models run at runtime but are not represented as live-tested", { skip: dbUp ? false : "DB unreachable" }, async () => {
  const { models } = await listCatalog();
  const active = models.filter((m) => m.active);
  assert.ok(active.length > 0, "expected at least one grandfathered active model");
  for (const m of active) {
    assert.ok(validateRequestProfile(m.request_profile));
    assert.equal(m.request_profile.maxInputBytes > 0, true, `${m.model} profile uses maxInputBytes`);
    assert.equal(m.request_profile.maxInputTokens, undefined, `${m.model} profile has no maxInputTokens`);
    if (m.is_legacy_grandfathered) {
      // runtime OK, but a fresh activation is blocked and the UI says so
      assert.deepEqual(m.runtimeBlockers, [], `${m.model} runtime blockers`);
      assert.ok(m.blockers.some((b) => /live compatibility test/i.test(b)), `${m.model} cannot be re-activated without a real test`);
      assert.match(m.state, /legacy/i);
      assert.notEqual(m.test_status, "passed");
    }
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

test("sync lock: when another connection holds the advisory lock, syncCatalog gets AI_SYNC_BUSY and writes nothing", { skip: dbUp ? false : "DB unreachable" }, async () => {
  const holder = await db.sequelize.connectionManager.getConnection();
  const q = (sql, v = []) => new Promise((res, rej) => holder.query(sql, v, (e, r) => e ? rej(e) : res(r)));
  await q("SELECT GET_LOCK('whatsnexus_ai_model_catalog_sync', 5)");
  try {
    const before = await db.AiModelSync.count();
    await assert.rejects(syncCatalog(), (e) => e.code === "AI_SYNC_BUSY");
    assert.equal(await db.AiModelSync.count(), before, "no sync record created when the lock was not acquired");
  } finally {
    await q("SELECT RELEASE_LOCK('whatsnexus_ai_model_catalog_sync')");
    await db.sequelize.connectionManager.releaseConnection(holder);
  }
});

async function idOf(model) {
  const row = await db.AiModelCatalog.findOne({ where: { model }, attributes: ["id"], raw: true });
  return row?.id;
}
