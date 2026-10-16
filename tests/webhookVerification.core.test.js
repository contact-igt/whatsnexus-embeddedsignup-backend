import { verifyWebhookToken } from "../src/models/AuthWhatsapp/webhookVerification.core.js";

test("accepts the common WhatsNexus token when the callback has no tenant id", async () => {
  await expect(
    verifyWebhookToken({
      mode: "subscribe",
      token: "common-token",
      tenantId: undefined,
      commonToken: "common-token",
      findTenant: async () => null,
    }),
  ).resolves.toEqual({ valid: true, tenantId: null });
});

test("keeps tenant-specific callbacks bound to that tenant token", async () => {
  await expect(
    verifyWebhookToken({
      mode: "subscribe",
      token: "tenant-token",
      tenantId: "TT004",
      commonToken: "common-token",
      findTenant: async () => ({ verify_token: "tenant-token" }),
    }),
  ).resolves.toEqual({ valid: true, tenantId: "TT004" });
});

test("rejects a common token on a tenant-specific callback", async () => {
  await expect(
    verifyWebhookToken({
      mode: "subscribe",
      token: "common-token",
      tenantId: "TT004",
      commonToken: "common-token",
      findTenant: async () => ({ verify_token: "tenant-token" }),
    }),
  ).resolves.toEqual({ valid: false, tenantId: null });
});
