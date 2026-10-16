import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import { getHistoryScope } from "../WhatsappAccountModel/whatsappNumberScope.service.js";

export const getConversationMemory = async (tenant_id, phone, contact_id = null) => {
  if (!phone && !contact_id) return [];

  let whereClause = "tenant_id = ?";
  let replacements = [tenant_id];

  if (contact_id) {
    whereClause += " AND contact_id = ?";
    replacements.push(contact_id);
  } else {
    // Normalize phone to last 10 digits for consistent lookup in 'messages' table
    const cleanPhone = phone.toString().replace(/\D/g, "");
    const suffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    whereClause += " AND phone = ?";
    replacements.push(suffix);
  }

  // AI context must not mix in another business number's conversation either.
  const scope = await getHistoryScope(tenant_id);
  const [rows] = await db.sequelize.query(
    `
    SELECT sender, message, message_type, media_filename, interactive_payload, created_at
    FROM ${tableNames.MESSAGES}
    WHERE ${whereClause}${scope.sql}
    ORDER BY created_at DESC
    LIMIT 50
    `,
    {
      replacements: [...replacements, ...scope.params],
    },
  );

  // Return oldest → newest
  return rows.reverse();
};
