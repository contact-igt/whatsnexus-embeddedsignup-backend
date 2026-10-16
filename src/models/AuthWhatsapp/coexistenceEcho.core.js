import {
  WHATSAPP_CONNECTION_TYPES,
  resolveConnectionType,
} from "../WhatsappAccountModel/whatsappConnectionTypes.js";

/**
 * Business-App coexistence: `smb_message_echoes` webhook.
 *
 * Meta echoes messages the business sent from the WhatsApp Business App so the
 * Cloud API side (WhatsNexus) can show one unified thread. Free of DB / socket
 * imports — all effects are injected — so idempotency and tenant rules are
 * unit-testable. Legacy manual accounts are never touched by this path.
 */

export const ECHO_FIELD = "smb_message_echoes";
export const BUSINESS_APP_SENDER_LABEL = "WhatsApp Business App";

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

/**
 * Normalize one Meta echo into the fields the internal message model needs.
 * Returns null for events that are not a message (e.g. reactions) or that have
 * no usable identity — never invents a message.
 */
export const normalizeEcho = (echo) => {
  const id = echo?.id;
  const to = echo?.to;
  const type = String(echo?.type || "").toLowerCase();
  if (!id || !to || !type || type === "reaction") return null;

  const base = {
    wamid: String(id),
    to: String(to),
    text: "",
    message_type: "text",
    media_id: null,
    media_mime_type: null,
    media_filename: null,
  };

  if (type === "text") return { ...base, text: echo.text?.body || "" };

  if (MEDIA_TYPES.has(type)) {
    const m = echo[type] || {};
    return {
      ...base,
      message_type: type,
      text: m.caption || m.filename || "",
      media_id: m.id || null,
      media_mime_type: m.mime_type || null,
      media_filename: m.filename || null,
    };
  }

  if (type === "location") {
    return { ...base, message_type: "location", text: `[Location: ${echo.location?.name || "Shared Location"}]` };
  }
  if (type === "contacts") return { ...base, message_type: "contact", text: "[Contact Card]" };
  if (type === "interactive" || type === "button") {
    return { ...base, message_type: "interactive", text: "[Interactive Message]" };
  }
  return { ...base, text: "[Unsupported message sent from WhatsApp Business App]" };
};

export const createEchoProcessor = (deps) => {
  const {
    getAccountByPhoneNumberId,
    formatPhone,
    tryMarkProcessed,
    messageExists,
    getOrCreateContact,
    touchLiveChat,
    saveMessage,
    emit,
    afterSave,
    logger = console,
  } = deps;

  const processOne = async ({ account, phone_number_id, echo }) => {
    const n = normalizeEcho(echo);
    if (!n) return { skipped: "not-a-message" };

    const tenant_id = account.tenant_id;
    const phone = formatPhone(n.to);

    // Idempotency: Meta retries webhooks and a message may already exist.
    const isNew = await tryMarkProcessed(tenant_id, phone_number_id, n.wamid, phone);
    if (!isNew) return { skipped: "duplicate" };
    if (await messageExists(tenant_id, n.wamid)) return { skipped: "already-stored" };

    const { contact } = await getOrCreateContact(tenant_id, phone);
    await touchLiveChat(tenant_id, contact?.contact_id);

    const media_url = n.media_id ? `meta_media_id:${n.media_id}` : null;
    const saved = await saveMessage({
      tenant_id,
      contact_id: contact?.contact_id,
      phone_number_id,
      phone,
      wamid: n.wamid,
      name: contact?.name || phone,
      sender: "admin",
      sender_id: BUSINESS_APP_SENDER_LABEL,
      text: n.text,
      message_type: n.message_type,
      media_url,
      media_mime_type: n.media_mime_type,
      media_filename: n.media_filename,
      status: "sent",
    });

    emit(tenant_id, "new-message", {
      tenant_id,
      phone,
      id: saved?.id,
      contact_id: contact?.contact_id,
      phone_number_id,
      name: contact?.name || phone,
      message: n.text,
      message_type: n.message_type,
      media_url,
      media_mime_type: n.media_mime_type,
      media_filename: n.media_filename,
      status: "sent",
      sender: "admin",
      sender_id: BUSINESS_APP_SENDER_LABEL,
      source: "BUSINESS_APP",
      created_at: new Date(),
    });

    if (afterSave) {
      await afterSave({ tenant_id, contact_id: contact?.contact_id, saved, normalized: n });
    }
    return { stored: true, wamid: n.wamid };
  };

  /** Process a whole webhook body; never throws (webhook must still 200). */
  const processWebhook = async ({ body, urlTenantId }) => {
    const results = [];
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (change?.field !== ECHO_FIELD) continue;
        const value = change.value || {};
        const phone_number_id = value.metadata?.phone_number_id;
        if (!phone_number_id) continue;

        try {
          const account = await getAccountByPhoneNumberId(phone_number_id);
          if (!account) {
            results.push({ skipped: "unknown-account" });
            continue;
          }
          // Only coexistence connections ever receive echoes; anything else is
          // ignored so legacy clients are completely unaffected.
          if (
            resolveConnectionType(account.whatsapp_connection_type) !==
            WHATSAPP_CONNECTION_TYPES.EMBEDDED_COEXISTENCE
          ) {
            results.push({ skipped: "not-coexistence" });
            continue;
          }
          if (urlTenantId && urlTenantId !== account.tenant_id) {
            results.push({ skipped: "tenant-mismatch" });
            continue;
          }
          for (const echo of value.message_echoes || []) {
            try {
              results.push(await processOne({ account, phone_number_id, echo }));
            } catch (err) {
              logger.error?.("[WEBHOOK][ECHO] failed to process echo:", err.message);
              results.push({ error: true });
            }
          }
        } catch (err) {
          logger.error?.("[WEBHOOK][ECHO] failed to process change:", err.message);
          results.push({ error: true });
        }
      }
    }
    return results;
  };

  return { processWebhook, processOne };
};
