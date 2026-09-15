import db from "../../database/index.js";
import { Op } from "sequelize";
import { getIO } from "../../middlewares/socket/socket.js";
import { logger } from "../logger.js";

/**
 * Record a billing system health event.
 *
 * @param {string} event_type   - billing_failure | payment_failure | cron_failure | invoice_error | lock_conflict | currency_fetch_error | reconciliation_mismatch | reconciliation_report
 * @param {string|null} tenant_id - Affected tenant (null for system-wide)
 * @param {string} error_message
 * @param {object} metadata     - Stack trace, context data
 */
export const recordHealthEvent = async (
  event_type,
  tenant_id,
  error_message,
  metadata = {},
) => {
  try {
    await db.BillingSystemHealth.create({
      event_type,
      tenant_id: tenant_id || null,
      error_message: error_message || "",
      metadata: metadata || {},
      resolved: false,
    });

    logger.error(
      `[BILLING-HEALTH] ${event_type} | tenant=${tenant_id || "system"} | ${error_message}`,
    );
  } catch (err) {
    // Health monitor itself must never crash the caller
    logger.error(
      `[BILLING-HEALTH] Failed to record health event: ${err.message}`,
    );
  }
};

/**
 * Record an AI billing reconciliation event (uncharged AI usage that needs
 * operator review). Idempotent per (tenant, requested model, pricing version,
 * reason, day) so a repeating misconfiguration produces one open item, not a
 * flood. Never stores API keys or prompt content.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} [p.source]
 * @param {string} p.reason - machine reason code
 * @param {string} p.requestedModel
 * @param {string} p.actualModel
 * @param {string|null} [p.actualModelMapping]
 * @param {number} [p.pricingRuleId]
 * @param {number} [p.pricingVersion]
 * @param {string} [p.endpoint]
 * @param {string|null} [p.serviceTier]
 * @param {object} p.usage - normalized usage
 * @param {string} [p.correlationId]
 */
export const recordBillingReconciliation = async (p) => {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const idempotencyKey = [
      "ai_reconcile", p.tenantId || "system", p.requestedModel || "?",
      p.pricingVersion ?? "?", p.reason || "?", day,
    ].join("|");

    const metadata = {
      idempotency_key: idempotencyKey,
      status: "open",
      reason: p.reason,
      source: p.source || null,
      correlation_id: p.correlationId || null,
      requested_model: p.requestedModel,
      actual_model: p.actualModel,
      actual_model_mapping: p.actualModelMapping || null,
      pricing_rule_id: p.pricingRuleId ?? null,
      pricing_version: p.pricingVersion ?? null,
      endpoint: p.endpoint || null,
      service_tier: p.serviceTier ?? null,
      // sanitised numeric usage only — never prompts / responses / credentials
      usage: p.usage ? { inputTokens: p.usage.inputTokens ?? null, cachedInputTokens: p.usage.cachedInputTokens ?? null, outputTokens: p.usage.outputTokens ?? null, reasoningTokens: p.usage.reasoningTokens ?? null, totalTokens: p.usage.totalTokens ?? null } : null,
      raw_usage_summary: p.rawUsageSummary || null,
      rate_snapshot: p.rateSnapshot || null,
      markup_snapshot: p.markupSnapshot ?? null,
      fx_snapshot: p.fxSnapshot ?? null,
      wallet_stage_reached: p.walletStageReached || null,
      sanitized_error: typeof p.error === "string" ? p.error.slice(0, 300) : null,
      occurrences: 1,
      last_seen_at: new Date().toISOString(),
    };

    // Collapse repeats: bump occurrences on an existing open event for the day.
    const existing = await db.BillingSystemHealth.findOne({
      where: { event_type: "billing_failure", tenant_id: p.tenantId || null, resolved: false },
      order: [["created_at", "DESC"]],
    });
    if (existing && existing.metadata?.idempotency_key === idempotencyKey) {
      await existing.update({
        metadata: {
          ...existing.metadata,
          occurrences: (existing.metadata.occurrences || 1) + 1,
          last_seen_at: metadata.last_seen_at,
          usage: metadata.usage,
        },
      });
      return;
    }

    await db.BillingSystemHealth.create({
      event_type: "billing_failure",
      tenant_id: p.tenantId || null,
      error_message: `AI usage uncharged — ${p.reason} (requested=${p.requestedModel}, actual=${p.actualModel}). Wallet not charged; reconcile manually.`,
      metadata,
      resolved: false,
    });
    logger.error(`[AI-RECONCILE] ${idempotencyKey} — no wallet charge applied.`);
  } catch (err) {
    logger.error(`[AI-RECONCILE] failed to record reconciliation event: ${err.message}`);
  }
};

