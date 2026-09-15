/**
 * Classify a compatibility-test failure so an admin action (or transient blip)
 * can never silently disable a model that is currently serving tenants.
 *
 *   transient      - retry later; the model's capability is not in doubt
 *   definitive     - the model genuinely fails a required capability
 *   configuration  - the test can't run (missing credential / profile / pricing / scope)
 */
export const FAILURE_CLASSES = ["transient", "definitive", "configuration"];

const DEFINITIVE_CODES = new Set([
  "AI_MODEL_MAPPING",          // returned model not in the approved mapping
  "AI_OUTPUT_INVALID",         // required structured/JSON output was invalid
  "AI_OUTPUT_INCOMPLETE",      // refusal / incomplete / empty on a capped check
  "AI_MODEL_MODALITY",         // image-input test unsupported
  "AI_CAPABILITY_MISMATCH",
  "AI_REQUEST_TOO_LARGE",
]);

const CONFIGURATION_CODES = new Set([
  "AI_MODEL_ACCESS",           // credential cannot reach the model
  "AI_MODEL_CONFIGURATION",    // unapproved / invalid profile
  "AI_PRICING_MISSING",
  "AI_TARIFF_UNSUPPORTED",
  "AI_MODEL_UNAVAILABLE",
  "AI_MODEL_PURPOSE",
]);

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * @param {Error} error - a thrown error (ModelConfigurationError, an OpenAI SDK
 *   error, or a bare Error). Never a string.
 * @param {string} [failingCheck] - which capability check was running
 * @returns {{ failureClass: "transient"|"definitive"|"configuration", failingCheck: string|null }}
 */
export function classifyTestFailure(error, failingCheck = null) {
  const code = error?.code || null;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();

  // Provider / network transients first — capability is not in question.
  if (
    TRANSIENT_STATUS.has(status) ||
    name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "InternalServerError" ||
    code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN" ||
    /timeout|timed out|socket hang up|network|rate limit|temporarily/.test(message)
  ) {
    return { failureClass: "transient", failingCheck };
  }

  if (code && DEFINITIVE_CODES.has(code)) return { failureClass: "definitive", failingCheck };
  if (code && CONFIGURATION_CODES.has(code)) return { failureClass: "configuration", failingCheck };

  // A 401/403 with no other signal is an auth/config problem, not a capability one.
  if (status === 401 || status === 403) return { failureClass: "configuration", failingCheck };
  // A 400 from the provider on a capped, well-formed test request is a real
  // capability/parameter mismatch.
  if (status === 400) return { failureClass: "definitive", failingCheck };

  // Unknown → treat as transient so we never disable a live model on a mystery error.
  return { failureClass: "transient", failingCheck };
}
