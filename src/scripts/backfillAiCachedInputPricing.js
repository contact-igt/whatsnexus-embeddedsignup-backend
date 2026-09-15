/**
 * Backfill reviewed cached-input rates onto ACTIVE AiPricing rows and flip the
 * matching catalog profile's billingCapabilities.cachedInput to true.
 *
 *   node src/scripts/backfillAiCachedInputPricing.js --dry-run          (default)
 *   node src/scripts/backfillAiCachedInputPricing.js --apply
 *   node src/scripts/backfillAiCachedInputPricing.js --apply --resolve-conflicts
 *   node src/scripts/backfillAiCachedInputPricing.js --apply --allow-production
 *
 * Rules:
 *   - dry-run by default; --apply required for any write
 *   - rates come only from src/config/aiCachedInputPricing.js (reviewed config)
 *   - EXACT model-id match only — never prefix / family matching
 *   - never overwrites an existing non-null cached rate unless --resolve-conflicts
 *   - equal existing rate => skipped; differing existing rate => conflict
 *   - pricing_version increments ONLY when a rate actually changes
 *   - the whole --apply runs in ONE transaction and rolls back entirely on error
 *   - writes an admin_audit_log row per changed rule (before/after state)
 *   - historical ai_token_usage / billing_ledger rows are never touched
 *   - refuses an unknown INVICTUS_SERVER_LINE; production needs --allow-production
 *   - never logs credentials
 */
import { pathToFileURL } from "node:url";
import ServerEnvironmentConfig from "../config/server.config.js";
import DatabaseEnvironmentConfig from "../config/database.config.js";
import { CACHED_INPUT_PRICING_REVIEWED_ON, reviewedCachedRate } from "../config/aiCachedInputPricing.js";
import { billingCapabilities } from "../utils/ai/modelProfile.js";

const KNOWN_ENVIRONMENTS = ["production", "stage", "development", "local"];

export function resolveEnvironment() {
  const raw = (ServerEnvironmentConfig?.server?.line || "").trim();
  const name = raw || "local";
  if (raw && !KNOWN_ENVIRONMENTS.includes(raw)) {
    throw new Error(`Unknown INVICTUS_SERVER_LINE "${raw}". Expected one of: ${KNOWN_ENVIRONMENTS.join(", ")}.`);
  }
  const dbCfg =
    name === "production" ? DatabaseEnvironmentConfig.live
    : name === "development" ? DatabaseEnvironmentConfig.development
    : name === "stage" ? DatabaseEnvironmentConfig.stage
    : DatabaseEnvironmentConfig.local;
  return { name, database: dbCfg?.database || "(unknown)", host: dbCfg?.host || "(unknown)" };
}

const parseProfile = v => {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
};
const eq = (a, b) => Number(a) === Number(b);

/**
 * @param {object} opts
 * @param {import("../database/index.js").default} opts.db
 * @param {boolean} [opts.apply=false]
 * @param {boolean} [opts.resolveConflicts=false]
 * @param {string[]} [opts.models] - restrict to these EXACT active model ids
 *   (operational: backfill one model; tests: only touch throwaway rows). When
 *   omitted, every active pricing row is inspected.
 */
