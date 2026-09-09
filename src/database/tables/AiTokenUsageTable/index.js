import { tableNames } from "../../tableName.js";

export const AiTokenUsageTable = (sequelize, Sequelize) => {
  return sequelize.define(
    tableNames.AI_TOKEN_USAGE,
    {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },

      tenant_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      requested_model: Sequelize.STRING,
      actual_model: Sequelize.STRING,
      pricing_model: Sequelize.STRING,
      endpoint: Sequelize.STRING(32),
      pricing_rule_id: Sequelize.INTEGER,
      fallback_reason: Sequelize.STRING,
      input_tokens: Sequelize.INTEGER,
      cached_input_tokens: Sequelize.INTEGER,
      output_tokens: Sequelize.INTEGER,
      reasoning_tokens: Sequelize.INTEGER,
      cached_input_price_per_million: Sequelize.DECIMAL(10, 4),

      model: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: "AI model used (e.g., gpt-4o, gpt-4o-mini)",
      },

      source: {
        type: Sequelize.STRING,
        allowNull: false,
        comment:
          "Where the call originated (whatsapp, playground, classifier, knowledge, language_detect)",
      },

      prompt_tokens: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      completion_tokens: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      total_tokens: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      estimated_cost: {
        type: Sequelize.DECIMAL(15, 8),
        allowNull: false,
        defaultValue: 0,
        comment: "Final cost in USD after markup (kept for backward compat)",
      },

      input_rate: {
        type: Sequelize.DECIMAL(10, 4),
        allowNull: true,
        comment: "Input rate used at call time (USD per 1M tokens)",
      },

      output_rate: {
        type: Sequelize.DECIMAL(10, 4),
        allowNull: true,
        comment: "Output rate used at call time (USD per 1M tokens)",
      },

      markup_percent: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: "Platform markup % applied at call time",
      },

      usd_to_inr_rate: {
        type: Sequelize.DECIMAL(10, 4),
        allowNull: true,
        comment: "USD to INR rate used at call time",
      },

      base_cost_usd: {
        type: Sequelize.DECIMAL(15, 8),
        allowNull: true,
        comment: "Raw cost before markup (USD)",
      },

      final_cost_usd: {
        type: Sequelize.DECIMAL(15, 8),
        allowNull: true,
        comment: "Cost after markup (USD), same as estimated_cost",
      },

      final_cost_inr: {
        type: Sequelize.DECIMAL(15, 6),
        allowNull: true,
        comment: "Final cost in INR — authoritative value for display",
      },

      pricing_version: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: "AiPricingTable version at time of billing",
      },

      billed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment:
          "False if usage was tracked but wallet deduction was skipped (insufficient balance)",
      },

      billing_cycle_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: "FK to billing_cycles — set for postpaid entries",
        references: {
          model: "billing_cycles",
          key: "id",
        },
      },

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
      tableName: tableNames.AI_TOKEN_USAGE,
      timestamps: true,
      underscored: true,
      indexes: [
        {
          name: "idx_ai_token_usage_tenant",
          fields: ["tenant_id"],
        },
        {
          name: "idx_ai_token_usage_created",
          fields: ["created_at"],
        },
        {
          name: "idx_ai_token_usage_source",
          fields: ["source"],
        },
        {
          name: "idx_ai_token_usage_billing_cycle",
          fields: ["billing_cycle_id"],
        },
      ],
    },
  );
};
