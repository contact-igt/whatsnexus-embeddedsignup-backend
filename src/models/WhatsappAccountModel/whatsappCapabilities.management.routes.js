import express from "express";
import {
  authenticate,
  authorize,
} from "../../middlewares/auth/authMiddlewares.js";
import {
  getTenantWhatsappCapabilitiesService,
  updateTenantWhatsappCapabilitiesService,
} from "./whatsappCapabilities.service.js";

const router = express.Router();

const handleError = (res, err) =>
  res.status(err?.statusCode || 500).json({ message: err.message });

router.get(
  "/tenant/:tenantId/whatsapp-capabilities",
  authenticate,
  authorize({ user_type: "management", roles: ["platform_admin", "super_admin"] }),
  async (req, res) => {
    try {
      const data = await getTenantWhatsappCapabilitiesService(req.params.tenantId);
      if (!data) return res.status(404).json({ message: "Tenant details not found" });
      return res.status(200).json({ message: "success", data });
    } catch (err) {
      return handleError(res, err);
    }
  },
);

// Only Super Admin may change WhatsApp onboarding capabilities.
export const WHATSAPP_CAPABILITY_WRITE_ROLES = ["super_admin"];

router.patch(
  "/tenant/:tenantId/whatsapp-capabilities",
  authenticate,
  authorize({ user_type: "management", roles: WHATSAPP_CAPABILITY_WRITE_ROLES }),
  async (req, res) => {
    try {
      const { embedded_signup_enabled, coexistence_enabled } = req.body || {};
      const data = await updateTenantWhatsappCapabilitiesService(
        req.params.tenantId,
        { embedded_signup_enabled, coexistence_enabled },
        {
          unique_id: req.user?.unique_id,
          id: req.user?.id,
          ip: req.ip,
          user_agent: req.headers["user-agent"],
        },
      );
      return res.status(200).json({
        message: "WhatsApp capabilities updated successfully",
        data,
      });
    } catch (err) {
      return handleError(res, err);
    }
  },
);

export default router;
