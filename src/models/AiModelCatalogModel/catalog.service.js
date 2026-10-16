import { randomUUID } from "node:crypto";
import db from "../../database/index.js";
import { getOpenAIClient } from "../../utils/ai/getOpenAIClient.js";
import { VISION_TEST_IMAGE_DATA_URL } from "../../utils/ai/testFixtures.js";
import { activationBlockers, matchesApprovedModel, ModelConfigurationError, validateModelId, validateRequestProfile } from "../../utils/ai/modelProfile.js";
import { confirmModelAccess, credentialFingerprint, invalidateModelAccess, sanitizedProviderError, sanitizeErrorForAdmin } from "../../utils/ai/modelAccess.js";
import { classifyTestFailure } from "../../utils/ai/testFailureClassifier.js";
import { executeModel } from "../../utils/ai/modelExecutor.js";
import { recordHealthEvent } from "../../utils/billing/billingHealthMonitor.js";
import { getIO } from "../../middlewares/socket/socket.js";

export function invalidateCatalogCaches() {
  invalidateModelAccess();
  try { getIO().emit("ai-model-catalog-updated", {}); } catch { /* HTTP-only test/process */ }
}

const audit = (actor, action, model, transaction) => db.AdminAuditLog.create({ admin_id: String(actor), action_type: "pricing_update", details: { action, model }, reason: "AI model catalog administration" }, { transaction });

// Guard against duplicate concurrent compatibility tests (each = billable calls).
const testsInFlight = new Set();
const plain = row => row?.toJSON ? row.toJSON() : row;
// JSON columns can come back as strings on some MySQL/MariaDB setups.
const parseProfile = value => {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return null;
};

/**
 * "Can this model be switched ON?" must be judged against the pricing rule as it WILL be once
 * activated. An inactive rule is the normal, expected state BEFORE activation — treating it as a
 * blocker made activation impossible ("Pricing rule is not active." on a model showing
 * "Ready to activate"). Only the runtime path may reject an inactive rule, and it does so by
 * querying `is_active: true` itself, so this does not weaken it.
 */
const asActivatedPrice = price => (price ? { ...plain(price), is_active: true } : price);

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
    const blockers = activationBlockers(model, asActivatedPrice(pricing), { forActivation: true });
    // "runtimeBlockers" = what would stop a model that is already active
    // (legacy_grandfathered is acceptable here).
    const runtimeBlockers = activationBlockers(model, pricing, { forActivation: false });
    const active = !!pricing?.is_active;
    const legacy = model.test_status === "legacy_grandfathered";
    // An active model that failed its most recent test is still serving traffic;
    // surface the warning without pretending it is unavailable.
    const lastTestFailed = !!model.last_test_failure_class
      && (!model.last_tested_at || new Date(model.last_test_attempt_at) > new Date(model.last_tested_at));
    const state =
      model.review_status === "retired" ? "Retired"
      : model.review_status === "unsupported" ? "Unsupported"
      : model.lifecycle_status === "shutdown" ? "Unavailable"
      : model.review_status !== "approved" ? "Pending review"
      : !pricing ? "Pricing needed"
      : active && lastTestFailed ? `Active — last test failed (${model.last_test_failure_class})`
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
      last_test_failed: lastTestFailed,
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
  // An empty object is "no profile supplied", not a profile: otherwise it reaches the validator and
  // fails with a misleading "Unsupported endpoint." instead of "A reviewed request profile is required."
  if (data && typeof data.request_profile === "object" && data.request_profile !== null
    && !Array.isArray(data.request_profile) && Object.keys(data.request_profile).length === 0) {
    const { request_profile: _empty, ...rest } = data;
    data = rest;
  }
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

/**
 * Run a capped live compatibility test. A test NEVER activates or deactivates a
 * model. On failure it records an attempt in ai_model_test_attempts and:
 *   - active model  → keeps it usable (test_status unchanged); definitive
 *     failures raise a high-severity admin alert and require explicit deactivation.
 *   - inactive model → a definitive failure sets test_status="failed" (blocks
 *     activation only); transient/config failures leave test_status alone.
 * A definitive success sets test_status="passed" (promoting legacy_grandfathered).
 */
