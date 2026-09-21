import crypto from "crypto";
import jwt from "jsonwebtoken";
import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import ServerEnvironmentConfig from "../../config/server.config.js";
import { getEmbeddedSignupConfig } from "../../config/metaEmbeddedSignup.config.js";
import { getSecret, storeSecret } from "../TenantSecretsModel/tenantSecrets.service.js";
import { getTenantWhatsappCapabilitiesService } from "./whatsappCapabilities.service.js";
import { createMetaEmbeddedSignupClient } from "./metaEmbeddedSignup.client.js";
import {
  createEmbeddedSignupService,
  EmbeddedSignupError,
  MIGRATION_MODES,
} from "./whatsappEmbeddedSignup.core.js";
import { resolveConnectionType } from "./whatsappConnectionTypes.js";
import { planIdentityRows } from "./whatsappNumberScope.core.js";
import { whatsappOnboardingSessionStore } from "./whatsappOnboardingSession.store.js";

const SESSION_PURPOSE = "wa_embedded_signup";
const SESSION_TTL = "30m";

// Signed with a purpose-derived secret so a session token can never be replayed
// as a normal API access token (which shares ServerEnvironmentConfig.jwt_key).
const sessionSecret = () => `${ServerEnvironmentConfig.jwt_key}:${SESSION_PURPOSE}`;

// Server-signed onboarding session reference: tenant + user + mode + expiry + nonce.
// The mode lives here (server side); the browser can only echo it back.
const signSession = ({ tenant_id, connection_type, user_id = null }) =>
  jwt.sign(
    { purpose: SESSION_PURPOSE, tenant_id, connection_type, user_id, jti: crypto.randomUUID() },
    sessionSecret(),
    { expiresIn: SESSION_TTL },
  );

const verifySession = (token) => {
  try {
    const decoded = jwt.verify(String(token || ""), sessionSecret());
    return decoded?.purpose === SESSION_PURPOSE ? decoded : null;
  } catch {
    return null;
  }
};

/** Non-deleted account for the tenant, if any. */
export const getActiveAccountRow = async (tenant_id) => {
  const [rows] = await db.sequelize.query(
    `SELECT id, tenant_id, whatsapp_connection_type, status
       FROM ${tableNames.WHATSAPP_ACCOUNT}
      WHERE tenant_id = ? AND is_deleted = false LIMIT 1`,
    { replacements: [tenant_id] },
  );
  return rows[0] || null;
};

/**
 * The tenant's previous connection — active OR soft-disconnected (the row is
 * unique per tenant). A disconnected row still identifies the number whose
 * history exists, so a later different number must not inherit it.
 */
const getExistingAccountRow = async (tenant_id) => {
  const [rows] = await db.sequelize.query(
    `SELECT id, tenant_id, whatsapp_number, phone_number_id, waba_id,
            whatsapp_connection_type, status, is_deleted
       FROM ${tableNames.WHATSAPP_ACCOUNT}
      WHERE tenant_id = ? LIMIT 1`,
    { replacements: [tenant_id] },
  );
  return rows[0] || null;
};

// Default calling code for legacy rows stored without one (e.g. "9876543210").
const getDefaultCountryCode = async (tenant_id) => {
  const [rows] = await db.sequelize.query(
    `SELECT owner_country_code FROM ${tableNames.TENANTS} WHERE tenant_id = ? LIMIT 1`,
    { replacements: [tenant_id] },
  );
  return rows[0]?.owner_country_code ?? null;
};

const findMappingConflicts = async ({ tenant_id, waba_id, phone_number_id, whatsapp_numbers }) => {
  const [rows] = await db.sequelize.query(
    `SELECT tenant_id, waba_id, phone_number_id, whatsapp_number, is_deleted
       FROM ${tableNames.WHATSAPP_ACCOUNT}
      WHERE tenant_id <> ?
        AND (phone_number_id = ? OR whatsapp_number IN (?) OR waba_id = ?)`,
    { replacements: [tenant_id, phone_number_id, whatsapp_numbers, waba_id] },
  );
  return {
    // Unique indexes cover soft-deleted rows too, so those also block the number.
    phone: rows.some(
      (r) => r.phone_number_id === phone_number_id || whatsapp_numbers.includes(r.whatsapp_number),
    ),
    // Template webhooks resolve tenant by WABA, so a live WABA must stay 1:1.
    waba: rows.some((r) => r.waba_id === waba_id && !r.is_deleted),
  };
};

