import { EMBEDDED_SIGNUP_MODES } from "../models/WhatsappAccountModel/whatsappConnectionTypes.js";

/**
 * Meta Embedded Signup configuration — ONE Meta app, ONE Login Configuration.
 *
 *   WHATSNEXUS_META_APP_ID                  provider Meta app id
 *   WHATSNEXUS_META_APP_SECRET              backend-only; never sent to the browser
 *   WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID    the single Embedded Signup configuration
 *   WHATSNEXUS_META_GRAPH_API_VERSION       optional; falls back to the project-wide
 *                                           META_API_VERSION, then v25.0
 *
 * Standard vs coexistence is NOT a different configuration: the same config id is
 * launched with a different Meta *Feature Type* (see MODE_FEATURE_TYPE below).
 *
 * Deliberately NOT read: the generic META_APP_ID / META_APP_SECRET. Those names are
 * shared with legacy code (media gallery, templates, campaigns fall back to
 * META_APP_ID when a tenant has no app_id), so consuming them here could silently
 * pair Embedded Signup with the wrong app.
 *
 * Deprecated (read only for a smooth transition, with a safe warning — names only,
 * never values): META_EMBEDDED_SIGNUP_CONFIG_ID. META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID
 * is ignored: a second configuration is no longer needed.
 *
 * Customer WABA ids / Phone Number ids are tenant data and live in the database,
 * never in the environment.
 */

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What we ask Meta for. Never persisted as the WhatsNexus connection type. */
export const META_FEATURE_TYPES = Object.freeze({
  NONE: "NONE",
  WHATSAPP_BUSINESS_APP_ONBOARDING: "WHATSAPP_BUSINESS_APP_ONBOARDING",
});

/** The exact `extras.featureType` string Meta's launch API expects. NONE → key omitted. */
const META_RUNTIME_FEATURE_TYPE = Object.freeze({
  [META_FEATURE_TYPES.WHATSAPP_BUSINESS_APP_ONBOARDING]: "whatsapp_business_app_onboarding",
});

/** WhatsNexus onboarding mode → Meta Feature Type. The single source of the mapping. */
export const MODE_FEATURE_TYPE = Object.freeze({
  [EMBEDDED_SIGNUP_MODES.STANDARD]: META_FEATURE_TYPES.NONE,
  [EMBEDDED_SIGNUP_MODES.COEXISTENCE]: META_FEATURE_TYPES.WHATSAPP_BUSINESS_APP_ONBOARDING,
});

const warned = new Set();
const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[EMBEDDED-SIGNUP-CONFIG] ${message}`);
};

export const getEmbeddedSignupConfig = (env = process.env) => {
  let configId = clean(env.WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID);
  if (!configId && clean(env.META_EMBEDDED_SIGNUP_CONFIG_ID)) {
    configId = clean(env.META_EMBEDDED_SIGNUP_CONFIG_ID);
    warnOnce(
      "old-config-id",
      "META_EMBEDDED_SIGNUP_CONFIG_ID is deprecated; rename it to WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID.",
    );
  }
  if (clean(env.META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID)) {
    warnOnce(
      "old-coexistence-config-id",
      "META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID is no longer used (one configuration serves both modes) and can be removed.",
    );
  }

  return {
    appId: clean(env.WHATSNEXUS_META_APP_ID),
    appSecret: clean(env.WHATSNEXUS_META_APP_SECRET),
    configId,
    graphApiVersion:
      clean(env.WHATSNEXUS_META_GRAPH_API_VERSION) || clean(env.META_API_VERSION) || "v25.0",
  };
};

/** Names (never values) of the required settings that are missing. */
export const getMissingEmbeddedSignupConfig = (config) => {
  const missing = [];
  if (!config?.appId) missing.push("WHATSNEXUS_META_APP_ID");
  if (!config?.appSecret) missing.push("WHATSNEXUS_META_APP_SECRET");
  if (!config?.configId) missing.push("WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID");
  return missing;
};

export const isEmbeddedSignupConfigured = (config) => getMissingEmbeddedSignupConfig(config).length === 0;

/**
 * Launch parameters for a mode: the SAME config id for every mode, plus the Meta
 * Feature Type for that mode and the `extras` object passed to FB.login.
 *
 * NONE (standard) sends no featureType key — Meta's default. Coexistence sends
 * `whatsapp_business_app_onboarding`, the value Meta documents for the launch
 * `extras`. Contains no secret: safe to return to the browser.
 */
export const getEmbeddedSignupLaunchConfig = (mode, config) => {
  const featureType = MODE_FEATURE_TYPE[mode];
  if (!featureType) throw new Error("Unsupported Embedded Signup mode");
  const runtime = META_RUNTIME_FEATURE_TYPE[featureType];
  return {
    mode,
    configId: config.configId,
    featureType,
    extras: {
      setup: {},
      ...(runtime ? { featureType: runtime } : {}),
      sessionInfoVersion: "3",
    },
  };
};
