export const AiModelCatalogTable = (sequelize, S) => sequelize.define("ai_model_catalog", {
  id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
  provider: { type: S.STRING(24), allowNull: false, defaultValue: "openai" },
  model: { type: S.STRING(200), allowNull: false },
  owned_by: S.STRING,
  provider_created_at: S.DATE,
  first_seen_at: S.DATE,
  last_seen_at: S.DATE,
  last_successfully_seen_at: S.DATE,
  review_status: { type: S.STRING(24), allowNull: false, defaultValue: "pending" },
  lifecycle_status: { type: S.STRING(24), allowNull: false, defaultValue: "unknown" },
  shutdown_date: S.DATEONLY,
  request_profile: S.JSON,
  reviewed_at: S.DATE,
  reviewed_by: S.STRING,
  last_tested_at: S.DATE,
  // test_status is the last VALID activation qualification:
  //   not_tested | passed | failed | legacy_grandfathered
  // A transient/config test failure never overwrites a good value, and a
  // failure on an ACTIVE model never sets "failed" (that would break runtime).
  test_status: { type: S.STRING(24), allowNull: false, defaultValue: "not_tested" },
  test_error: S.STRING,           // sanitized summary of the LAST attempt (any outcome)
  test_result: S.JSON,            // full result of the last PASSING test
  last_test_attempt_at: S.DATE,   // any attempt, incl. failed
  last_test_failure_class: S.STRING(24), // transient | definitive | configuration
  activated_at: S.DATE,
  activated_by: S.STRING,
}, { tableName: "ai_model_catalog", timestamps: true, underscored: true,
  indexes: [{ unique: true, fields: ["provider", "model"] }] });

// Append-only history of every compatibility-test run. The catalog row keeps
// only the last-known-good qualification; the debugging trail lives here.
export const AiModelTestAttemptsTable = (sequelize, S) => sequelize.define("ai_model_test_attempts", {
  id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
  catalog_id: { type: S.INTEGER, allowNull: false },
  credential_scope: { type: S.STRING(16), allowNull: false }, // platform | tenant
  tenant_id: S.STRING,
  started_at: { type: S.DATE, allowNull: false },
  completed_at: S.DATE,
  result_status: { type: S.STRING(16), allowNull: false },    // passed | failed
  failure_class: S.STRING(24),                                // transient | definitive | configuration
  failing_check: S.STRING(32),                                // text | json | structured | vision | access
  sanitized_error: S.STRING(500),
  requested_model: S.STRING(200),
  actual_model: S.STRING(200),
  test_result: S.JSON,
  triggered_by: S.STRING,
  correlation_id: S.STRING(64),
}, { tableName: "ai_model_test_attempts", timestamps: true, underscored: true,
  indexes: [{ fields: ["catalog_id", "id"] }] });

export const AiModelSyncTable = (sequelize, S) => sequelize.define("ai_model_sync", {
  id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
  started_at: { type: S.DATE, allowNull: false },
  completed_at: S.DATE,
  status: { type: S.STRING(24), allowNull: false },
  models_received: { type: S.INTEGER, defaultValue: 0 },
  models_created: { type: S.INTEGER, defaultValue: 0 },
  models_updated: { type: S.INTEGER, defaultValue: 0 },
  error_code: S.STRING(64),
  sanitized_error: S.STRING,
}, { tableName: "ai_model_sync", timestamps: true, underscored: true });
