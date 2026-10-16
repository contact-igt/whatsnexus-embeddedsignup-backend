import crypto from "crypto";
import {
  EMBEDDED_CONNECTION_TYPES,
  WHATSAPP_CONNECTION_TYPES,
} from "./whatsappConnectionTypes.js";
import {
  getEmbeddedSignupLaunchConfig,
  getMissingEmbeddedSignupConfig,
} from "../../config/metaEmbeddedSignup.config.js";
import { redactSecrets } from "../../utils/redactSecrets.js";
import {
  businessNumberStorageVariants,
  cleanCountryCode,
  normalizeBusinessNumber,
} from "../../utils/businessNumber.js";

/**
 * Embedded Signup orchestration as a RECOVERABLE, server-persisted state machine.
 * Free of DB / HTTP imports: every side effect comes in through `deps`, so the rules
 * (feature gating, tenant isolation, standard-vs-coexistence branching, recovery)
 * are unit-testable and the controller stays thin.
 *
 *   STARTED → AUTHORIZED → ASSETS_RESOLVED
 *        standard:    → REGISTRATION_PENDING → REGISTERED_META ┐
 *        coexistence: (registration states are skipped) ───────┤
 *                                          → SUBSCRIBE_PENDING → SUBSCRIBED
 *                                          → VALIDATING → ACTIVE
 *   terminal: ACTIVE | FAILED | ROLLBACK_REQUIRED
 *
 * Existing production connection: it is NEVER modified before VALIDATING. The one
 * atomic switch (persistConnection) happens after Meta registration/subscription
 * succeeded; any failure before it leaves the current connection active and
 * untouched. Failures AFTER a Meta side effect keep the state (and the encrypted
 * token + PIN) so the flow resumes from the right step instead of restarting.
 */

export class EmbeddedSignupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "EmbeddedSignupError";
    this.code = code;
    this.status = status;
    this.onboarding = null; // sanitized onboarding state, when one exists
  }
}

export const ONBOARDING_STATES = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  STARTED: "STARTED",
  AUTHORIZED: "AUTHORIZED",
  ASSETS_RESOLVED: "ASSETS_RESOLVED",
  REGISTRATION_PENDING: "REGISTRATION_PENDING",
  REGISTERED_META: "REGISTERED_META",
  SUBSCRIBE_PENDING: "SUBSCRIBE_PENDING",
  SUBSCRIBED: "SUBSCRIBED",
  VALIDATING: "VALIDATING",
  ACTIVE: "ACTIVE",
  FAILED: "FAILED",
  ROLLBACK_REQUIRED: "ROLLBACK_REQUIRED",
});
const S = ONBOARDING_STATES;

const PROGRESS = [
  S.STARTED,
  S.AUTHORIZED,
  S.ASSETS_RESOLVED,
  S.REGISTRATION_PENDING,
  S.REGISTERED_META,
  S.SUBSCRIBE_PENDING,
  S.SUBSCRIBED,
  S.VALIDATING,
  S.ACTIVE,
];

/** true when `state` is at or beyond `target` on the happy path. */
export const reached = (state, target) => {
  const a = PROGRESS.indexOf(state);
  return a !== -1 && a >= PROGRESS.indexOf(target);
};
export const isTerminalState = (state) =>
  state === S.ACTIVE || state === S.FAILED || state === S.ROLLBACK_REQUIRED;

/** A session can be resumed once its token is stored and assets are resolved. */
export const isResumable = (ob) => !!ob && !isTerminalState(ob.state) && reached(ob.state, S.ASSETS_RESOLVED);

/** Sanitized view returned to the frontend — never any credential. */
export const publicOnboarding = (ob) =>
  ob
    ? {
        onboarding_id: ob.onboarding_id,
        state: ob.state,
        connection_type: ob.connection_type,
        resumable: isResumable(ob),
        last_error_code: ob.last_error_code ?? null,
      }
    : null;

// Errors that retrying the same session cannot fix.
const NON_RETRYABLE = new Set([
  "NUMBER_ALREADY_MAPPED_TO_ANOTHER_ORG",
  "WABA_ALREADY_MAPPED",
  "COEXISTENCE_NOT_ELIGIBLE",
  "EXISTING_NUMBER_UNVERIFIABLE",
  "SAME_ORG_ALREADY_CONNECTED",
  "PHONE_NOT_RETURNED",
  "PHONE_AMBIGUOUS",
  "INVALID_MODE",
]);