export async function backfillCachedInputPricing({ db, apply = false, resolveConflicts = false, models = null }) {
  const where = { is_active: true };
  if (Array.isArray(models)) where.model = models;
  const prices = await db.AiPricing.findAll({ where, raw: true, order: [["model", "ASC"]] });

  const ready = [];      // will set a rate on a currently-null row
  const changed = [];    // --resolve-conflicts overwrote a differing rate
  const skipped = [];    // existing rate already equals the reviewed rate
  const conflicts = [];  // existing rate/ref differs from reviewed config
  const blocked = [];    // no verified reviewed cached rate

  for (const price of prices) {
    const { rate, verified, known, referenceInput, referenceOutput } = reviewedCachedRate(price.model);
    const before = Number(price.pricing_version) || 1;

    // Reference cross-check on the STANDARD rates. Never written — reported only.
    const refIssues = [];
    if (referenceInput != null && !eq(price.input_rate, referenceInput)) refIssues.push(`input_rate db=${price.input_rate} config=${referenceInput}`);
    if (referenceOutput != null && !eq(price.output_rate, referenceOutput)) refIssues.push(`output_rate db=${price.output_rate} config=${referenceOutput}`);

    if (!known || !verified || rate == null) {
      blocked.push({ model: price.model, reason: known ? "cached rate not verified in config" : "no reviewed config entry", cached_input_execution: "blocked", ref_issues: refIssues });
      continue;
    }

    const catalog = await db.AiModelCatalog.findOne({ where: { provider: "openai", model: price.model }, raw: true });
    const existing = price.cached_input_price_per_million;

    if (refIssues.length) {
      conflicts.push({ model: price.model, type: "standard_rate_reference_mismatch", details: refIssues, action: "not written by this script — fix the pricing rule or the config" });
    }

    if (existing == null) {
      ready.push({ model: price.model, cached_rate: rate, pricing_version_from: before, pricing_version_to: before + 1, _price: price, _catalog: catalog });
      continue;
    }
    if (eq(existing, rate)) {
      skipped.push({ model: price.model, cached_rate: Number(existing), pricing_version: before });
      continue;
    }
    // existing cached rate differs from the reviewed config
    if (resolveConflicts) {
      changed.push({ model: price.model, from_cached_rate: Number(existing), to_cached_rate: rate, pricing_version_from: before, pricing_version_to: before + 1, _price: price, _catalog: catalog });
    } else {
      conflicts.push({ model: price.model, type: "cached_rate_mismatch", db_cached_rate: Number(existing), config_cached_rate: rate, action: "left unchanged — pass --resolve-conflicts to overwrite" });
    }
  }

  const versionsBefore = {};
  const versionsAfter = {};
  const writes = [...ready, ...changed];
  for (const w of writes) {
    versionsBefore[w.model] = w.pricing_version_from;
    versionsAfter[w.model] = w.pricing_version_to;
  }

  const concurrentlyModified = [];

  if (apply && writes.length) {
    await db.sequelize.transaction(async transaction => {
      for (const w of writes) {
        const staleId = w._price.id;
        const expectedVersion = w.pricing_version_from;
        const expectedCached = w.cached_rate != null ? null : Number(w.from_cached_rate); // null-fill vs overwrite
        const targetRate = w.cached_rate ?? w.to_cached_rate;

        // Re-read + lock INSIDE the transaction; only write if the row is still
        // in the state we planned for.
        const row = await db.AiPricing.findByPk(staleId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!row) { concurrentlyModified.push({ model: w.model, why: "row deleted" }); continue; }
        const currentCached = row.cached_input_price_per_million;
        const currentVersion = Number(row.pricing_version) || 1;

        const stateMatches = Number(currentVersion) === Number(expectedVersion)
          && (expectedCached === null ? currentCached == null : Number(currentCached) === expectedCached);
        if (!stateMatches) {
          concurrentlyModified.push({ model: w.model, why: `expected v${expectedVersion}/cached=${expectedCached ?? "null"} but found v${currentVersion}/cached=${currentCached ?? "null"}` });
          if (!resolveConflicts) continue;
          // With --resolve-conflicts we still refuse if the version moved (a real
          // pricing edit happened); we only tolerate the cached-rate differing.
          if (Number(currentVersion) !== Number(expectedVersion)) continue;
        }

        await row.update(
          { cached_input_price_per_million: targetRate, pricing_version: db.sequelize.literal("pricing_version + 1") },
          { transaction },
        );

        const catalog = await db.AiModelCatalog.findOne({ where: { provider: "openai", model: w.model }, transaction });
        if (catalog) {
          const profile = parseProfile(catalog.request_profile);
          if (profile) {
            await catalog.update(
              { request_profile: { ...profile, billingCapabilities: { ...billingCapabilities(profile), cachedInput: true } } },
              { transaction },
            );
          }
        }
        await db.AdminAuditLog.create({
          admin_id: "backfill-script",
          action_type: "pricing_update",
          details: { area: "ai_pricing", action: "cached_input_backfill", model: w.model, cached_rate: targetRate },
          before_state: { cached_input_price_per_million: currentCached, pricing_version: currentVersion },
          after_state: { cached_input_price_per_million: targetRate, pricing_version: currentVersion + 1, billingCapabilities_cachedInput: true },
          reason: "Backfill reviewed cached-input pricing",
        }, { transaction });
      }
      if (concurrentlyModified.length && !resolveConflicts) {
        throw new Error(`Aborting — ${concurrentlyModified.length} row(s) changed since the dry-run: ${JSON.stringify(concurrentlyModified)}. Re-run.`);
      }
    });
  }

  const strip = ({ _price, _catalog, ...rest }) => rest;
  return {
    reviewedOn: CACHED_INPUT_PRICING_REVIEWED_ON,
    modelsInspected: prices.length,
    ready: ready.map(strip),
    changed: changed.map(strip),
    skipped,
    conflicts,
    blocked,
    concurrentlyModified,
    versionsBefore,
    versionsAfter,
  };
}

