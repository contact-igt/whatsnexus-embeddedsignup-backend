/**
 * Corrective, idempotent. Brings catalog rows created by 20260910 up to the
 * hardened contract. Does NOT touch tenant selections, historical usage/ledger
 * rows, wallet balances, or global defaults.
 *
 *   1. request_profile: maxInputTokens -> maxInputBytes (same numeric value;
 *      it was always compared as bytes)
 *   2. request_profile: add billingCapabilities (cachedInput=false for now —
 *      backfillAiCachedInputPricing --apply flips it once a verified rate exists)
 *   3. test_status: "passed" + test_result.grandfathered  ->  "legacy_grandfathered"
 *      (these were never live-tested; existing tenants keep running, new
 *      activations now require a real passed test)
 *
 *   node migrations/20260911_ai_catalog_hardening.js
 */
import { pathToFileURL } from "node:url";

const parseJson = v => {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
};

export async function up(db) {
  const rows = await db.AiModelCatalog.findAll();
  let profilesFixed = 0;
  let statusesFixed = 0;

  for (const row of rows) {
    const profile = parseJson(row.request_profile);
    const testResult = parseJson(row.test_result);
    const patch = {};

    if (profile) {
      let changed = false;
      if (profile.maxInputTokens !== undefined && profile.maxInputBytes === undefined) {
        profile.maxInputBytes = profile.maxInputTokens;
        delete profile.maxInputTokens;
        changed = true;
      }
      if (profile.billingCapabilities === undefined) {
        profile.billingCapabilities = {
          standardInput: true, cachedInput: false, standardOutput: true,
          longContext: false, cacheWrite: false, tools: false, serviceTier: false,
        };
        changed = true;
      }
      if (changed) { patch.request_profile = profile; profilesFixed++; }
    }

    if (row.test_status === "passed" && testResult?.grandfathered) {
      patch.test_status = "legacy_grandfathered";
      patch.test_result = { ...testResult, status: "legacy_grandfathered" };
      statusesFixed++;
    }

    if (Object.keys(patch).length) await row.update(patch);
  }

  console.log(`[ai-catalog-hardening] up complete: ${profilesFixed} profiles migrated, ${statusesFixed} statuses -> legacy_grandfathered.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "down") throw new Error("Corrective + additive only; revert application code instead of running a down migration.");
  const { default: db } = await import("../src/database/index.js");
  try { await up(db); } finally { await db.sequelize.close(); }
}
