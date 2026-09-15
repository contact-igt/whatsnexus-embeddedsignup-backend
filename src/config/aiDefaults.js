/**
 * The platform's default AI model per purpose. Single source of truth for the
 * runtime. Changing these does NOT change any tenant's saved selection — it only
 * affects tenants that never chose a model. Both defaults must be grandfathered
 * (approved + priced + a passing/legacy test status) before a deployment, or
 * those tenants' AI calls will fail with a controlled error.
 *
 * NOTE: migrations/20260910_ai_model_catalog.js intentionally re-declares the
 * grandfather model list inline (a migration must be self-contained and frozen).
 * A consistency test (aiDefaults.test.js) asserts the two stay in sync.
 */
export const DEFAULT_MODELS = Object.freeze({
  input: "gpt-4o-mini",
  output: "gpt-4o",
  vision: "gpt-4o",
});
