import { tableNames } from "../../tableName.js";

/**
 * Recoverable Embedded Signup onboarding state (see migration
 * 20260922_whatsapp_onboarding_sessions.js). The business token and the
 * registration PIN are stored ENCRYPTED (per-tenant AES-256-GCM key) and never
 * leave the backend.
 */
export const WhatsappOnboardingSessionTable = (sequelize, Sequelize) => {
  return sequelize.define(
    tableNames.WHATSAPP_ONBOARDING_SESSIONS,
    {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      onboarding_id: { type: Sequelize.STRING(36), allowNull: false },
      tenant_id: { type: Sequelize.STRING, allowNull: false },
      connection_type: { type: Sequelize.STRING(32), allowNull: false },
      state: { type: Sequelize.STRING(32), allowNull: false, defaultValue: "STARTED" },
      migration_mode: { type: Sequelize.STRING(24), allowNull: true },
      waba_id: { type: Sequelize.STRING(64), allowNull: true },
      phone_number_id: { type: Sequelize.STRING(64), allowNull: true },
      business_number: { type: Sequelize.STRING(24), allowNull: true },
      meta_business_id: { type: Sequelize.STRING(64), allowNull: true },
      previous_json: { type: Sequelize.TEXT, allowNull: true },
      token_enc: { type: Sequelize.TEXT, allowNull: true },
      token_iv: { type: Sequelize.STRING(64), allowNull: true },
      token_tag: { type: Sequelize.STRING(64), allowNull: true },
      pin_enc: { type: Sequelize.TEXT, allowNull: true },
      pin_iv: { type: Sequelize.STRING(64), allowNull: true },
      pin_tag: { type: Sequelize.STRING(64), allowNull: true },
      key_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      last_error_code: { type: Sequelize.STRING(48), allowNull: true },
      attempt_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      lease_until: { type: Sequelize.DATE, allowNull: true },
      active_slot: { type: Sequelize.TINYINT, allowNull: true, defaultValue: 1 },
      recovery_status: { type: Sequelize.STRING(16), allowNull: true },
      recovery_saved_at: { type: Sequelize.DATE, allowNull: true },
      recovery_expires_at: { type: Sequelize.DATE, allowNull: true },
      recovery_json: { type: Sequelize.TEXT, allowNull: true },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
        field: "created_at",
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
        field: "updated_at",
      },
    },
    {
      tableName: tableNames.WHATSAPP_ONBOARDING_SESSIONS,
      timestamps: true,
      underscored: true,
      indexes: [
        { name: "unique_wa_onboarding_id", unique: true, fields: ["onboarding_id"] },
        { name: "unique_wa_onboarding_inflight", unique: true, fields: ["tenant_id", "active_slot"] },
        { name: "idx_wa_onboarding_recovery", fields: ["recovery_status", "recovery_expires_at"] },
      ],
    },
  );
};
