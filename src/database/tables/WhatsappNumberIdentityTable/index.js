import { tableNames } from "../../tableName.js";

/**
 * Business-number identity of a WhatsApp transport (phone_number_id).
 *
 * Chat history belongs to organization + canonical business number + contact.
 * WABA id / Phone Number id are transport details that can change during
 * onboarding, so each transport id an organization has ever used is mapped here
 * to the canonical (E.164) business number it served. Rows are only created when
 * an Embedded Signup connection is completed — an organization that never
 * switches has NO rows here and its inbox queries are unchanged.
 *
 * Append-only decision record: nothing here ever deletes or rewrites messages.
 */
export const WhatsappNumberIdentityTable = (sequelize, Sequelize) => {
  return sequelize.define(
    tableNames.WHATSAPP_NUMBER_IDENTITIES,
    {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      tenant_id: { type: Sequelize.STRING, allowNull: false },
      business_number: {
        type: Sequelize.STRING(24),
        allowNull: false,
        comment: "Canonical E.164 business number, e.g. +919876543210",
      },
      phone_number_id: { type: Sequelize.STRING(64), allowNull: false },
      waba_id: { type: Sequelize.STRING(64), allowNull: true },
      connection_type: { type: Sequelize.STRING(32), allowNull: true },
      migration_mode: {
        type: Sequelize.STRING(24),
        allowNull: false,
        comment: "LEGACY_SEED | FIRST_CONNECTION | SAME_NUMBER | NEW_NUMBER",
      },
      previous_business_number: { type: Sequelize.STRING(24), allowNull: true },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
        field: "created_at",
      },
    },
    {
      tableName: tableNames.WHATSAPP_NUMBER_IDENTITIES,
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { name: "unique_wa_identity_tenant_pid", unique: true, fields: ["tenant_id", "phone_number_id"] },
        { name: "idx_wa_identity_tenant_number", fields: ["tenant_id", "business_number"] },
      ],
    },
  );
};
