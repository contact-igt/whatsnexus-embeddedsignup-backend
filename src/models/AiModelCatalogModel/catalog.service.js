import db from "../../database/index.js";
import { getOpenAIClient } from "../../utils/ai/getOpenAIClient.js";
import { activationBlockers, matchesApprovedModel, ModelConfigurationError, validateModelId, validateRequestProfile } from "../../utils/ai/modelProfile.js";
import { confirmModelAccess, credentialFingerprint, invalidateModelAccess, sanitizedProviderError } from "../../utils/ai/modelAccess.js";
import { executeModel } from "../../utils/ai/modelExecutor.js";
import { getIO } from "../../middlewares/socket/socket.js";

export function invalidateCatalogCaches() {
  invalidateModelAccess();
  try { getIO().emit("ai-model-catalog-updated", {}); } catch { /* HTTP-only test/process */ }
}

const audit = (actor, action, model, transaction) => db.AdminAuditLog.create({ admin_id: String(actor), action_type: "pricing_update", details: { action, model }, reason: "AI model catalog administration" }, { transaction });
const plain = row => row?.toJSON ? row.toJSON() : row;
// JSON columns can come back as strings on some MySQL/MariaDB setups.
const parseProfile = value => {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return null;
};

export async function listCatalog() {
  const [models, prices, latestSync, latestSuccess] = await Promise.all([
    db.AiModelCatalog.findAll({ order: [["model", "ASC"]], raw: true }),
    db.AiPricing.findAll({ raw: true }),
    db.AiModelSync.findOne({ order: [["id", "DESC"]], raw: true }),
    db.AiModelSync.findOne({ where: { status: "success" }, order: [["id", "DESC"]], raw: true }),
  ]);
  const pricingMap = new Map(prices.map(price => [price.model, price]));
  const entries = models.map(model => {
    const pricing = pricingMap.get(model.model) || null;
    // "blockers" = what stops a FRESH activation (needs a real passed test).
    const blockers = activationBlockers(model, pricing, { forActivation: true });
    // "runtimeBlockers" = what would stop a model that is already active
    // (legacy_grandfathered is acceptable here).
    const runtimeBlockers = activationBlockers(model, pricing, { forActivation: false });
    const active = !!pricing?.is_active;
    const legacy = model.test_status === "legacy_grandfathered";
    const state =
      model.review_status === "retired" ? "Retired"
      : model.review_status === "unsupported" ? "Unsupported"
      : model.lifecycle_status === "shutdown" ? "Unavailable"
      : model.review_status !== "approved" ? "Pending review"
      : !pricing ? "Pricing needed"
      : active && legacy ? "Active (legacy — not live-tested)"
      : active && !runtimeBlockers.length ? "Active"
      : model.test_status === "failed" ? "Test failed"
      : model.test_status !== "passed" ? "Test required"
      : blockers.length ? "Unavailable"
      : "Ready to activate";
    return {
      ...model,
      request_profile: parseProfile(model.request_profile),
      pricing, active, blockers, runtimeBlockers,
      activationReady: !blockers.length,
      is_legacy_grandfathered: legacy,
      state,
    };
  });
  return { models: entries, latestSync, latestSuccess, uncataloguedActiveModels: prices.filter(price => price.is_active && !models.some(model => model.model === price.model)).map(price => price.model) };
}

// Cross-instance mutual exclusion for catalog sync. Uses a MySQL advisory lock,
// which is bound to the CONNECTION (not a transaction), so we hold one dedicated
// connection for the whole sync and release the lock + connection in `finally`.
const SYNC_LOCK_NAME = "whatsnexus_ai_model_catalog_sync";
const SYNC_LOCK_TIMEOUT_SECONDS = 3; // bounded — brief overlaps wait, real overlaps get AI_SYNC_BUSY