const persistConnection = async (c) => {
  try {
    return await db.sequelize.transaction(async (t) => {
      const [existingRows] = await db.sequelize.query(
        `SELECT id, phone_number_id, is_deleted FROM ${tableNames.WHATSAPP_ACCOUNT} WHERE tenant_id = ? FOR UPDATE`,
        { replacements: [c.tenant_id], transaction: t },
      );
      const row = existingRows[0] || null;

      // Optimistic guard: the connection the decision was based on must still be
      // the one in the table, otherwise the SAME/NEW classification may be stale.
      if ((row?.phone_number_id ?? null) !== (c.previous?.phone_number_id ?? null)) {
        throw new EmbeddedSignupError(
          "CONCURRENT_CHANGE",
          "The WhatsApp connection changed while you were connecting. Nothing was changed; please try again.",
          409,
        );
      }

      // ── Identity decision (append-only; never touches messages) ──
      let historicalTransportIds = [];
      if (c.previous) {
        const [[{ n }]] = await db.sequelize.query(
          `SELECT COUNT(*) AS n FROM ${tableNames.WHATSAPP_NUMBER_IDENTITIES} WHERE tenant_id = ?`,
          { replacements: [c.tenant_id], transaction: t },
        );
        if (Number(n) === 0) {
          // First switch: attribute every transport id already on this org's
          // stored messages to the previous number (it was their only connection).
          const [pidRows] = await db.sequelize.query(
            `SELECT DISTINCT phone_number_id FROM ${tableNames.MESSAGES} WHERE tenant_id = ?`,
            { replacements: [c.tenant_id], transaction: t },
          );
          historicalTransportIds = pidRows.map((r) => r.phone_number_id);
        }
      }

      const plan = planIdentityRows({
        mode: c.mode,
        previous: c.previous,
        next: {
          business_number: c.business_number,
          phone_number_id: c.phone_number_id,
          waba_id: c.waba_id,
          connection_type: c.connection_type,
        },
        historicalTransportIds,
      });
      for (const r of plan) {
        await db.sequelize.query(
          r.seed
            ? // seeds never overwrite an identity that already exists
              `INSERT IGNORE INTO ${tableNames.WHATSAPP_NUMBER_IDENTITIES}
                 (tenant_id, business_number, phone_number_id, waba_id, connection_type, migration_mode, previous_business_number)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            : `INSERT INTO ${tableNames.WHATSAPP_NUMBER_IDENTITIES}
                 (tenant_id, business_number, phone_number_id, waba_id, connection_type, migration_mode, previous_business_number)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE waba_id = VALUES(waba_id),
                 connection_type = VALUES(connection_type),
                 migration_mode = VALUES(migration_mode),
                 previous_business_number = VALUES(previous_business_number)`,
          {
            replacements: [
              c.tenant_id,
              r.business_number,
              r.phone_number_id,
              r.waba_id,
              r.connection_type,
              r.migration_mode,
              r.previous_business_number,
            ],
            transaction: t,
          },
        );
      }

      // ── Connection row (transport metadata only) ──
      const values = [
        c.whatsapp_number,
        c.phone_number_id,
        c.waba_id,
        c.app_id,
        c.connection_type,
        c.meta_business_id,
        c.meta_embedded_config_id,
      ];

      if (row) {
        // A different number starts with fresh quality/tier (they describe the
        // previous number); the same number keeps them until the next sync.
        const reset =
          c.mode === MIGRATION_MODES.NEW_NUMBER ? ", quality = 'UNKNOWN', tier = 'TIER_NOT_SET'" : "";
        await db.sequelize.query(
          `UPDATE ${tableNames.WHATSAPP_ACCOUNT}
              SET whatsapp_number = ?, phone_number_id = ?, waba_id = ?, app_id = ?,
                  whatsapp_connection_type = ?, meta_business_id = ?, meta_embedded_config_id = ?,
                  status = 'active', is_verified = true, verified_at = NOW(), connected_at = NOW(),
                  last_error = NULL, is_deleted = false, deleted_at = NULL,
                  meta_info_synced_at = NULL${reset}
            WHERE id = ?`,
          { replacements: [...values, row.id], transaction: t },
        );
      } else {
        await db.sequelize.query(
          `INSERT INTO ${tableNames.WHATSAPP_ACCOUNT}
             (whatsapp_number, phone_number_id, waba_id, app_id,
              whatsapp_connection_type, meta_business_id, meta_embedded_config_id,
              tenant_id, status, is_verified, verified_at, connected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', true, NOW(), NOW())`,
          { replacements: [...values, c.tenant_id], transaction: t },
        );
      }

      // ── Secrets ──
      if (c.previous && !c.previous.was_deleted) {
        // Keep the superseded token (encrypted, backend-only) so a bad switch can
        // be reverted by support without asking the client for credentials again.
        const previousToken = await getSecret(c.tenant_id, "whatsapp");
        if (previousToken) {
          await storeSecret(c.tenant_id, "whatsapp_previous", previousToken, { transaction: t });
        }
      }
      await storeSecret(c.tenant_id, "whatsapp", c.access_token, { transaction: t });
      if (c.register_pin) {
        // Two-step verification PIN set at registration — needed if the number
        // must ever be re-registered, so it is kept encrypted, backend-only.
        await storeSecret(c.tenant_id, "whatsapp_register_pin", c.register_pin, { transaction: t });
      }

      const [rows] = await db.sequelize.query(
        `SELECT id, tenant_id, whatsapp_number, phone_number_id, waba_id, status,
                whatsapp_connection_type, connected_at
           FROM ${tableNames.WHATSAPP_ACCOUNT} WHERE tenant_id = ? LIMIT 1`,
        { replacements: [c.tenant_id], transaction: t },
      );
      return rows[0];
    });
  } catch (err) {
    if (err instanceof EmbeddedSignupError) throw err;
    if (err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY") {
      throw new EmbeddedSignupError(
        "CONCURRENT_CONNECTION_CONFLICT",
        "Another WhatsApp connection completed at the same time. Please refresh and try again.",
        409,
      );
    }
    console.error("[WA-EMBEDDED] persist failed:", err.message);
    throw new EmbeddedSignupError(
      "PERSIST_FAILED",
      "We could not save the WhatsApp connection. Nothing was changed; please try again.",
      500,
    );
  }
};

// Built per call so env changes / late dotenv loading are always honoured.
const client = () => createMetaEmbeddedSignupClient(getEmbeddedSignupConfig());
const lazyMetaClient = {
  exchangeCode: (...a) => client().exchangeCode(...a),
  listPhoneNumbers: (...a) => client().listPhoneNumbers(...a),
  registerPhone: (...a) => client().registerPhone(...a),
  subscribeApp: (...a) => client().subscribeApp(...a),
};

export const embeddedSignupService = createEmbeddedSignupService({
  getConfig: () => getEmbeddedSignupConfig(),
  getCapabilities: getTenantWhatsappCapabilitiesService,
  getExistingAccount: getExistingAccountRow,
  getDefaultCountryCode,
  findMappingConflicts,
  metaClient: lazyMetaClient,
  persistConnection,
  sessionStore: whatsappOnboardingSessionStore,
  signSession,
  verifySession,
});

/** What the Settings page needs to decide which onboarding UI to render. */
export const getOnboardingConfigService = async (tenant_id) => {
  const caps = (await getTenantWhatsappCapabilitiesService(tenant_id)) || {
    embedded_signup_enabled: false,
    coexistence_enabled: false,
  };
  const existing = await getActiveAccountRow(tenant_id);
  return {
    ...caps,
    has_existing_connection: Boolean(existing),
    whatsapp_connection_type: existing ? resolveConnectionType(existing.whatsapp_connection_type) : null,
    // Available whether or not a connection exists: with one, the frontend adds an
    // explicit confirmation and the server classifies SAME / NEW number.
    methods: {
      standard: caps.embedded_signup_enabled,
      coexistence: caps.embedded_signup_enabled && caps.coexistence_enabled,
    },
  };
};