const ID_PATTERN = /^\d{5,32}$/;
export const SESSION_EVENTS = Object.freeze({
  STANDARD: "FINISH",
  COEXISTENCE: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
});

/**
 * How the newly connected number relates to what the organization had before.
 * Decided ONLY on the server (never by the frontend):
 *   FIRST_CONNECTION  no previous WhatsApp connection at all
 *   SAME_NUMBER       same canonical business number → conversation history continues
 *   NEW_NUMBER        different business number → previous history is kept in the
 *                     database but is NOT attached to / shown under the new number
 */
export const MIGRATION_MODES = Object.freeze({
  FIRST_CONNECTION: "FIRST_CONNECTION",
  SAME_NUMBER: "SAME_NUMBER",
  NEW_NUMBER: "NEW_NUMBER",
});

const digitsOnly = (v) => String(v ?? "").replace(/\D/g, "");
const generatePin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** Sanitized view returned to the frontend — never any credential. */
export const toPublicConnection = (row) => ({
  id: row.id ?? null,
  tenant_id: row.tenant_id,
  whatsapp_number: row.whatsapp_number,
  phone_number_id: row.phone_number_id,
  waba_id: row.waba_id,
  status: row.status,
  whatsapp_connection_type: row.whatsapp_connection_type,
  connected_at: row.connected_at ?? null,
});

const publicMigration = ({ mode, business_number, previous_business_number }) => ({
  migration_mode: mode,
  business_number,
  previous_business_number: previous_business_number ?? null,
  // NEW_NUMBER: old conversations stay stored but are not shown under the new number.
  previous_history_hidden: mode === MIGRATION_MODES.NEW_NUMBER,
});

