import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import { getIO } from "../../middlewares/socket/socket.js";
import { formatPhoneNumber } from "../../utils/helpers/formatPhoneNumber.js";
import { getTenantByPhoneNumberIdService } from "../WhatsappAccountModel/whatsappAccount.service.js";
import { createUserMessageService } from "../Messages/messages.service.js";
import { getOrCreateContactService } from "../ContactsModel/contacts.service.js";
import {
  createLiveChatService,
  getLivechatByIdService,
  updateLiveChatTimestampService,
} from "../LiveChatModel/livechat.service.js";
import { downloadAndStoreIncomingMedia } from "../../services/chatAttachmentService.js";
import { tryMarkMessageProcessed } from "./AuthWhatsapp.service.js";
import { createEchoProcessor } from "./coexistenceEcho.core.js";

const DOWNLOADABLE = new Set(["image", "video", "audio", "document", "sticker"]);

const echoProcessor = createEchoProcessor({
  getAccountByPhoneNumberId: getTenantByPhoneNumberIdService,
  formatPhone: formatPhoneNumber,
  tryMarkProcessed: tryMarkMessageProcessed,

  messageExists: async (tenant_id, wamid) => {
    const [rows] = await db.sequelize.query(
      `SELECT id FROM ${tableNames.MESSAGES} WHERE tenant_id = ? AND wamid = ? LIMIT 1`,
      { replacements: [tenant_id, wamid] },
    );
    return rows.length > 0;
  },

  getOrCreateContact: (tenant_id, phone) =>
    getOrCreateContactService(tenant_id, phone, null, null),

  touchLiveChat: async (tenant_id, contact_id) => {
    const livechat = await getLivechatByIdService(tenant_id, contact_id);
    if (!livechat) await createLiveChatService(tenant_id, contact_id);
    else await updateLiveChatTimestampService(tenant_id, contact_id);
  },

  saveMessage: (m) =>
    createUserMessageService(
      m.tenant_id,
      m.contact_id,
      m.phone_number_id,
      m.phone,
      m.wamid,
      m.name,
      m.sender,
      m.sender_id,
      m.text,
      m.message_type,
      m.media_url,
      m.media_mime_type,
      m.status,
      null,
      m.media_filename,
    ),

  emit: (tenant_id, event, payload) => {
    try {
      getIO().to(`tenant-${tenant_id}`).emit(event, payload);
    } catch (err) {
      console.error("[SOCKET] echo emit failed:", err.message);
    }
  },

  // Same download-on-receive the inbound path uses: Meta media ids expire fast.
  afterSave: async ({ tenant_id, contact_id, saved, normalized }) => {
    if (!DOWNLOADABLE.has(normalized.message_type) || !normalized.media_id) return;
    setImmediate(async () => {
      try {
        const result = await downloadAndStoreIncomingMedia(
          normalized.media_id,
          normalized.media_mime_type,
          normalized.message_type,
          tenant_id,
          contact_id,
        );
        if (!result?.r2Url) return;
        await db.sequelize.query(`UPDATE messages SET media_url = ? WHERE id = ?`, {
          replacements: [result.r2Url, saved?.id],
        });
        getIO()
          .to(`tenant-${tenant_id}`)
          .emit("media-url-updated", { messageId: saved?.id, media_url: result.r2Url });
      } catch (err) {
        console.error("[MEDIA-DOWNLOAD] echo media download failed:", err.message);
      }
    });
  },
});

export const processCoexistenceEchoes = (args) => echoProcessor.processWebhook(args);
