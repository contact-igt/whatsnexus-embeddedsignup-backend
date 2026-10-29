import crypto from "crypto";
import {
  requiresMetaWebhookSignature,
  verifyMetaWebhookSignature,
} from "../src/models/AuthWhatsapp/webhookSignature.core.js";

const secret = "test-secret";
const body = Buffer.from('{"object":"whatsapp_business_account"}');
const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

test("accepts a valid Meta sha256 webhook signature", () => {
  expect(verifyMetaWebhookSignature({ rawBody: body, signature, appSecret: secret })).toBe(true);
});

test("rejects missing, altered and malformed signatures", () => {
  expect(verifyMetaWebhookSignature({ rawBody: body, signature: undefined, appSecret: secret })).toBe(false);
  expect(verifyMetaWebhookSignature({ rawBody: Buffer.from("changed"), signature, appSecret: secret })).toBe(false);
  expect(verifyMetaWebhookSignature({ rawBody: body, signature: "sha256=bad", appSecret: secret })).toBe(false);
});

test("requires a signature in production even when the app secret is missing", () => {
  expect(requiresMetaWebhookSignature({ nodeEnv: "production", appSecret: undefined })).toBe(true);
  expect(requiresMetaWebhookSignature({ nodeEnv: "development", appSecret: undefined })).toBe(false);
  expect(requiresMetaWebhookSignature({ nodeEnv: "development", appSecret: secret })).toBe(true);
});