export async function syncCatalog() {
  const connection = await db.sequelize.connectionManager.getConnection();
  const query = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
  let locked = false;
  let record;
  try {
    // GET_LOCK returns 1 (acquired), 0 (timed out — someone else holds it), or NULL (error).
    const rows = await query("SELECT GET_LOCK(?, ?) AS acquired", [SYNC_LOCK_NAME, SYNC_LOCK_TIMEOUT_SECONDS]);
    const acquired = rows?.[0]?.acquired;
    locked = Number(acquired) === 1;
    if (!locked) {
      throw new ModelConfigurationError(
        acquired == null ? "Could not acquire the catalog sync lock." : "Catalog refresh is already running.",
        "AI_SYNC_BUSY", 409,
      );
    }
    record = await db.AiModelSync.create({ started_at: new Date(), status: "running" });
    const client = await getOpenAIClient();
    let page = await client.models.list({ timeout: 30000, maxRetries: 0 });
    const models = new Map();
    let pages = 0;
    while (page) {
      if (++pages > 100 || !Array.isArray(page.data)) throw new Error("Incomplete provider pagination");
      for (const model of page.data) {
        validateModelId(model.id);
        if (models.has(model.id)) throw new Error("Repeated model in provider pagination");
        models.set(model.id, model);
      }
      if (typeof page.hasNextPage === "function" && page.hasNextPage()) page = await page.getNextPage();
      else { if (page.has_more) throw new Error("Incomplete provider pagination"); break; }
    }
    if (!models.size) throw new Error("Unexpected empty model response");
    let created = 0;
    let updated = 0;
    await db.sequelize.transaction(async transaction => {
      for (const model of models.values()) {
        const now = new Date();
        const [entry, isNew] = await db.AiModelCatalog.findOrCreate({ where: { provider: "openai", model: model.id }, defaults: { first_seen_at: now, review_status: "pending", lifecycle_status: "available", test_status: "not_tested" }, transaction });
        const metadata = { owned_by: typeof model.owned_by === "string" ? model.owned_by.slice(0, 255) : null, provider_created_at: Number.isFinite(model.created) ? new Date(model.created * 1000) : null, last_seen_at: now, last_successfully_seen_at: now };
        if (model.shutdown_date && /^\d{4}-\d{2}-\d{2}$/.test(model.shutdown_date)) metadata.shutdown_date = model.shutdown_date;
        await entry.update(metadata, { transaction });
        if (isNew) created++; else updated++;
      }
      await record.update({ status: "success", completed_at: new Date(), models_received: models.size, models_created: created, models_updated: updated }, { transaction });
    });
    invalidateCatalogCaches();
    return plain(record);
  } catch (error) {
    if (record) {
      const safe = sanitizedProviderError(error);
      await record.update({ status: "failed", completed_at: new Date(), error_code: safe.code, sanitized_error: safe.message });
      throw new ModelConfigurationError(safe.message, safe.code, 502);
    }
    throw error;
  } finally {
    try {
      if (locked) await query("SELECT RELEASE_LOCK(?)", [SYNC_LOCK_NAME]);
    } catch (releaseErr) {
      // The lock is also freed automatically when this connection closes/returns.
      // eslint-disable-next-line no-console
      console.error("[AI-CATALOG-SYNC] RELEASE_LOCK failed:", releaseErr.message);
    }
    await db.sequelize.connectionManager.releaseConnection(connection);
  }
}

export async function reviewCatalog(id, data, actor) {
  const allowed = ["review_status", "request_profile", "lifecycle_status"];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new ModelConfigurationError("Unsupported catalog update field.");
  if (data.review_status !== undefined && !["pending", "approved", "unsupported", "retired"].includes(data.review_status)) throw new ModelConfigurationError("Invalid review status.");
  if (data.lifecycle_status !== undefined && !["available", "deprecated", "shutdown", "unknown"].includes(data.lifecycle_status)) throw new ModelConfigurationError("Invalid lifecycle status.");
  await db.sequelize.transaction(async transaction => {
    const entry = await db.AiModelCatalog.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!entry) throw new ModelConfigurationError("Model not found.", "NOT_FOUND", 404);
    if (data.request_profile || data.review_status === "approved") validateRequestProfile(data.request_profile || entry.request_profile);
    // A real profile change invalidates any prior test. Changing only
    // review/lifecycle status keeps the existing compatibility status so an
    // in-use legacy_grandfathered model does not suddenly fail runtime checks.
    const profileChanged = data.request_profile !== undefined
      && JSON.stringify(parseProfile(data.request_profile)) !== JSON.stringify(parseProfile(entry.request_profile));
    const patch = { ...data, reviewed_at: new Date(), reviewed_by: String(actor) };
    if (profileChanged) { patch.test_status = "not_tested"; patch.test_result = null; patch.test_error = null; }
    await entry.update(patch, { transaction });
    await audit(actor, "review", entry.model, transaction);
  });
  invalidateCatalogCaches();
}

