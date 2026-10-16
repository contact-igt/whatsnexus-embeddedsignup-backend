export const verifyWebhookToken = async ({
  mode,
  token,
  tenantId,
  commonToken,
  findTenant,
}) => {
  if (mode !== "subscribe" || !token) return { valid: false, tenantId: null };

  if (!tenantId) {
    return { valid: Boolean(commonToken && token === commonToken), tenantId: null };
  }

  const tenant = await findTenant(tenantId);
  return {
    valid: Boolean(tenant?.verify_token && token === tenant.verify_token),
    tenantId: tenant?.verify_token && token === tenant.verify_token ? tenantId : null,
  };
};
