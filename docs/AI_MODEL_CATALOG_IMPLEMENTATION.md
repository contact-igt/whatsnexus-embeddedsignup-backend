# WhatsNexus AI models: current implementation and upgrade plan

Reviewed: 2026-09-09.

**Status: repository analysis and implementation specification.** This document does not enable new models, change tenant selections, update prices, or install an automatic synchronization job. The current implementation is described separately from the changes to build.

## 1. What we need

Allow administrators to discover newly available OpenAI API models, review their compatibility and pricing, and make approved models appear in WhatsNexus tenant settings without editing a frontend dropdown for every release.

Use this workflow:

```text
OpenAI model discovery → admin catalog → compatibility and pricing review
                                              ↓
                                    enable approved model
                                              ↓
                               tenant input/output selection
                                              ↓
                          request → response → usage → billing
```

Discovery should update the admin catalog automatically. A new release should not automatically change existing customer models or become billable before its request format and prices are configured.

## 2. Existing implementation

Paths below are relative to the workspace root unless stated otherwise.

| Area | Existing file / behavior |
| --- | --- |
| Model and price storage | `invictus-chatbot/src/database/tables/AiPricingTable/index.js`: unique `model`, description, `recommended_for`, category, input/output USD rates per million tokens, markup, exchange-rate setting, pricing version, active flag |
| Admin management | `invictus-chatbot/src/models/ManagementModel/management.routes.js`, `management.controller.js`, `management.service.js` |
| Admin UI | `Whatnexus-frontend/components/views/pricing/pricingView.tsx`: Add AI Model has a hard-coded select list |
| Frontend management API | `Whatnexus-frontend/services/management/index.ts`; mutations in `hooks/useManagementQuery.tsx` |
| Tenant model list | `GET /whatsapp/billing/ai-models`, backed by `getAvailableAiModelsService()` in `invictus-chatbot/src/models/BillingModel/billing.service.js` |
| Tenant settings UI | `Whatnexus-frontend/components/views/settings/GeneralSettingsView.tsx` |
| Organization settings UI | `Whatnexus-frontend/components/views/organization/organizationModal.tsx` |
| Tenant choice storage | `Tenants.ai_settings.input_model` and `output_model`; validation in `TenantModel/tenant.controller.js` checks active pricing rows |
| Runtime model selection | `invictus-chatbot/src/utils/ai/getTenantAiModel.js` |
| API key selection | `invictus-chatbot/src/utils/ai/getOpenAIClient.js` |
| Text requests | `invictus-chatbot/src/utils/ai/coreAi.js`, `callAI()` |
| Image requests | `invictus-chatbot/src/utils/ai/visionAi.js`, a separate direct OpenAI call |
| Usage and billing | `invictus-chatbot/src/utils/ai/trackAiTokenUsage.js`, `src/utils/billing/costEstimator.js` |
| Initial model pricing | `invictus-chatbot/src/scripts/seed_all_pricing.js` |

### Existing endpoints

| Endpoint | Current behavior |
| --- | --- |
| `GET /management/ai-pricing` | List pricing rules; management super_admin and platform_admin |
| `POST /management/ai-pricing` | Create rule; management super_admin |
| `PUT /management/ai-pricing/:id` | Update rule; management super_admin |
| `DELETE /management/ai-pricing/:id` | Physically delete rule; management super_admin |
| `GET /whatsapp/billing/ai-models` | Authenticated users receive active database model rows, including display prices |

Creation currently forces `is_active: true` in the service. A request with `is_active: false` must not be assumed to create a draft. Change this behavior before using the existing creation endpoint for discovered candidates.

### Runtime flow

1. `callAI()` chooses input or output purpose from the source name. Language detection, classification, knowledge search, and knowledge processing use the input model; other sources use the output model.
2. `getTenantAiModel()` reads the tenant choice and validates it against active `AiPricing` rows, cached for five minutes.
3. Defaults are `gpt-4o-mini` for input and `gpt-4o` for output. If a selected/default model is inactive, the resolver may use the first active model; if no active models are available, it returns a hard-coded default.
4. `getOpenAIClient()` resolves a tenant secret, then the legacy encrypted setting, then the platform `OPENAI_API_KEY`. It also caches resolved tenant keys for five minutes. Its comment says raw keys are not cached, but the implementation actually stores `resolvedKey`; account for the real behavior when extending discovery.
5. Requests use `openai.chat.completions.create()` with messages, `temperature`, `max_tokens`, and optional `response_format` / `top_p`.
6. Text is read from `choices[0].message.content`; token tracking is dispatched asynchronously.
7. The tracker reads `prompt_tokens`, `completion_tokens`, and `total_tokens`. The estimator applies database rates, markup, and currency conversion, with usage/pricing snapshots recorded for billing.