export async function testCatalog(id, scope, actor) {
  if (!scope || !["platform", "tenant"].includes(scope.credentialScope)) throw new ModelConfigurationError("Choose platform or tenant credential scope.");
  const tenantId = scope.credentialScope === "tenant" ? scope.tenantId : null;
  if (scope.credentialScope === "tenant" && (typeof tenantId !== "string" || !await db.Tenants.findOne({ where: { tenant_id: tenantId, is_deleted: false } }))) throw new ModelConfigurationError("A valid tenant ID is required.");
  const entry = await db.AiModelCatalog.findByPk(id);
  if (!entry) throw new ModelConfigurationError("Model not found.");
  const profile = validateRequestProfile(entry.request_profile);
  const reviewedAt = new Date(entry.reviewed_at).getTime();
  const client = await getOpenAIClient(tenantId);
  const checks = [];
  try {
    await confirmModelAccess(client, tenantId, entry.model, true);
    const cases = [{ name: "text", messages: [{ role: "user", content: "Reply with OK." }] }];
    if (profile.supportsJsonMode) cases.push({ name: "json", messages: [{ role: "user", content: 'Return JSON with key ok and boolean true.' }], responseFormat: { type: "json_object" } });
    if (profile.supportsStructuredOutput) cases.push({ name: "structured", messages: [{ role: "user", content: "Return ok true." }], responseFormat: { type: "json_schema", json_schema: { name: "check", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } });
    if (profile.modalities.includes("image_input")) cases.push({ name: "vision", messages: [{ role: "user", content: [{ type: "text", text: "Name the main color in this image." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", detail: "low" } }] }] });
    let last;
    for (const check of cases) {
      last = await executeModel(client, { model: entry.model, profile, maxTokens: Math.min(512, profile.maxOutputTokens), temperature: 0, ...check });
      if (last.refusal || last.incomplete || !last.content) throw new ModelConfigurationError("Test refused, incomplete, or empty.");
      if (!matchesApprovedModel(profile, last.actualModel)) throw new ModelConfigurationError("Returned model requires an explicit reviewed pricing mapping.");
      if (check.responseFormat && JSON.parse(last.content)?.ok !== true) throw new ModelConfigurationError("JSON output test failed.");
      checks.push({ name: check.name, passed: true });
    }
    const result = { success: true, requestedModel: entry.model, actualModel: last.actualModel, endpoint: profile.endpoint, usage: last.usage, checks, warnings: [], credentialScope: scope.credentialScope, tenantId, credentialFingerprint: credentialFingerprint(client) };
    const [changed] = await db.AiModelCatalog.update({ test_status: "passed", test_error: null, test_result: result, last_tested_at: new Date() }, { where: { id, reviewed_at: entry.reviewed_at } });
    if (!changed || reviewedAt !== new Date(entry.reviewed_at).getTime()) throw new ModelConfigurationError("Profile changed during test; test again.");
    await audit(actor, "compatibility_test", entry.model);
    invalidateCatalogCaches();
    const { credentialFingerprint: omitted, ...publicResult } = result;
    return publicResult;
  } catch {
    await db.AiModelCatalog.update({ test_status: "failed", test_error: "Compatibility test failed. Check profile, access, output budget, and exact returned model mapping.", last_tested_at: new Date() }, { where: { id, reviewed_at: entry.reviewed_at } });
    invalidateCatalogCaches();
    throw new ModelConfigurationError("Compatibility test failed. Check profile, access, output budget, and exact returned model mapping.");
  }
}

export async function activateCatalog(id, active, actor) {
  await db.sequelize.transaction(async transaction => {
    const entry = await db.AiModelCatalog.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!entry) throw new ModelConfigurationError("Model not found.");
    const price = await db.AiPricing.findOne({ where: { model: entry.model }, transaction, lock: transaction.LOCK.UPDATE });
    if (active) {
      // forActivation:true — a real passed live test is required. A
      // legacy_grandfathered model cannot be (re)activated from here; run the
      // compatibility test first.
      const blockers = activationBlockers(entry, price, { forActivation: true });
      if (blockers.length) throw new ModelConfigurationError(blockers.join(" "));
      const test = typeof entry.test_result === "string"
        ? (() => { try { return JSON.parse(entry.test_result); } catch { return null; } })()
        : entry.test_result;
      if (!test?.credentialScope) throw new ModelConfigurationError("Run a compatibility test before activating.");
      const client = await getOpenAIClient(test.tenantId || null);
      if (credentialFingerprint(client) !== test.credentialFingerprint) throw new ModelConfigurationError("Credential changed; repeat the compatibility test.");
      await confirmModelAccess(client, test.tenantId, entry.model, true);
    }
    if (price) await price.update({ is_active: active }, { transaction });
    await entry.update({ activated_at: active ? new Date() : null, activated_by: String(actor) }, { transaction });
    await audit(actor, active ? "activate" : "deactivate", entry.model, transaction);
  });
  invalidateCatalogCaches();
}