/**
 * Get health summary for the last 24 hours.
 * Grouped by event_type with counts.
 *
 * @returns {Promise<object>}
 */
export const getHealthSummary = async () => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const events = await db.BillingSystemHealth.findAll({
      where: { createdAt: { [Op.gte]: since } },
      attributes: [
        "event_type",
        [db.sequelize.fn("COUNT", db.sequelize.col("id")), "count"],
      ],
      group: ["event_type"],
      raw: true,
    });

    const summary = {};
    for (const e of events) {
      summary[e.event_type] = parseInt(e.count, 10);
    }

    const unresolvedCount = await db.BillingSystemHealth.count({
      where: { resolved: false },
    });

    // AI billing reconciliation = uncharged AI usage awaiting operator review.
    const aiReconcileOpen = await db.BillingSystemHealth.count({
      where: {
        resolved: false,
        event_type: "billing_failure",
        error_message: { [Op.like]: "AI usage uncharged%" },
      },
    });

    return {
      period: "last_24h",
      events: summary,
      total_unresolved: unresolvedCount,
      ai_reconciliation_open: aiReconcileOpen,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`[BILLING-HEALTH] getHealthSummary failed: ${err.message}`);
    return {
      period: "last_24h",
      events: {},
      total_unresolved: 0,
      error: err.message,
    };
  }
};

/**
 * Check health alert thresholds and emit admin alerts.
 * Called by a 15-minute cron interval.
 */
export const checkHealthAlerts = async () => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Count events in last hour
    const recentCounts = await db.BillingSystemHealth.findAll({
      where: { createdAt: { [Op.gte]: oneHourAgo } },
      attributes: [
        "event_type",
        [db.sequelize.fn("COUNT", db.sequelize.col("id")), "count"],
      ],
      group: ["event_type"],
      raw: true,
    });

    const countMap = {};
    for (const r of recentCounts) {
      countMap[r.event_type] = parseInt(r.count, 10);
    }

    const alerts = [];

    if ((countMap.billing_failure || 0) > 10) {
      alerts.push({
        type: "billing_failure",
        count: countMap.billing_failure,
        window: "1h",
      });
    }
    if ((countMap.payment_failure || 0) > 5) {
      alerts.push({
        type: "payment_failure",
        count: countMap.payment_failure,
        window: "1h",
      });
    }

    // Check 24h window for critical events
    const dailyCounts = await db.BillingSystemHealth.findAll({
      where: { createdAt: { [Op.gte]: oneDayAgo } },
      attributes: [
        "event_type",
        [db.sequelize.fn("COUNT", db.sequelize.col("id")), "count"],
      ],
      group: ["event_type"],
      raw: true,
    });

    const dailyMap = {};
    for (const r of dailyCounts) {
      dailyMap[r.event_type] = parseInt(r.count, 10);
    }

    if ((dailyMap.cron_failure || 0) > 0) {
      alerts.push({
        type: "cron_failure",
        count: dailyMap.cron_failure,
        window: "24h",
      });
    }
    if ((dailyMap.invoice_error || 0) > 0) {
      alerts.push({
        type: "invoice_error",
        count: dailyMap.invoice_error,
        window: "24h",
      });
    }

    // Emit admin alert if any threshold breached
    if (alerts.length > 0) {
      try {
        const io = getIO();
        io.to("management-room").emit("billing-health-alert", {
          alerts,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}

      logger.warn(
        `[BILLING-HEALTH] Alerts triggered: ${JSON.stringify(alerts)}`,
      );
    }

    return alerts;
  } catch (err) {
    logger.error(`[BILLING-HEALTH] checkHealthAlerts failed: ${err.message}`);
    return [];
  }
};

/**
 * Mark a health event as resolved.
 */
export const resolveHealthEvent = async (eventId) => {
  try {
    await db.BillingSystemHealth.update(
      { resolved: true },
      { where: { id: eventId } },
    );
  } catch (err) {
    logger.error(`[BILLING-HEALTH] resolveHealthEvent failed: ${err.message}`);
  }
};

/**
 * Get recent unresolved health events.
 */
export const getUnresolvedEvents = async (limit = 50) => {
  try {
    const events = await db.BillingSystemHealth.findAll({
      where: { resolved: false },
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      raw: true,
    });
    return events;
  } catch (err) {
    logger.error(`[BILLING-HEALTH] getUnresolvedEvents failed: ${err.message}`);
    return [];
  }
};
