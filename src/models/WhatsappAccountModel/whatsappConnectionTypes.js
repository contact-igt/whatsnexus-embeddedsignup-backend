// WhatsApp onboarding / connection types. Kept dependency-free so it can be
// imported from anywhere (services, webhook handlers, tests).

export const WHATSAPP_CONNECTION_TYPES = Object.freeze({
  LEGACY_MANUAL: "LEGACY_MANUAL",
  EMBEDDED_STANDARD: "EMBEDDED_STANDARD",
  EMBEDDED_COEXISTENCE: "EMBEDDED_COEXISTENCE",
});

export const EMBEDDED_CONNECTION_TYPES = Object.freeze([
  WHATSAPP_CONNECTION_TYPES.EMBEDDED_STANDARD,
  WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE,
]);

const KNOWN = new Set(Object.values(WHATSAPP_CONNECTION_TYPES));

/**
 * Existing production rows have a NULL connection type. They are, by
 * definition, the manual Cloud API connections — never rewrite them, just read
 * NULL / unknown as LEGACY_MANUAL.
 */
export const resolveConnectionType = (value) =>
  KNOWN.has(value) ? value : WHATSAPP_CONNECTION_TYPES.LEGACY_MANUAL;

export const isLegacyManualConnection = (value) =>
  resolveConnectionType(value) === WHATSAPP_CONNECTION_TYPES.LEGACY_MANUAL;

/**
 * Effective capabilities for an organization. Coexistence is only ever
 * effective when Embedded Signup itself is enabled.
 */
export const resolveCapabilities = (tenantRow) => {
  const embedded = Boolean(Number(tenantRow?.embedded_signup_enabled ?? 0));
  const coexistence = embedded && Boolean(Number(tenantRow?.coexistence_enabled ?? 0));
  return {
    embedded_signup_enabled: embedded,
    coexistence_enabled: coexistence,
  };
};

/**
 * Embedded Signup onboarding modes (a typed subset of the connection types).
 * The mode is decided by the server-side onboarding session, never by UI labels or
 * by anything a browser message claims.
 */
export const EMBEDDED_SIGNUP_MODES = Object.freeze({
  STANDARD: WHATSAPP_CONNECTION_TYPES.EMBEDDED_STANDARD,
  COEXISTENCE: WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE,
});
