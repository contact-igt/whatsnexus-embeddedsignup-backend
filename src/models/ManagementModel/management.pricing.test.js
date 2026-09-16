import test from "node:test";
import assert from "node:assert/strict";
import db from "../../database/index.js";
import { updateAiPricingRuleService } from "./management.service.js";

test("an active model cannot lose its cached-input rate", async () => {
  const transaction = db.sequelize.transaction;
  const findByPk = db.AiPricing.findByPk;
  try {
    db.sequelize.transaction = async (run) => run({ LOCK: { UPDATE: "UPDATE" } });
    db.AiPricing.findByPk = async () => ({
      model: "gpt-4o",
      is_active: true,
      cached_input_price_per_million: 1.25,
      toJSON: () => ({}),
    });
    await assert.rejects(
      updateAiPricingRuleService(1, { cached_input_price_per_million: null }),
      /Cached-input rate is required while this model is active/,
    );
  } finally {
    db.sequelize.transaction = transaction;
    db.AiPricing.findByPk = findByPk;
  }
});
