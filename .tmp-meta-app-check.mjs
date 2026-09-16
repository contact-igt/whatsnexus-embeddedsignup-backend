import db from "./src/database/index.js";
import {
  getWhatsappAccountByTenantService,
  validateMetaSubscriptionService,
} from "./src/models/WhatsappAccountModel/whatsappAccount.service.js";

try {
  const tenantId = "TT014";
  const account = await getWhatsappAccountByTenantService(tenantId);
  const subscription = await validateMetaSubscriptionService(account.waba_id, account.access_token);
  console.log({
    tenant_id: tenantId,
    stored_app_id: account.app_id || null,
    subscribed: subscription.subscribed,
    subscribed_app_id: subscription.app_id || null,
    subscribed_app_name: subscription.app_name || null,
    app_ids_match: Boolean(account.app_id && subscription.app_id && String(account.app_id) === String(subscription.app_id)),
  });
} finally {
  await db.sequelize.close();
}
