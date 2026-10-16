import express from "express";
import {
  manualConnectWhatsappController,
  whatsappOAuthCallbackController,
  testWhatsappAccountController,
  activateWhatsappAccountController,
  updateAccessTokenController,
  updateWhatsappAccountController,
  getWhatsappAccountController,
  getTierLimitController,
  softDeleteWhatsappAccountController,
  permanentDeleteWhatsappAccountController,
  subscribeToWebhooksController,
} from "./whatsappAccount.controller.js";

import {
  getOnboardingConfigController,
  startEmbeddedSignupController,
  completeEmbeddedSignupController,
  resumeEmbeddedSignupController,
} from "./whatsappEmbeddedSignup.controller.js";

import {
  authenticate,
  authorize,
} from "../../middlewares/auth/authMiddlewares.js";

const router = express.Router();

router.get("/whatsapp/oauth/callback", whatsappOAuthCallbackController);

router.post(
  "/whatsapp-account/manual",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  manualConnectWhatsappController,
);

router.get(
  "/whatsapp-account",
  authenticate,
  authorize({
    user_type: "tenant",
    roles: ["tenant_admin" , "staff"],
  }),
  getWhatsappAccountController,
);

router.get(
  "/whatsapp-account/tier-limit",
  authenticate,
  authorize({
    user_type: "tenant",
    roles: ["tenant_admin" , "staff"],
  }),
  getTierLimitController,
);

router.post(
  "/whatsapp-account/test",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  testWhatsappAccountController,
);

router.put(
  "/whatsapp-account",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  updateWhatsappAccountController,
);

router.put(
  "/whatsapp-account/token",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  updateAccessTokenController,
);

router.post(
  "/whatsapp-account/activate",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  activateWhatsappAccountController,
);

router.delete(
  "/whatsapp-account",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  softDeleteWhatsappAccountController,
);

router.delete(
  "/whatsapp-account/permanent",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  permanentDeleteWhatsappAccountController,
);

// Subscribe app to Meta webhook fields (messages, message_template_status_update)
router.post(
  "/whatsapp-account/subscribe-webhooks",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  subscribeToWebhooksController,
);

// ── Meta Embedded Signup (additive; every route re-checks org flags server-side) ──
router.get(
  "/whatsapp-account/onboarding-config",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin", "staff"] }),
  getOnboardingConfigController,
);

router.post(
  "/whatsapp-account/embedded-signup/start",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  startEmbeddedSignupController,
);

router.post(
  "/whatsapp-account/embedded-signup/complete",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  completeEmbeddedSignupController,
);

router.post(
  "/whatsapp-account/embedded-signup/resume",
  authenticate,
  authorize({ user_type: "tenant", roles: ["tenant_admin"] }),
  resumeEmbeddedSignupController,
);

export default router;
