import express from "express";
import { authenticate, authorize } from "../../middlewares/auth/authMiddlewares.js";
import { listCatalog, syncCatalog, reviewCatalog, testCatalog, activateCatalog } from "./catalog.service.js";

const router = express.Router();
const read = [authenticate, authorize({ user_type: "management", roles: ["super_admin", "platform_admin"] })];
const write = [authenticate, authorize({ user_type: "management", roles: ["super_admin"] })];
const handler = fn => async (req, res) => {
  try {
    if (req.params.id && !/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid catalog ID." });
    const actor = req.user.management_id || req.user.unique_id || req.user.id;
    if (!actor) return res.status(403).json({ success: false, message: "Administrator identity required." });
    const data = await fn(req, actor);
    res.json({ success: true, data: data ?? null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Catalog operation failed.", code: error.code || "AI_CATALOG_ERROR" });
  }
};
router.get("/", ...read, handler(() => listCatalog()));
router.post("/sync", ...write, handler(() => syncCatalog()));
router.put("/:id", ...write, handler((req, actor) => reviewCatalog(req.params.id, req.body, actor)));
router.post("/:id/test", ...write, handler((req, actor) => testCatalog(req.params.id, req.body, actor)));
router.post("/:id/activate", ...write, handler((req, actor) => activateCatalog(req.params.id, true, actor, {
  overrideTenantScopedTest: req.body?.overrideTenantScopedTest === true,
  overrideReason: req.body?.overrideReason,
  isSuperAdmin: req.user?.role === "super_admin",
})));
router.post("/:id/deactivate", ...write, handler((req, actor) => activateCatalog(req.params.id, false, actor)));
export default router;
