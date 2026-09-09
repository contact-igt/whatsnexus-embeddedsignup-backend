/**
 * Cached-input pricing config + backfill script.
 * Config assertions run always; the write-path assertions need a reachable DB
 * (throwaway model ids, cleaned up after) and skip otherwise.
 * Run: node --test src/scripts/backfillAiCachedInputPricing.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import db from "../database/index.js";
import { CACHED_INPUT_PRICING, reviewedCachedRate } from "../config/aiCachedInputPricing.js";
import { backfillCachedInputPricing } from "./backfillAiCachedInputPricing.js";

// ── config (no DB) ─────────────────────────────────────────────────────────

test("gpt-5.4 family cached rates are present and verified", () => {
  assert.equal(CACHED_INPUT_PRICING["gpt-5.4"].cached_input_per_million, 0.25);
  assert.equal(CACHED_INPUT_PRICING["gpt-5.4-mini"].cached_input_per_million, 0.075);
  assert.equal(CACHED_INPUT_PRICING["gpt-5.4-nano"].cached_input_per_million, 0.02);
  for (const m of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]) {
    assert.equal(CACHED_INPUT_PRICING[m].verified, true, `${m} verified`);
  }
});

test("gpt-5.4 family standard reference rates match the task's reviewed table", () => {
  assert.deepEqual(
    ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].map(m => reviewedCachedRate(m)),
    [
      { rate: 0.25,  verified: true, known: true, referenceInput: 2.5,  referenceOutput: 15 },
      { rate: 0.075, verified: true, known: true, referenceInput: 0.75, referenceOutput: 4.5 },
      { rate: 0.02,  verified: true, known: true, referenceInput: 0.2,  referenceOutput: 1.25 },
    ],
  );
});

test("every configured entry has a verified cached rate (no placeholders left)", () => {
  for (const [m, row] of Object.entries(CACHED_INPUT_PRICING)) {
    assert.equal(row.verified, true, `${m} still unverified`);
    assert.equal(typeof row.cached_input_per_million, "number", `${m} has no numeric cached rate`);
    assert.ok(row.cached_input_per_million >= 0);
  }
});

// ── backfill write path (DB) ───────────────────────────────────────────────

const M1 = "zz-backfill-itest-a";
const M2 = "zz-backfill-itest-b";
let dbUp = false;

try {
  await db.sequelize.authenticate();
  await Promise.all([
    db.AiPricing.destroy({ where: { model: [M1, M2] } }),
    db.AiModelCatalog.destroy({ where: { model: [M1, M2] } }),
    db.AdminAuditLog.destroy({ where: { admin_id: "backfill-script", details: { model: [M1, M2] } } }).catch(() => {}),
  ]);
  dbUp = true;
} catch (e) {
  console.warn(`[backfill itest] DB unavailable, write-path tests skip: ${e.message}`);
}

const skip = dbUp ? false : "DB unreachable";

// The script only touches models present in the reviewed config. We temporarily
// register the throwaway ids so the write path can be exercised without relying
// on real model rows.
const stubProfile = {
  endpoint: "chat_completions", usageFormat: "chat_completions", modalities: ["text"], purposes: ["output"],
  supportsStructuredOutput: false, supportsJsonMode: false, supportsTemperature: true, supportsTopP: true,
  supportsReasoning: false, reasoningEfforts: [], tokenLimitParameter: "max_tokens",
  maxInputBytes: 400000, maxOutputTokens: 4000, actualModelIds: [M1], allowVersionedActuals: false,
  billingCapabilities: { standardInput: true, cachedInput: false, standardOutput: true, longContext: false, cacheWrite: false, tools: false, serviceTier: false },
};

async function seed({ m1Cached = null, m2Cached = null } = {}) {
  await db.AiPricing.destroy({ where: { model: [M1, M2] } });
  await db.AiModelCatalog.destroy({ where: { model: [M1, M2] } });
  await db.AiPricing.bulkCreate([
    { model: M1, input_rate: 2, output_rate: 8, cached_input_price_per_million: m1Cached, markup_percent: 10, usd_to_inr_rate: 90, pricing_version: 1, category: "budget", recommended_for: "output", is_active: true },
    { model: M2, input_rate: 1, output_rate: 4, cached_input_price_per_million: m2Cached, markup_percent: 10, usd_to_inr_rate: 90, pricing_version: 3, category: "budget", recommended_for: "output", is_active: true },
  ]);
  await db.AiModelCatalog.create({ provider: "openai", model: M1, review_status: "approved", lifecycle_status: "available", test_status: "legacy_grandfathered", request_profile: { ...stubProfile } });
}

test.after(async () => {
  if (dbUp) {
    await db.AiPricing.destroy({ where: { model: [M1, M2] } }).catch(() => {});
    await db.AiModelCatalog.destroy({ where: { model: [M1, M2] } }).catch(() => {});
    await db.sequelize.close().catch(() => {});
  }
});

// Patch the config in-memory for the throwaway ids for the duration of these tests.
CACHED_INPUT_PRICING[M1] = { standard_input_per_million: 2, standard_output_per_million: 8, cached_input_per_million: 0.5, verified: true };
CACHED_INPUT_PRICING[M2] = { standard_input_per_million: 1, standard_output_per_million: 4, cached_input_per_million: 0.25, verified: true };

// One parent so the DB subtests run STRICTLY sequentially (they share M1/M2).
test("backfill write path (DB)", { skip }, async (t) => {
  await t.test("dry-run makes NO database changes", async () => {
    await seed();
    const before = await db.AiPricing.findAll({ where: { model: [M1, M2] }, raw: true, order: [["model", "ASC"]] });
    const res = await backfillCachedInputPricing({ db, apply: false, models: [M1, M2] });
    assert.equal(res.ready.length, 2);
    const after = await db.AiPricing.findAll({ where: { model: [M1, M2] }, raw: true, order: [["model", "ASC"]] });
    assert.deepEqual(after.map(r => [r.cached_input_price_per_million, r.pricing_version]), before.map(r => [r.cached_input_price_per_million, r.pricing_version]));
  });

  await t.test("apply sets null rates, bumps pricing_version, flips catalog cachedInput, writes audit", async () => {
    await seed();
    await backfillCachedInputPricing({ db, apply: true, models: [M1, M2] });
    const [a, b] = [
      await db.AiPricing.findOne({ where: { model: M1 }, raw: true }),
      await db.AiPricing.findOne({ where: { model: M2 }, raw: true }),
    ];
    assert.equal(Number(a.cached_input_price_per_million), 0.5);
    assert.equal(a.pricing_version, 2);
    assert.equal(Number(b.cached_input_price_per_million), 0.25);
    assert.equal(b.pricing_version, 4); // was 3
    const cat = await db.AiModelCatalog.findOne({ where: { model: M1 }, raw: true });
    const prof = typeof cat.request_profile === "string" ? JSON.parse(cat.request_profile) : cat.request_profile;
    assert.equal(prof.billingCapabilities.cachedInput, true);
    const audits = await db.AdminAuditLog.findAll({ where: { admin_id: "backfill-script", action_type: "pricing_update" }, raw: true });
    const parsed = audits.map(x => typeof x.details === "string" ? JSON.parse(x.details) : x.details);
    assert.ok(parsed.some(d => d?.model === M1 && d?.action === "cached_input_backfill"), "an audit row was written for M1");
  });

  await t.test("equal existing value is skipped (no version bump)", async () => {
    await seed({ m1Cached: 0.5 });
    const res = await backfillCachedInputPricing({ db, apply: true, models: [M1, M2] });
    assert.ok(res.skipped.some(s => s.model === M1));
    const a = await db.AiPricing.findOne({ where: { model: M1 }, raw: true });
    assert.equal(a.pricing_version, 1, "unchanged");
  });

  await t.test("conflicting existing value is reported and NOT overwritten", async () => {
    await seed({ m1Cached: 0.9 });
    const res = await backfillCachedInputPricing({ db, apply: true, models: [M1, M2] });
    assert.ok(res.conflicts.some(c => c.model === M1 && c.type === "cached_rate_mismatch"));
    assert.ok(!res.changed.some(c => c.model === M1));
    const a = await db.AiPricing.findOne({ where: { model: M1 }, raw: true });
    assert.equal(Number(a.cached_input_price_per_million), 0.9, "not overwritten without --resolve-conflicts");
  });

  await t.test("--resolve-conflicts overwrites a differing value and bumps version", async () => {
    await seed({ m1Cached: 0.9 });
    const res = await backfillCachedInputPricing({ db, apply: true, resolveConflicts: true, models: [M1, M2] });
    assert.ok(res.changed.some(c => c.model === M1));
    const a = await db.AiPricing.findOne({ where: { model: M1 }, raw: true });
    assert.equal(Number(a.cached_input_price_per_million), 0.5);
    assert.equal(a.pricing_version, 2);
  });

  await t.test("exact model-id match only — a prefix-similar model is untouched", async () => {
    await seed();
    const preview = `${M1}-preview`;
    await db.AiPricing.create({ model: preview, input_rate: 2, output_rate: 8, markup_percent: 10, usd_to_inr_rate: 90, pricing_version: 1, category: "budget", recommended_for: "output", is_active: true });
    try {
      // preview is IN scope but has no reviewed config entry — must not inherit M1's rate
      const res = await backfillCachedInputPricing({ db, apply: true, models: [M1, M2, preview] });
      assert.ok(!res.ready.concat(res.changed).some(x => x.model === preview));
      assert.ok(res.blocked.some(x => x.model === preview));
      const p = await db.AiPricing.findOne({ where: { model: preview }, raw: true });
      assert.equal(p.cached_input_price_per_million, null);
    } finally {
      await db.AiPricing.destroy({ where: { model: preview } });
    }
  });

  await t.test("transaction rolls back all writes if one update fails", async () => {
    await seed();
    const realCreate = db.AdminAuditLog.create.bind(db.AdminAuditLog);
    let calls = 0;
    db.AdminAuditLog.create = async (...a) => {
      calls++;
      if (calls === 2) throw new Error("forced audit failure");
      return realCreate(...a);
    };
    try {
      await assert.rejects(backfillCachedInputPricing({ db, apply: true, models: [M1, M2] }), /forced audit failure/);
      const [a, b] = [
        await db.AiPricing.findOne({ where: { model: M1 }, raw: true }),
        await db.AiPricing.findOne({ where: { model: M2 }, raw: true }),
      ];
      assert.equal(a.cached_input_price_per_million, null, "M1 rolled back");
      assert.equal(a.pricing_version, 1, "M1 version rolled back");
      assert.equal(b.cached_input_price_per_million, null, "M2 rolled back");
      assert.equal(b.pricing_version, 3, "M2 version rolled back");
      const cat = await db.AiModelCatalog.findOne({ where: { model: M1 }, raw: true });
      const prof = typeof cat.request_profile === "string" ? JSON.parse(cat.request_profile) : cat.request_profile;
      assert.equal(prof.billingCapabilities.cachedInput, false, "catalog profile rolled back");
    } finally {
      db.AdminAuditLog.create = realCreate;
    }
  });

  await t.test("historical ai_token_usage / billing_ledger rows are never modified", async () => {
    await seed();
    const usageBefore = await db.AiTokenUsage.count();
    const ledgerBefore = await db.BillingLedger.count();
    await backfillCachedInputPricing({ db, apply: true, models: [M1, M2] });
    assert.equal(await db.AiTokenUsage.count(), usageBefore);
    assert.equal(await db.BillingLedger.count(), ledgerBefore);
  });
});

test.after(() => { delete CACHED_INPUT_PRICING[M1]; delete CACHED_INPUT_PRICING[M2]; });
