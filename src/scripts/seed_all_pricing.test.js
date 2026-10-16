import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute only the AI seed with fake storage; never import the production DB.
const source = readFileSync(new URL("./seed_all_pricing.js", import.meta.url), "utf8");
const start = source.indexOf("const seedAiModelPricing =");
const end = source.indexOf("// MAIN EXECUTION", start);
assert.ok(start >= 0 && end > start);
const existing = { model: "existing", input_rate: 99, cached_input_price_per_million: 7, output_rate: 88, is_active: true };
const before = structuredClone(existing);
const created = [];
const models = ["existing", "reviewed", "unknown"].map(model => ({
  model, category: "test", input_rate: 1, output_rate: 2, is_active: true,
}));
await runInNewContext(`${source.slice(start, end)}\nseedAiModelPricing();`, {
  AI_MODEL_PRICING: models,
  reviewedCachedRate: model => ({ known: model !== "unknown", verified: model !== "unknown", rate: 0.5 }),
  db: { AiPricing: {
    findOne: async ({ where }) => where.model === "existing" ? existing : null,
    create: async row => created.push(row),
  } },
  console: { log() {}, error(...args) { throw new Error(args.join(" ")); } },
});
assert.deepEqual(existing, before);
assert.equal(created.length, 2);
assert.ok(created.every(row => row.is_active === false));
assert.equal(created[0].cached_input_price_per_million, 0.5);
assert.equal(created[1].cached_input_price_per_million, null);
console.log("AI pricing seed regression passed: existing preserved, new inactive.");
