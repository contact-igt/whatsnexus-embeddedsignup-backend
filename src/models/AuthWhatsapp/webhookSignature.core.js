import crypto from "crypto";

/** Meta signs webhook POST bodies with the app secret. */
export const verifyMetaWebhookSignature = ({ rawBody, signature, appSecret }) => {
  const secret = appSecret?.trim?.();
  if (!secret || !rawBody || typeof signature !== "string") return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
};

export const requiresMetaWebhookSignature = ({ nodeEnv, appSecret }) =>
  nodeEnv === "production" || Boolean(appSecret?.trim?.());