The tenant list is dynamic **from our database**, not synchronized from OpenAI. The existing `models.list()` call in tenant key verification checks a credential; it does not populate the application catalog or prove a specific generation request will work.

### Model IDs already present in the admin dropdown

```text
gpt-4o, gpt-4o-mini, gpt-4o-audio-preview
gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4.5
o4-mini, o3-mini, o1, o1-mini, o3, o3-pro
gpt-5.4, gpt-5.4-mini, gpt-5.4-nano
```

These are code entries, not a verified list of active database records or models accessible to your API project. Live model access and the production database were not queried during this review.

## 3. Additional models to evaluate

The following public API models and standard text-token rates were checked against official OpenAI documentation on the review date. Prices are USD per one million tokens, before WhatsNexus markup, conversion, or taxes. These are reference values, not a complete billing tariff: cached input, cache writes, long contexts, tools, and service tiers can have different charges. Recheck the linked model page when activating a model.

| API model ID | Input / output | Suggested WhatsNexus evaluation | Repository dropdown |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | $0.20 / $1.20 | Classification, extraction, high-volume short replies | Not present |
| `gpt-5.6-terra` | $2.00 / $12.00 | Customer support and more demanding replies | Not present |
| `gpt-5.6-sol` | $4.00 / $20.00 | Complex workflows and premium reply quality | Not present |
| `gpt-6-astra` | $10.00 / $50.00 | Difficult reasoning/document work; evaluate cost and latency first | Not present |
| `gpt-5.4-nano` | $0.20 / $1.25 | Existing cheaper-family candidate for narrow tasks | Present |
| `gpt-5.4-mini` | $0.75 / $4.50 | Existing candidate for routine support workloads | Present |
| `gpt-5.4` | $2.50 / $15.00 | Existing candidate for complex replies | Present |

Sources: [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4).

The suggested WhatsNexus uses are engineering recommendations to benchmark, not measured results. Start with a low-cost input candidate and a reply-quality candidate, then compare them against existing defaults. Public documentation does not establish access for your project or a tenant's own key. Model-specific endpoint, parameter, and modality support must be verified before enabling any candidate.

Do not treat every returned model as a chatbot. Image generation, embeddings, moderation, audio, realtime, and specialized coding models need their own supported workflows. This plan initially covers OpenAI text/image-input models; other providers need separate credentials, request handling, and billing integration.

### Existing IDs that need review

