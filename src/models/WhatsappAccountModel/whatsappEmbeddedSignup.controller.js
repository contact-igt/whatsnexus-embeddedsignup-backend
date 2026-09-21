import {
  embeddedSignupService,
  getOnboardingConfigService,
} from "./whatsappEmbeddedSignup.service.js";
import { EmbeddedSignupError } from "./whatsappEmbeddedSignup.core.js";
import { syncWabaMetaInfoService } from "./whatsappAccount.service.js";

const sendError = (res, err) => {
  if (err instanceof EmbeddedSignupError) {
    return res.status(err.status).send({ success: false, code: err.code, message: err.message });
  }
  // Unexpected: log the message only (no config / params), return a generic error.
  console.error("[WA-EMBEDDED] unexpected error:", err?.message);
  return res.status(500).send({
    success: false,
    code: "UNEXPECTED_ERROR",
    message: "Something went wrong while connecting WhatsApp. Nothing was changed.",
  });
};

/** GET — which onboarding options the Settings page may show. No secrets. */
export const getOnboardingConfigController = async (req, res) => {
  try {
    const data = await getOnboardingConfigService(req.user.tenant_id);
    return res.status(200).send({ data });
  } catch (err) {
    return sendError(res, err);
  }
};

/** POST — server-side gate + launch parameters for Meta Embedded Signup. */
export const startEmbeddedSignupController = async (req, res) => {
  try {
    const data = await embeddedSignupService.startSignup({
      tenant_id: req.user.tenant_id,
      connection_type: req.body?.connection_type,
      user_id: req.user.unique_id ?? null,
    });
    return res.status(200).send({ data });
  } catch (err) {
    return sendError(res, err);
  }
};

/** POST — backend completion: code exchange, validation, subscription, persist. */
export const completeEmbeddedSignupController = async (req, res) => {
  try {
    const { session_token, code, waba_id, phone_number_id, business_id, event, confirm_switch, connection_type } =
      req.body || {};
    const tenant_id = req.user.tenant_id;

    const data = await embeddedSignupService.completeSignup({
      tenant_id,
      session_token,
      user_id: req.user.unique_id ?? null,
      // Consistency check only: the mode itself comes from the server-signed session.
      requested_mode: typeof connection_type === "string" ? connection_type : null,
      code,
      waba_id,
      phone_number_id,
      business_id,
      event,
      confirm_switch: confirm_switch === true,
    });

    // Same non-blocking quality/tier sync the manual flow runs on activation.
    syncWabaMetaInfoService(tenant_id).catch((e) =>
      console.error("[WABA Sync] Post-embedded-signup sync failed:", e.message),
    );

    return res.status(200).send({
      success: true,
      message: "WhatsApp connected successfully.",
      data,
    });
  } catch (err) {
    return sendError(res, err);
  }
};

/** POST â€” retries the server-persisted step after a recoverable Meta/DB failure. */
export const resumeEmbeddedSignupController = async (req, res) => {
  try {
    const data = await embeddedSignupService.resumeSignup({
      tenant_id: req.user.tenant_id,
      confirm_switch: req.body?.confirm_switch === true,
    });
    return res.status(200).send({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
};
