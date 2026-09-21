import axios from "axios";
import { subscribeToWebhookFieldsService } from "./whatsappAccount.service.js";
import { getEmbeddedSignupConfig } from "../../config/metaEmbeddedSignup.config.js";
import { redactSecrets } from "../../utils/redactSecrets.js";

const GRAPH_BASE = "https://graph.facebook.com";
const TIMEOUT_MS = 15000;

/**
 * Wrap a Graph failure into a small, safe error. Never carries the axios
 * config / request params (which contain the auth code and app secret).
 */
export class MetaGraphError extends Error {
  constructor(err) {
    const meta = err?.response?.data?.error;
    super(redactSecrets(meta?.message || err?.message || "Meta Graph API error"));
    this.name = "MetaGraphError";
    this.metaCode = meta?.code ?? null;
    this.metaSubcode = meta?.error_subcode ?? null;
    this.httpStatus = err?.response?.status ?? null;
    this.isNetworkError = !err?.response;
  }
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * Graph calls needed to complete Embedded Signup. The webhook subscription
 * deliberately reuses the existing subscribeToWebhookFieldsService so the
 * subscribed_apps call lives in exactly one place.
 */
export const createMetaEmbeddedSignupClient = (config = getEmbeddedSignupConfig()) => {
  const base = `${GRAPH_BASE}/${config.graphApiVersion}`;

  return {
    async exchangeCode(code) {
      try {
        const res = await axios.get(`${base}/oauth/access_token`, {
          params: {
            client_id: config.appId,
            client_secret: config.appSecret,
            code,
          },
          timeout: TIMEOUT_MS,
        });
        const token = res?.data?.access_token;
        if (!token) throw new Error("Meta did not return an access token");
        return token;
      } catch (err) {
        throw err instanceof MetaGraphError ? err : new MetaGraphError(err);
      }
    },

    async listPhoneNumbers(wabaId, token) {
      try {
        const res = await axios.get(`${base}/${encodeURIComponent(wabaId)}/phone_numbers`, {
          params: { fields: "id,display_phone_number,verified_name,status,platform_type" },
          headers: authHeaders(token),
          timeout: TIMEOUT_MS,
        });
        return Array.isArray(res?.data?.data) ? res.data.data : [];
      } catch (err) {
        throw new MetaGraphError(err);
      }
    },

    async registerPhone(phoneNumberId, token, pin) {
      try {
        const res = await axios.post(
          `${base}/${encodeURIComponent(phoneNumberId)}/register`,
          { messaging_product: "whatsapp", pin },
          { headers: authHeaders(token), timeout: TIMEOUT_MS },
        );
        if (!res?.data?.success) throw new Error("Phone number registration was not confirmed by Meta");
        return true;
      } catch (err) {
        throw err instanceof MetaGraphError ? err : new MetaGraphError(err);
      }
    },

    async subscribeApp(wabaId, token) {
      const result = await subscribeToWebhookFieldsService(wabaId, token);
      if (!result?.success) {
        throw new MetaGraphError({ message: result?.error || result?.message });
      }
      return true;
    },
  };
};