`gpt-4.5` in the repository is not a verified API ID in this review. The documented `gpt-4.5-preview` was shut down on 2025-07-14. The deprecation page also lists `gpt-4.1-nano` for shutdown on 2026-10-23. Mark lifecycle status and plan migrations instead of advertising every legacy entry indefinitely. Keep historical usage model IDs intact. [Official deprecations](https://developers.openai.com/api/docs/deprecations)

## 4. Gaps to fix before enabling more models

| Gap | Required change |
| --- | --- |
| Hard-coded admin list | Replace it with the server catalog, with search and status indicators |
| New records immediately active | Create candidates as disabled; explicitly activate after checks |
| List contains unrelated model types | Keep unsupported/unknown models out of tenant selections |
| Shared parameter assumptions | Store a reviewed request profile and construct only supported parameters |
| Small reasoning budgets | Benchmark existing source limits, especially 50/80-token input tasks; handle incomplete output rather than treating it as a successful empty answer |
| Separate vision allowlist | Use the same capability record and request builder for vision; remove silent overrides to an unvalidated model |
| Usage assumes Chat Completions | Normalize Responses usage/output if adding that endpoint |
| Unknown model priced as gpt-4o-mini | Require known pricing before a new model can execute; do not silently apply a cheaper model's rates |
| Pricing lifecycle | Increment pricing version when rates/markup change; preserve historical usage snapshots |
| Cache staleness | Invalidate model and pricing caches plus frontend queries after activation/deactivation/pricing updates |
| Account availability ignored | Filter/check access using the effective credential scope; one tenant's catalog must not imply access for another |
| Arbitrary fallback | Choose an explicitly configured, compatible, active, priced fallback for each purpose; report when none exists |

The existing admin pricing update service changes rates but does not itself increment `pricing_version`. The frontend pricing mutations invalidate `ai-pricing-rules`, not `available-ai-models`. Both need attention as part of this implementation.

## 5. Implementation stages

### Stage A — dynamic catalog and manual refresh

Reuse `AiPricing` as the published/priced catalog. Add one small discovery table, `AiModelCatalog`, because unreviewed model discovery must not require fake prices in non-null pricing columns.

Suggested discovery fields:

| Field | Purpose |
| --- | --- |
| `model` | Exact OpenAI API ID; unique in the platform catalog |
| `owned_by`, `provider_created_at` | Provider metadata |
| `first_seen_at`, `last_seen_at` | Discovery history |
| `shutdown_date` | Provider date if supplied; nullable |
| `review_status` | `pending`, `approved`, `unsupported`, `retired` |
| `request_profile` | Reviewed JSON: endpoint, modalities, JSON support, supported sampling/reasoning settings, token-limit parameter and limits |
| `reviewed_at`, `reviewed_by` | Who verified compatibility |

Do not store API keys in these rows. Keep platform discovery separate from per-tenant access checks; use a scoped TTL cache for tenant availability initially instead of another permanent table.

Proposed endpoints, not currently implemented:

| Endpoint | Behavior |
| --- | --- |
| `GET /management/ai-model-catalog` | Catalog, pricing readiness, lifecycle, last successful refresh |
| `POST /management/ai-model-catalog/sync` | Fetch platform-accessible models and upsert discovery metadata |
| `PUT /management/ai-model-catalog/:id` | Review supported request profile and status |

Reuse current management authentication/authorization; catalog mutations should require `super_admin`. Validate model IDs, enums, finite nonnegative rates, duplicate IDs, and profile fields server-side.

Discovery uses the platform credential on the backend:

```js
// Illustrative core operation, not a complete route or a browser call.
const client = await getOpenAIClient();
const result = await client.models.list();
for (const model of result.data) {
  // Upsert provider metadata and last_seen_at.
  // Do not change prices, approved capabilities, or tenant settings here.
}
```

The Models API exposes basic availability metadata, not token prices or a complete compatibility profile. Treat `shutdown_date` as optional and verify the installed SDK's type support. Price/capability review remains a separate operation. [List models reference](https://developers.openai.com/api/reference/resources/models/methods/list)

The admin screen should show `Pending review`, `Pricing needed`, `Ready`, `Active`, and lifecycle information. Selecting a candidate opens the existing pricing form. Store rates through the existing pricing service after modifying it to support inactive creation. Activation requires both approved compatibility and valid pricing.

Tenant choices should be the intersection of active priced models, approved capabilities for the requested purpose, and access under the effective API key. Include tenant identity in the frontend query key once results become tenant-specific. Retain an unavailable saved choice visibly with an explanation rather than silently displaying a different selection.

### Stage B — requests and accurate billing

Extend `callAI()` rather than duplicating request code per model. Use a small profile-driven builder. Keep the existing Chat Completions path for compatible models; add a Responses branch when needed. Do not infer support solely from a `gpt-` prefix.

- Select `max_tokens`, `max_completion_tokens`, or `max_output_tokens` according to the reviewed endpoint/model profile.
- Send `temperature`, `top_p`, JSON mode, and reasoning controls only in supported combinations.
- Preserve `callAI()`'s outward contract: content, finish reason, normalized usage, raw response.
- Validate required JSON responses and handle refusal, incomplete output, and token exhaustion explicitly.
- Route image requests through the same selection/profile logic while preserving their image payload.
- Normalize Chat Completions prompt/completion tokens and Responses input/output tokens before billing. Capture available cached-input and reasoning details without double-counting output tokens.
- Extend pricing only for the pricing dimensions actually enabled. Block unsupported tool/cache/service-tier tariffs instead of silently charging them as basic text.
- Record the actual returned model ID and the pricing rule/version used. Prefer exact snapshot pricing before a reviewed alias mapping.

Responses uses a different output structure and request conventions; adapting only the model ID is insufficient. Use the official migration guide when implementing that branch. [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)

### Stage C — recurring discovery

After manual refresh works, invoke the same sync function once daily through the existing job infrastructure. A successful complete refresh updates discovery metadata and flags missing/new models. A timeout, authentication error, empty anomalous result, or rate limit must retain the previous catalog and show a refresh error; it must not deactivate all models.

Prevent concurrent duplicate jobs, make upserts idempotent, and avoid logging credentials. Use an in-app admin indicator for new candidates. Routine discovery should not send WhatsApp messages or make billable generation calls. Compatibility smoke tests should be explicit admin actions with a token cap.

New models appear automatically under pending review. Existing approved models retain their prices and tenant assignments. Retirement should disable new selection, identify affected tenants, and offer an explicit tested replacement; retain usage/pricing history.

## 6. How an administrator adds a model after these changes

1. Open Pricing → AI Models → Refresh models.
2. Select a newly discovered exact API ID.
3. Review its official documentation, request profile, and shutdown status.
4. Enter verified prices per million tokens, markup, and applicable pricing dimensions.
5. Run a capped test for text, required JSON behavior, and vision if enabled, using the relevant credential scope.
6. Activate the model. Invalidate the runtime/price caches and tenant model-list query.
7. Select it for a test tenant's input/output purpose and verify a real workflow and its ledger record.
8. Make it available more broadly after quality, latency, and billing checks pass. Keep an explicit rollback choice.

Today, the backend pricing API accepts model names independently of the frontend dropdown, but creation immediately activates the row and does not establish compatibility. Do not use that as an untested shortcut for new model families.

## 7. Concrete file changes

Backend paths in this table are relative to `invictus-chatbot`.

| File / area | Planned work |
| --- | --- |
| `src/database/tables/AiModelCatalogTable/index.js` + migration + database registration | Add discovery metadata and approved request profiles |
| `src/models/ManagementModel/management.routes.js` | Catalog list, sync, review routes with existing role checks |
| New catalog service/controller beside management code | Provider discovery, idempotent updates, lifecycle and review validation |
| `src/models/ManagementModel/management.service.js` | Inactive pricing creation, activation gate, version increments, cache invalidation |
| `src/models/BillingModel/billing.service.js` | Return only usable models for tenant scope |
| `src/models/TenantModel/tenant.controller.js` | Validate saved choices by purpose and effective credential access |
| `src/utils/ai/getTenantAiModel.js` | Capability-aware selection, explicit fallback, exported cache invalidation |
| `src/utils/ai/coreAi.js` and `visionAi.js` | Shared request construction and normalized results |
| `src/utils/ai/trackAiTokenUsage.js` and `src/utils/billing/costEstimator.js` | Usage normalization, known-model pricing requirement, accurate snapshots |
| Existing scheduled-job registration | Daily call to the same discovery service |
| `Whatnexus-frontend/components/views/pricing/pricingView.tsx` | Dynamic admin catalog, refresh/review/enable states |
| Frontend management service and query hooks | Catalog operations and both pricing/model-list invalidation |
| Frontend billing query hook and settings/organization selectors | Tenant-scoped availability and informative empty/error/retired states |

No new provider SDK is needed for discovery: the backend already declares the `openai` dependency. Check the installed SDK against selected endpoint/usage types before deciding whether an SDK update is necessary.

## 8. Acceptance checks

- Repeated sync does not duplicate models or overwrite reviewed prices/capabilities.
- A new unknown model appears in admin review, not in tenant choices.
- A known compatible model can be activated and selected without changing frontend source.
- Missing pricing, missing credentials, unsupported modality, or unapproved request profile prevents activation/execution with a useful message.
- Tenant A's key and available-model response cannot leak to tenant B.
- Chat Completions and Responses fixtures normalize to expected content and usage; reasoning/cached usage is not billed twice.
- Model-specific parameter tests cover forbidden sampling parameters, output limits, JSON output, and truncation.
- Ledger cost matches the selected tariff and actual model; unknown pricing never falls back to an unrelated cheap model.
- Deactivation/price changes invalidate caches and preserve existing history.
- Empty provider responses, 401, 429, and network failures retain the last successful catalog.
- Retirement shows impacted tenant selections and respects the configured fallback policy.
- Existing default-model workflows still pass; a staged tenant can roll back without changing historical charges.

## 9. Delivery boundary

This review created the document only. It did not query a live OpenAI account, spend tokens on test requests, change secrets, modify the model database, or activate any model. Current source references and public model documentation were inspected. Implement Stage A and Stage B together before advertising new-model support; Stage C adds automatic discovery using the same tested service.
