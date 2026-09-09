import { resolveModel } from "./modelRuntime.js";
export const getTenantAiModel = async (tenantId, purpose = "output") => (await resolveModel(tenantId, purpose)).model;