function report(env, result, apply) {
  const rows = arr => arr.length ? arr.map(r => "  " + JSON.stringify(r)).join("\n") : "  (none)";
  console.log("\n──────────────────────────────────────────────");
  console.log(" Cached-input pricing backfill");
  console.log("──────────────────────────────────────────────");
  console.log(`Environment           : ${env.name}`);
  console.log(`Database              : ${env.database} @ ${env.host}`);
  console.log(`Config reviewed on    : ${result.reviewedOn}`);
  console.log(`Mode                  : ${apply ? "APPLY (writing, single transaction)" : "DRY RUN (no writes)"}`);
  console.log(`Models inspected      : ${result.modelsInspected}`);
  console.log(`Ready (null -> set)   : ${result.ready.length}`);
  console.log(`Changed (overwrite)   : ${result.changed.length}`);
  console.log(`Skipped (already set) : ${result.skipped.length}`);
  console.log(`Conflicts             : ${result.conflicts.length}`);
  console.log(`Blocked               : ${result.blocked.length}`);
  console.log(`\nPricing versions before/after (only rows that change):`);
  const models = Object.keys(result.versionsAfter);
  console.log(models.length ? models.map(m => `  ${m}: v${result.versionsBefore[m]} -> v${result.versionsAfter[m]}`).join("\n") : "  (none)");
  console.log(`\nREADY:\n${rows(result.ready)}`);
  console.log(`\nCHANGED:\n${rows(result.changed)}`);
  console.log(`\nSKIPPED:\n${rows(result.skipped)}`);
  console.log(`\nCONFLICTS:\n${rows(result.conflicts)}`);
  console.log(`\nCONCURRENTLY MODIFIED (aborted / skipped):\n${rows(result.concurrentlyModified || [])}`);
  console.log(`\nBLOCKED:\n${rows(result.blocked)}`);
  if (result.blocked.length) console.log("\n⚠  Blocked models emit a reconciliation event (no wallet charge) if OpenAI returns cached tokens. Add verified rates to src/config/aiCachedInputPricing.js.");
  if (result.conflicts.length) console.log("\n⚠  Conflicts were NOT written. Investigate the mismatch, then re-run with --resolve-conflicts if the reviewed config is authoritative.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;
  if (apply && args.includes("--dry-run")) { console.error("Pass either --dry-run or --apply, not both."); process.exit(2); }
  const resolveConflicts = args.includes("--resolve-conflicts");
  const modelsArg = args.find(a => a.startsWith("--models="));
  const models = modelsArg ? modelsArg.slice("--models=".length).split(",").map(s => s.trim()).filter(Boolean) : null;

  let env;
  try { env = resolveEnvironment(); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (apply && env.name === "production" && !args.includes("--allow-production")) {
    console.error("Refusing to --apply against production without --allow-production.");
    process.exit(2);
  }

  const { default: db } = await import("../database/index.js");
  try {
    const result = await backfillCachedInputPricing({ db, apply: apply && !dryRun ? true : apply, resolveConflicts, models });
    report(env, result, apply);
    if (result.conflicts.length && !resolveConflicts) process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
}