export const createEmbeddedSignupService = (deps) => {
  const {
    getConfig,
    getCapabilities,
    getExistingAccount,
    getDefaultCountryCode = async () => null,
    findMappingConflicts,
    metaClient,
    persistConnection,
    sessionStore,
    signSession,
    verifySession,
    logger = console,
    leaseSeconds = 120,
  } = deps;

  /**
   * Error text that is safe to log. Defence in depth: the Meta client already
   * redacts, but this layer must not depend on it — token/secret/code patterns AND
   * the literal configured App Secret are removed from anything that gets logged.
   */
  const safeMessage = (err) => {
    let message = redactSecrets(err?.message);
    let secret = null;
    try {
      secret = getConfig()?.appSecret;
    } catch {
      secret = null;
    }
    if (secret) message = message.split(secret).join("[redacted]");
    return message;
  };

  const assertModeAllowed = async (tenant_id, connection_type) => {
    if (!EMBEDDED_CONNECTION_TYPES.includes(connection_type)) {
      throw new EmbeddedSignupError("INVALID_MODE", "Unsupported WhatsApp onboarding method.", 400);
    }
    const caps = await getCapabilities(tenant_id);
    if (!caps?.embedded_signup_enabled) {
      throw new EmbeddedSignupError(
        "FEATURE_DISABLED",
        "WhatsApp Embedded Signup is not enabled for your organization.",
        403,
      );
    }
    if (
      connection_type === WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE &&
      !caps.coexistence_enabled
    ) {
      throw new EmbeddedSignupError(
        "COEXISTENCE_NOT_ENABLED",
        "Connecting an existing WhatsApp Business App is not enabled for your organization.",
        403,
      );
    }
  };

  /** Replacing a working connection needs an explicit confirmation. */
  const assertSwitchConfirmed = (existing, confirm_switch) => {
    if (existing && !existing.is_deleted && confirm_switch !== true) {
      throw new EmbeddedSignupError(
        "CONFIRMATION_REQUIRED",
        "Please confirm that you want to replace your current WhatsApp connection.",
        409,
      );
    }
  };

  /**
   * Embedded Signup needs its provider configuration. Missing settings give ONE
   * sanitized error for users; only the setting NAMES (never values) are logged, for
   * operators. Checked before any single-use auth code is consumed.
   */
  const assertConfigured = (config) => {
    const missing = getMissingEmbeddedSignupConfig(config);
    if (missing.length) {
      logger.warn?.(`[WA-EMBEDDED] Embedded Signup is not configured; missing: ${missing.join(", ")}`);
      throw new EmbeddedSignupError(
        "EMBEDDED_SIGNUP_NOT_CONFIGURED",
        "WhatsApp Embedded Signup is not available yet. Please contact support.",
        503,
      );
    }
  };

  /**
   * Gate + parameters for launching Meta's Embedded Signup. The SAME config id is
   * returned for every mode; only the Meta Feature Type differs
   * (standard → none, coexistence → WhatsApp Business App onboarding).
   */
  const startSignup = async ({ tenant_id, connection_type, user_id = null }) => {
    await assertModeAllowed(tenant_id, connection_type);

    const config = getConfig();
    assertConfigured(config);
    const launch = getEmbeddedSignupLaunchConfig(connection_type, config);

    return {
      mode: launch.mode,
      connection_type: launch.mode, // kept for existing clients; same value as `mode`
      app_id: config.appId,
      config_id: launch.configId,
      graph_api_version: config.graphApiVersion,
      feature_type: launch.featureType, // NONE | WHATSAPP_BUSINESS_APP_ONBOARDING
      // Passed straight to FB.login({ extras }).
      extras: launch.extras,
      // Server-signed onboarding session reference: binds tenant + user + mode + expiry.
      session_token: signSession({ tenant_id, connection_type, user_id }),
    };
  };

  // ── session bookkeeping ───────────────────────────────────────────────

  /** Persist a step and mirror the non-secret fields onto the in-memory session. */
  const advance = async (ob, patch) => {
    await sessionStore.update(ob, patch);
    for (const k of ["state", "waba_id", "phone_number_id", "business_number", "meta_business_id", "migration_mode", "previous", "last_error_code"]) {
      if (k in patch) ob[k] = patch[k];
    }
  };

  /** Free the in-flight slot. Keeps secrets when a Meta side effect may still need recovery. */
  const retire = async (ob, errorCode = null) => {
    const rollback = reached(ob.state, S.REGISTRATION_PENDING);
    await advance(ob, {
      state: rollback ? S.ROLLBACK_REQUIRED : S.FAILED,
      last_error_code: errorCode,
      active_slot: null,
      wipe: !rollback,
    });
  };

  /**
   * Find or create THE in-flight session for this organization and take its
   * processing lease. At most one in-flight session exists per tenant (DB-enforced),
   * and at most one request processes it at a time (lease).
   */
  const acquire = async (tenant_id, connection_type, hints) => {
    const compatible = (o) =>
      o.connection_type === connection_type &&
      (!o.waba_id || !hints.waba_id || o.waba_id === String(hints.waba_id)) &&
      (!o.phone_number_id || !hints.phone_number_id || o.phone_number_id === String(hints.phone_number_id));

    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await sessionStore.findInFlight(tenant_id);

      if (!found) {
        try {
          return await sessionStore.create({ tenant_id, connection_type, leaseSeconds });
        } catch (err) {
          if (err?.code === "SESSION_SLOT_TAKEN") continue; // lost the race — adopt the winner's session
          throw err;
        }
      }

      const claimed = await sessionStore.claim(found.id, leaseSeconds);
      if (!claimed) {
        throw compatible(found)
          ? new EmbeddedSignupError(
              "CONCURRENT_CONNECTION_CONFLICT",
              "This WhatsApp connection is already being set up. Please wait a moment and check its status.",
              409,
            )
          : new EmbeddedSignupError(
              "DUPLICATE_ONBOARDING_SESSION",
              "Another WhatsApp setup is already in progress for your organization.",
              409,
            );
      }
      if (compatible(claimed)) return claimed;

      // A different number/mode than the abandoned attempt: retire it (keeping any
      // registration PIN if Meta was already touched) and start clean.
      await retire(claimed, "SUPERSEDED_BY_NEW_ATTEMPT");
    }
    throw new EmbeddedSignupError(
      "CONCURRENT_CONNECTION_CONFLICT",
      "This WhatsApp connection is already being set up. Please wait a moment and check its status.",
      409,
    );
  };

  /** Turn any failure into a sanitized error and persist the right recovery state. */
  const settle = async (ob, err) => {
    const e =
      err instanceof EmbeddedSignupError
        ? err
        : new EmbeddedSignupError(
            "UNEXPECTED_ERROR",
            "Something went wrong while connecting WhatsApp. Nothing was changed.",
            500,
          );
    if (!(err instanceof EmbeddedSignupError)) logger.error?.("[WA-EMBEDDED] unexpected error:", safeMessage(err));

    try {
      const recoverable = reached(ob.state, S.ASSETS_RESOLVED) && !NON_RETRYABLE.has(e.code);
      if (recoverable) {
        await advance(ob, { last_error_code: e.code });
      } else {
        await retire(ob, e.code);
      }
      e.onboarding = publicOnboarding(ob);
    } catch (bookkeepingErr) {
      // Never mask the original error with a bookkeeping failure.
      logger.error?.("[WA-EMBEDDED] could not record onboarding failure:", safeMessage(bookkeepingErr));
    }
    return e;
  };

  // ── the state machine ─────────────────────────────────────────────────

  const drive = async (ob, ctx) => {
    const isCoexistence = ob.connection_type === WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE;
    const tenant_id = ob.tenant_id;
    const secrets = await sessionStore.readSecrets(ob);
    let phone = null; // Meta's view of the phone, when fetched in this pass

    // STARTED → AUTHORIZED: spend the single-use code exactly once, store the token encrypted.
    if (!reached(ob.state, S.AUTHORIZED)) {
      try {
        secrets.token = await metaClient.exchangeCode(ctx.code);
      } catch (err) {
        logger.error?.("[WA-EMBEDDED] token exchange failed:", safeMessage(err));
        throw new EmbeddedSignupError(
          "TOKEN_EXCHANGE_FAILED",
          "Meta rejected the authorization (it may have expired). Please try again.",
          400,
        );
      }
      await advance(ob, { state: S.AUTHORIZED, token: secrets.token });
    }
    const token = secrets.token;
    if (!token) {
      throw new EmbeddedSignupError(
        "ONBOARDING_NOT_RESUMABLE",
        "This WhatsApp setup can no longer be resumed. Please start again.",
        409,
      );
    }

    // AUTHORIZED → ASSETS_RESOLVED: resolve + validate WABA and phone, decide SAME/NEW number.
    if (!reached(ob.state, S.ASSETS_RESOLVED)) {
      const { waba_id, phone_number_id, business_id, event } = ctx.hints;
      let phones;
      try {
        phones = await metaClient.listPhoneNumbers(String(waba_id), token);
      } catch (err) {
        logger.error?.("[WA-EMBEDDED] WABA lookup failed:", safeMessage(err));
        throw new EmbeddedSignupError(
          "WABA_NOT_ACCESSIBLE",
          "We could not access the WhatsApp Business Account returned by Meta. Please try again.",
          502,
        );
      }

      if (phone_number_id) {
        phone = phones.find((p) => String(p.id) === String(phone_number_id));
        if (!phone) {
          throw new EmbeddedSignupError(
            "PHONE_NOT_RETURNED",
            "The phone number returned by Meta does not belong to this WhatsApp Business Account.",
            400,
          );
        }
      } else if (phones.length === 1) {
        phone = phones[0]; // coexistence sessions only report the WABA
      } else if (phones.length === 0) {
        throw new EmbeddedSignupError(
          "PHONE_NOT_RETURNED",
          "No phone number was found on the WhatsApp Business Account.",
          400,
        );
      } else {
        throw new EmbeddedSignupError(
          "PHONE_AMBIGUOUS",
          "Multiple phone numbers were found on this WhatsApp Business Account. Please contact support.",
          400,
        );
      }

      const defaultCountryCode = cleanCountryCode(await getDefaultCountryCode(tenant_id));
      const business_number = normalizeBusinessNumber(phone.display_phone_number, { defaultCountryCode });
      if (!business_number) {
        throw new EmbeddedSignupError("PHONE_NOT_RETURNED", "Meta did not return a valid phone number.", 400);
      }

      const existing = await getExistingAccount(tenant_id);
      let mode = MIGRATION_MODES.FIRST_CONNECTION;
      let previous = null;
      if (existing) {
        if (
          !existing.is_deleted &&
          existing.whatsapp_connection_type === ob.connection_type &&
          String(existing.phone_number_id) === String(phone.id) &&
          String(existing.waba_id) === String(waba_id)
        ) {
          throw new EmbeddedSignupError(
            "SAME_ORG_ALREADY_CONNECTED",
            "This WhatsApp number is already connected to your organization.",
            409,
          );
        }
        const previous_business_number = normalizeBusinessNumber(existing.whatsapp_number, { defaultCountryCode });
        if (!previous_business_number) {
          // Cannot prove whether this is the same number → never guess about history.
          throw new EmbeddedSignupError(
            "EXISTING_NUMBER_UNVERIFIABLE",
            "We could not verify your currently connected WhatsApp number, so nothing was changed. Please contact support.",
            422,
          );
        }
        mode =
          previous_business_number === business_number
            ? MIGRATION_MODES.SAME_NUMBER
            : MIGRATION_MODES.NEW_NUMBER;
        previous = {
          row_id: existing.id,
          business_number: previous_business_number,
          phone_number_id: existing.phone_number_id,
          waba_id: existing.waba_id,
          connection_type: existing.whatsapp_connection_type ?? null,
          was_deleted: Boolean(existing.is_deleted),
          // metadata kept for support-driven recovery (never credentials)
          whatsapp_number: existing.whatsapp_number,
          app_id: existing.app_id ?? null,
          quality: existing.quality ?? null,
          tier: existing.tier ?? null,
        };
      }

      // Tenant isolation: never reassign a number / WABA owned by another org
      // (including a legacy row that stored the national-format spelling).
      const conflicts = await findMappingConflicts({
        tenant_id,
        waba_id: String(waba_id),
        phone_number_id: String(phone.id),
        whatsapp_numbers: businessNumberStorageVariants(business_number),
      });
      if (conflicts?.phone) {
        throw new EmbeddedSignupError(
          "NUMBER_ALREADY_MAPPED_TO_ANOTHER_ORG",
          "This WhatsApp number is already connected to another organization.",
          409,
        );
      }
      if (conflicts?.waba) {
        throw new EmbeddedSignupError(
          "WABA_ALREADY_MAPPED",
          "This WhatsApp Business Account is already connected to another organization.",
          409,
        );
      }

      // Coexistence: the number is already live on the Business App. Only verify it is
      // connected; otherwise Meta did not actually grant the coexistence path.
      if (isCoexistence && String(phone.status || "").toUpperCase() !== "CONNECTED") {
        throw new EmbeddedSignupError(
          "COEXISTENCE_NOT_ELIGIBLE",
          "This WhatsApp account is not currently eligible for the Business App coexistence onboarding path. No changes have been made to your existing WhatsApp setup.",
          422,
        );
      }

      await advance(ob, {
        state: S.ASSETS_RESOLVED,
        waba_id: String(waba_id),
        phone_number_id: String(phone.id),
        business_number,
        meta_business_id: business_id ? String(business_id) : null,
        migration_mode: mode,
        previous,
      });
    }

    // ── Registration: STANDARD ONLY ─────────────────────────────────────
    // Coexistence must NEVER reach this branch: /register would take the number off
    // the WhatsApp Business App. Its registration states are simply skipped.
    if (!isCoexistence && !reached(ob.state, S.REGISTERED_META)) {
      if (!phone) {
        // Resuming: ask Meta for the phone's CURRENT state (idempotency proof).
        let phones;
        try {
          phones = await metaClient.listPhoneNumbers(ob.waba_id, token);
        } catch (err) {
          logger.error?.("[WA-EMBEDDED] WABA lookup failed:", safeMessage(err));
          throw new EmbeddedSignupError(
            "WABA_NOT_ACCESSIBLE",
            "We could not access the WhatsApp Business Account returned by Meta. Please try again.",
            502,
          );
        }
        phone = phones.find((p) => String(p.id) === String(ob.phone_number_id));
        if (!phone) {
          throw new EmbeddedSignupError(
            "PHONE_NOT_RETURNED",
            "The phone number is no longer on this WhatsApp Business Account.",
            400,
          );
        }
      }

      const alreadyCloud =
        String(phone.status || "").toUpperCase() === "CONNECTED" &&
        String(phone.platform_type || "").toUpperCase() === "CLOUD_API";

      if (!alreadyCloud) {
        // The PIN is persisted (encrypted) BEFORE /register is called, and reused on
        // every retry — it can never be lost between "Meta registered it" and "we saved it".
        let pin = secrets.pin;
        if (!pin) {
          pin = generatePin();
          await advance(ob, { state: S.REGISTRATION_PENDING, pin });
          secrets.pin = pin;
        } else if (ob.state !== S.REGISTRATION_PENDING) {
          await advance(ob, { state: S.REGISTRATION_PENDING });
        }
        try {
          await metaClient.registerPhone(ob.phone_number_id, token, pin);
        } catch (err) {
          logger.error?.("[WA-EMBEDDED] phone registration failed:", safeMessage(err));
          throw new EmbeddedSignupError(
            "REGISTRATION_FAILED",
            "Meta could not register the phone number for the Cloud API. You can safely retry.",
            502,
          );
        }
      }
      await advance(ob, { state: S.REGISTERED_META });
    }

    // → SUBSCRIBED (subscribed_apps is idempotent on Meta's side)
    if (!reached(ob.state, S.SUBSCRIBED)) {
      await advance(ob, { state: S.SUBSCRIBE_PENDING });
      try {
        await metaClient.subscribeApp(ob.waba_id, token);
      } catch (err) {
        logger.error?.("[WA-EMBEDDED] WABA subscription failed:", safeMessage(err));
        throw new EmbeddedSignupError(
          "SUBSCRIPTION_FAILED",
          "We could not subscribe to WhatsApp events for this account. Your current connection is unchanged; you can safely retry.",
          502,
        );
      }
      await advance(ob, { state: S.SUBSCRIBED });
    }

    // → VALIDATING → ACTIVE: the ONE atomic switch of the connection.
    if (ob.state !== S.VALIDATING) await advance(ob, { state: S.VALIDATING });

    // Re-check ownership right before switching (guards a race since ASSETS_RESOLVED).
    const conflicts = await findMappingConflicts({
      tenant_id,
      waba_id: ob.waba_id,
      phone_number_id: ob.phone_number_id,
      whatsapp_numbers: businessNumberStorageVariants(ob.business_number),
    });
    if (conflicts?.phone) {
      throw new EmbeddedSignupError(
        "NUMBER_ALREADY_MAPPED_TO_ANOTHER_ORG",
        "This WhatsApp number is already connected to another organization.",
        409,
      );
    }
    if (conflicts?.waba) {
      throw new EmbeddedSignupError(
        "WABA_ALREADY_MAPPED",
        "This WhatsApp Business Account is already connected to another organization.",
        409,
      );
    }

    const config = getConfig();
    const saved = await persistConnection({
      tenant_id,
      onboarding: ob,
      connection_type: ob.connection_type,
      access_token: token,
      register_pin: secrets.pin ?? null,
      waba_id: ob.waba_id,
      phone_number_id: ob.phone_number_id,
      whatsapp_number: digitsOnly(ob.business_number),
      business_number: ob.business_number,
      mode: ob.migration_mode,
      previous: ob.previous,
      meta_business_id: ob.meta_business_id,
      // the single configuration used for every mode (the mode itself is connection_type)
      meta_embedded_config_id: config.configId,
      app_id: config.appId,
    });

    // Finished: free the slot and wipe the (now redundant) encrypted token + PIN.
    await advance(ob, { state: S.ACTIVE, active_slot: null, wipe: true, last_error_code: null });

    return {
      ...toPublicConnection(saved),
      ...publicMigration({
        mode: ob.migration_mode,
        business_number: ob.business_number,
        previous_business_number: ob.previous?.business_number,
      }),
      onboarding: publicOnboarding(ob),
    };
  };

  const runLeased = async (ob, ctx) => {
    try {
      return await drive(ob, ctx);
    } catch (err) {
      throw await settle(ob, err);
    } finally {
      try {
        await sessionStore.release(ob.id);
      } catch (e) {
        logger.error?.("[WA-EMBEDDED] could not release onboarding lease:", safeMessage(e));
      }
    }
  };

  /** Backend completion. Persists the connection ONLY after every Meta step succeeded. */
  const completeSignup = async ({
    tenant_id,
    session_token,
    code,
    waba_id,
    phone_number_id,
    business_id,
    event,
    confirm_switch,
    user_id = null,
    requested_mode = null,
  }) => {
    // 1. The session must have been started by THIS tenant (and user) for a permitted mode.
    const session = verifySession(session_token);
    if (
      !session ||
      session.tenant_id !== tenant_id ||
      (session.user_id && user_id && session.user_id !== user_id)
    ) {
      throw new EmbeddedSignupError(
        "INVALID_SESSION",
        "Your WhatsApp setup session is invalid or has expired. Please start again.",
        400,
      );
    }
    // The mode comes ONLY from the server-signed session. A mode the client claims
    // is just a consistency check — a mismatch is rejected, never followed.
    const connection_type = session.connection_type;
    if (requested_mode && requested_mode !== connection_type) {
      throw new EmbeddedSignupError(
        "MODE_MISMATCH",
        "The WhatsApp setup method does not match the one you started. Please start again.",
        400,
      );
    }

    // 2. Re-check server-side (flags may have changed since start), configuration and
    //    confirmation — all BEFORE the single-use code is consumed.
    await assertModeAllowed(tenant_id, connection_type);
    assertConfigured(getConfig());
    assertSwitchConfirmed(await getExistingAccount(tenant_id), confirm_switch);

    if (!code || typeof code !== "string") {
      throw new EmbeddedSignupError(
        "AUTH_CODE_MISSING",
        "Meta did not return an authorization code. Please try again.",
        400,
      );
    }
    if (!waba_id || !ID_PATTERN.test(String(waba_id))) {
      throw new EmbeddedSignupError(
        "WABA_NOT_RETURNED",
        "Meta did not return a WhatsApp Business Account. Please try again.",
        400,
      );
    }
    if (phone_number_id && !ID_PATTERN.test(String(phone_number_id))) {
      throw new EmbeddedSignupError("PHONE_NOT_RETURNED", "Invalid phone number reference.", 400);
    }

    const isCoexistence = connection_type === WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE;
    // Meta reports which path the customer actually took; a mismatch with what
    // was requested is rejected rather than silently converted.
    if (isCoexistence && event && event !== SESSION_EVENTS.COEXISTENCE) {
      throw new EmbeddedSignupError(
        "COEXISTENCE_NOT_ELIGIBLE",
        "This WhatsApp account is not currently eligible for the Business App coexistence onboarding path. No changes have been made to your existing WhatsApp setup.",
        422,
      );
    }
    if (!isCoexistence && event === SESSION_EVENTS.COEXISTENCE) {
      throw new EmbeddedSignupError(
        "INVALID_MODE",
        "The Business App onboarding path was used for a standard setup. Please choose 'Connect Existing WhatsApp Business App' instead.",
        400,
      );
    }

    // 3. One in-flight session per organization; resume it if it exists.
    const ob = await acquire(tenant_id, connection_type, { waba_id, phone_number_id });
    return runLeased(ob, { code, hints: { waba_id, phone_number_id, business_id, event } });
  };

  /**
   * Resume the organization's in-flight onboarding from its stored state — no new
   * Meta popup, no new auth code. Used after a failure that happened AFTER a Meta
   * side effect (register / subscribe) or during the final switch.
   */
  const resumeSignup = async ({ tenant_id, confirm_switch }) => {
    const found = await sessionStore.findInFlight(tenant_id);
    if (!found) {
      throw new EmbeddedSignupError("NO_ONBOARDING_IN_PROGRESS", "There is no WhatsApp setup to resume.", 404);
    }
    await assertModeAllowed(tenant_id, found.connection_type);
    assertConfigured(getConfig());
    assertSwitchConfirmed(await getExistingAccount(tenant_id), confirm_switch);
    if (!isResumable(found)) {
      throw new EmbeddedSignupError(
        "ONBOARDING_NOT_RESUMABLE",
        "This WhatsApp setup can no longer be resumed. Please start again.",
        409,
      );
    }
    const ob = await sessionStore.claim(found.id, leaseSeconds);
    if (!ob) {
      throw new EmbeddedSignupError(
        "CONCURRENT_CONNECTION_CONFLICT",
        "This WhatsApp connection is already being set up. Please wait a moment and check its status.",
        409,
      );
    }
    return runLeased(ob, { code: null, hints: {} });
  };

  return { startSignup, completeSignup, resumeSignup };
};
