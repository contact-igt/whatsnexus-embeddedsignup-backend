import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import { resolveCapabilities } from "./whatsappConnectionTypes.js";

const notFound = () => {
  const err = new Error("Tenant details not found");
  err.statusCode = 404;
  return err;
};

const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};

/** Effective (server-side) WhatsApp onboarding capabilities for an organization. */
export const getTenantWhatsappCapabilitiesService = async (tenant_id) => {
  const [rows] = await db.sequelize.query(
    `SELECT embedded_signup_enabled, coexistence_enabled
       FROM ${tableNames.TENANTS}
      WHERE tenant_id = ? AND is_deleted = false LIMIT 1`,
    { replacements: [tenant_id] },
  );
  if (!rows.length) return null;
  return resolveCapabilities(rows[0]);
};

/**
 * Partial update of an organization's capabilities (Super Admin only — enforced
 * at the route). Never touches whatsapp_accounts: turning a flag off does NOT
 * disconnect an established connection, it only hides/blocks NEW onboarding.
 *
 * Coexistence cannot be ON while Embedded Signup is OFF; turning Embedded
 * Signup off therefore also clears coexistence to keep the representation clean.
 */
export const updateTenantWhatsappCapabilitiesService = async (
  tenant_id,
  patch = {},
  actor = {},
) => {
  for (const key of ["embedded_signup_enabled", "coexistence_enabled"]) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
      throw badRequest(`${key} must be a boolean`);
    }
  }
  if (patch.embedded_signup_enabled === undefined && patch.coexistence_enabled === undefined) {
    throw badRequest("No capability provided to update");
  }

  const before = await getTenantWhatsappCapabilitiesService(tenant_id);
  if (!before) throw notFound();

  const embedded = patch.embedded_signup_enabled ?? before.embedded_signup_enabled;
  const coexistence = embedded
    ? (patch.coexistence_enabled ?? before.coexistence_enabled)
    : false;

  if (patch.coexistence_enabled === true && !embedded) {
    throw badRequest("Enable Embedded Signup before enabling Business App coexistence");
  }

  await db.sequelize.query(
    `UPDATE ${tableNames.TENANTS}
        SET embedded_signup_enabled = ?, coexistence_enabled = ?
      WHERE tenant_id = ? AND is_deleted = false`,
    { replacements: [embedded, coexistence, tenant_id] },
  );

  const after = { embedded_signup_enabled: embedded, coexistence_enabled: coexistence };

  // Audit is best-effort: a failure to write the audit row must not block or
  // roll back the capability change the Super Admin just made.
  try {
    await db.AdminAuditLog.create({
      admin_id: String(actor.unique_id || actor.management_id || actor.id || "unknown"),
      tenant_id,
      action_type: "whatsapp_capability_change",
      details: { changed: Object.keys(patch) },
      before_state: before,
      after_state: after,
      ip_address: actor.ip || null,
      user_agent: actor.user_agent || null,
    });
  } catch (auditErr) {
    console.error("[WA-CAPABILITIES] audit log write failed:", auditErr.message);
  }

  return after;
};