export async function testCatalog(id, scope, actor) {
  if (!scope || !["platform", "tenant"].includes(scope.credentialScope)) throw new ModelConfigurationError("Choose platform or tenant credential scope.");
  const tenantId = scope.credentialScope === "tenant" ? scope.tenantId : null;
  if (scope.credentialScope === "tenant" && (typeof tenantId !== "string" || !await db.Tenants.findOne({ where: { tenant_id: tenantId, is_deleted: false } }))) throw new ModelConfigurationError("A valid tenant ID is required.");
  const entry = await db.AiModelCatalog.findByPk(id);
  if (!entry) throw new ModelConfigurationError("Model not found.");

  const lockKey = `${entry.id}:${scope.credentialScope}:${tenantId || "-"}`;
  if (testsInFlight.has(lockKey)) throw new ModelConfigurationError("A compatibility test for this model is already running.", "AI_MODEL_TEST_BUSY", 409);
  testsInFlight.add(lockKey);
  try {
    return await runTest();
  } finally {
    testsInFlight.delete(lockKey);
  }

  async function runTest() {
  const correlationId = randomUUID();
  const startedAt = new Date();
  const price = await db.AiPricing.findOne({ where: { model: entry.model }, raw: true });
  const isActive = !!price?.is_active;

  const recordAttempt = (fields) => db.AiModelTestAttempts.create({
    catalog_id: entry.id, credential_scope: scope.credentialScope, tenant_id: tenantId,
    started_at: startedAt, completed_at: new Date(), requested_model: entry.model,
    triggered_by: String(actor), correlation_id: correlationId, ...fields,
  }).catch(() => {});

  let profile;
  try {
    profile = validateRequestProfile(entry.request_profile);
  } catch (error) {
    await recordAttempt({ result_status: "failed", failure_class: "configuration", failing_check: "profile", sanitized_error: sanitizeErrorForAdmin(error, "profile") });
    await db.AiModelCatalog.update({ last_test_attempt_at: new Date(), last_test_failure_class: "configuration", test_error: sanitizeErrorForAdmin(error, "profile") }, { where: { id } });
    invalidateCatalogCaches();
    throw new ModelConfigurationError("The reviewed request profile is invalid — fix it before testing.", "AI_MODEL_CONFIGURATION");
  }
  const reviewedAt = new Date(entry.reviewed_at).getTime();

  let currentCheck = "access";
  try {
    const client = await getOpenAIClient(tenantId).catch(() => { throw new ModelConfigurationError("No usable OpenAI credential for this scope.", "AI_MODEL_ACCESS", 403); });
    await confirmModelAccess(client, tenantId, entry.model, true);

    const cases = [{ name: "text", messages: [{ role: "user", content: "Reply with OK." }] }];
    if (profile.supportsJsonMode) cases.push({ name: "json", messages: [{ role: "user", content: "Return JSON with key ok and boolean true." }], responseFormat: { type: "json_object" } });
    if (profile.supportsStructuredOutput) cases.push({ name: "structured", messages: [{ role: "user", content: "Return ok true." }], responseFormat: { type: "json_schema", json_schema: { name: "check", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } });
    if (profile.modalities.includes("image_input")) cases.push({ name: "vision", messages: [{ role: "user", content: [{ type: "text", text: "Name the main color in this image." }, { type: "image_url", image_url: { url: VISION_TEST_IMAGE_DATA_URL, detail: "low" } }] }] });

    const checks = [];
    let last;
    for (const check of cases) {
      currentCheck = check.name;
      last = await executeModel(client, { model: entry.model, profile, maxTokens: Math.min(512, profile.maxOutputTokens), temperature: 0, ...check });
      if (last.refusal || last.incomplete || !last.content) throw new ModelConfigurationError("Test response was refused, incomplete, or empty.", "AI_OUTPUT_INCOMPLETE");
      if (!matchesApprovedModel(profile, last.actualModel)) throw new ModelConfigurationError("Returned model is not in the approved mapping.", "AI_MODEL_MAPPING");
      if (check.responseFormat) {
        let parsed;
        try { parsed = JSON.parse(last.content); } catch { throw new ModelConfigurationError("Structured-output check returned invalid JSON.", "AI_OUTPUT_INVALID"); }
        if (parsed?.ok !== true) throw new ModelConfigurationError("Structured-output check did not return { ok: true }.", "AI_OUTPUT_INVALID");
      }
      checks.push({ name: check.name, passed: true });
    }

    const result = { success: true, requestedModel: entry.model, actualModel: last.actualModel, endpoint: profile.endpoint, usage: last.usage, checks, warnings: [], credentialScope: scope.credentialScope, tenantId, credentialFingerprint: credentialFingerprint(client), correlationId };
    const [changed] = await db.AiModelCatalog.update(
      { test_status: "passed", test_error: null, test_result: result, last_tested_at: new Date(), last_test_attempt_at: new Date(), last_test_failure_class: null },
      { where: { id, reviewed_at: entry.reviewed_at } },
    );
    if (!changed || reviewedAt !== new Date(entry.reviewed_at).getTime()) throw new ModelConfigurationError("Profile changed during the test — review and test again.", "AI_MODEL_CONFIGURATION");
    await recordAttempt({ result_status: "passed", failing_check: null, actual_model: last.actualModel, test_result: result });
    await audit(actor, "compatibility_test", entry.model);
    invalidateCatalogCaches();
    const { credentialFingerprint: _omit, ...publicResult } = result;
    return publicResult;
  } catch (error) {
    const { failureClass } = classifyTestFailure(error, currentCheck);
    const safe = sanitizeErrorForAdmin(error, currentCheck);
    await recordAttempt({ result_status: "failed", failure_class: failureClass, failing_check: currentCheck, sanitized_error: safe, actual_model: null });

    // Never set "failed" on a model that is currently serving tenants.
    const patch = { last_test_attempt_at: new Date(), last_test_failure_class: failureClass, test_error: safe };
    if (!isActive && failureClass === "definitive") patch.test_status = "failed";
    await db.AiModelCatalog.update(patch, { where: { id } });

    if (isActive && failureClass === "definitive") {
      await recordHealthEvent(
        "billing_failure", null,
        `AI model "${entry.model}" FAILED a definitive compatibility check while ACTIVE — ${safe}. It is still serving tenants; deactivate it explicitly if the failure is real.`,
        { area: "ai_model_catalog", model: entry.model, catalog_id: entry.id, failure_class: failureClass, failing_check: currentCheck, correlation_id: correlationId, requires_manual_deactivation: true },
      ).catch(() => {});
    }
    invalidateCatalogCaches();

    const err = new ModelConfigurationError(safe, error?.code && String(error.code).startsWith("AI_") ? error.code : "AI_MODEL_TEST_FAILED");
    err.failureClass = failureClass;
    err.failingCheck = currentCheck;
    throw err;
  }
  } // end runTest
}

/**
 * Activate/deactivate the GLOBAL pricing row for a model.
 *
 * Global activation requires a PLATFORM-scoped passing compatibility test — one
 * tenant's key having access does not prove platform / other-tenant access. A
 * tenant-scoped pass can only be used with an explicit, audited super-admin
 * override that carries a written reason.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.overrideTenantScopedTest]
 * @param {string}  [opts.overrideReason]
 * @param {boolean} [opts.isSuperAdmin]
 */
export async function activateCatalog(id, active, actor, opts = {}) {
  await db.sequelize.transaction(async transaction => {
    const entry = await db.AiModelCatalog.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!entry) throw new ModelConfigurationError("Model not found.");
    const price = await db.AiPricing.findOne({ where: { model: entry.model }, transaction, lock: transaction.LOCK.UPDATE });
    let platformAccessVerified = false;
    if (active) {
      // forActivation:true — a real passed live test is required.
      const blockers = activationBlockers(entry, asActivatedPrice(price), { forActivation: true });
      if (blockers.length) throw new ModelConfigurationError(blockers.join(" "));
      const test = typeof entry.test_result === "string"
        ? (() => { try { return JSON.parse(entry.test_result); } catch { return null; } })()
        : entry.test_result;
      if (!test?.credentialScope) throw new ModelConfigurationError("Run a compatibility test before activating.");

      if (test.credentialScope === "platform") {
        const client = await getOpenAIClient(null);
        if (credentialFingerprint(client) !== test.credentialFingerprint) throw new ModelConfigurationError("Platform credential changed; repeat the platform-scoped compatibility test.");
        await confirmModelAccess(client, null, entry.model, true);
        platformAccessVerified = true;
      } else {
        // tenant-scoped test → not sufficient for a GLOBAL activation
        if (!opts.overrideTenantScopedTest) {
          throw new ModelConfigurationError("Global activation requires a PLATFORM-scoped passing compatibility test. Run the test with credential scope 'platform', or activate with an explicit override.", "AI_PLATFORM_TEST_REQUIRED", 409);
        }
        if (!opts.isSuperAdmin) throw new ModelConfigurationError("Only a super admin may override the platform-test requirement.", "FORBIDDEN", 403);
        if (typeof opts.overrideReason !== "string" || opts.overrideReason.trim().length < 10) {
          throw new ModelConfigurationError("An override of the platform-test requirement needs a written reason (min 10 chars).");
        }
        // still confirm the tenant credential the test used is unchanged
        const client = await getOpenAIClient(test.tenantId || null);
        if (credentialFingerprint(client) !== test.credentialFingerprint) throw new ModelConfigurationError("Credential changed; repeat the compatibility test.");
        await confirmModelAccess(client, test.tenantId, entry.model, true);
      }
    }
    if (price) await price.update({ is_active: active }, { transaction });
    await entry.update({ activated_at: active ? new Date() : null, activated_by: String(actor) }, { transaction });
    await db.AdminAuditLog.create({
      admin_id: String(actor), action_type: "pricing_update",
      details: {
        area: "ai_model_catalog", action: active ? "activate" : "deactivate", model: entry.model,
        platform_access_verified: active ? platformAccessVerified : null,
        override_tenant_scoped_test: active && !platformAccessVerified ? true : undefined,
        override_reason: active && !platformAccessVerified ? opts.overrideReason : undefined,
      },
      reason: active && !platformAccessVerified
        ? `Activation with tenant-scoped test override — platform access NOT verified. Reason: ${opts.overrideReason}`
        : "AI model catalog administration",
    }, { transaction });
  });
  invalidateCatalogCaches();
}
