# AI Model Catalog — Deployment & Rollback

Applies to `invictus-chatbot` commits `f529974` (catalog) + this hardening pass,
and `Whatnexus-frontend` `96013d3` + this pass.

## Preconditions

- `OPENAI_API_KEY` (platform key) set in the backend environment.
- In **production**, `DB_AUTO_MIGRATE` is unset or `false` — the app no longer
  runs `sequelize.sync({ alter: true })` at startup. It runs an explicit schema
  preflight instead and refuses to boot if a required migration is missing.
- In dev, `sync({ alter: true })` still runs (set `DB_AUTO_MIGRATE=false` to opt
  out locally).

## Deployment order

1. **Back up the database.**
2. **Run migrations** (idempotent, additive, no destructive `down`):
   ```
   node migrations/20260910_ai_model_catalog.js
   node migrations/20260911_ai_catalog_hardening.js
   ```
   `20260910` creates the catalog tables, adds the nullable billing/usage
   columns, and grandfathers models already `is_active` in `ai_pricing` into
   `review_status=approved`, `test_status=legacy_grandfathered`. `20260911`
   normalises any rows created by an older run.
3. **Run the catalog rollout preflight:**
   ```
   node src/scripts/checkAiCatalogRollout.js
   ```
   Exits non-zero if any model referenced by an active pricing rule or a tenant
   selection lacks review / profile / pricing.
4. **Cached-input pricing backfill — dry run, then apply:**
   ```
   node src/scripts/backfillAiCachedInputPricing.js --dry-run
   node src/scripts/backfillAiCachedInputPricing.js --apply
   ```
   Dry-run is the default; `--apply` is required for any write; the whole apply
   runs in ONE transaction and rolls back entirely on error. It:
   - reads rates only from `src/config/aiCachedInputPricing.js` (reviewed config),
   - matches EXACT model ids (never a prefix/family),
   - sets a rate only on a currently-null row, bumps `pricing_version` only when
     a rate actually changes, flips `billingCapabilities.cachedInput` on the
     catalog profile, writes an `admin_audit_log` row per change,
   - treats an equal existing rate as **skipped**; a differing existing rate as
     a **conflict** that is left untouched unless you pass `--resolve-conflicts`,
   - also cross-checks the reviewed standard input/output rates against the live
     rule and reports (never writes) any mismatch,
   - refuses an unknown `INVICTUS_SERVER_LINE`; `--apply` against production
     additionally needs `--allow-production`.
   Scope to specific models with `--models=gpt-5.4,gpt-5.4-mini`.
   Models with no verified rate are reported **blocked for cached-input
   execution** — until a rate is added they emit a reconciliation event (no
   wallet charge) if OpenAI returns cached tokens. Add the rate to the config
   and re-run `--apply`.
5. **Deploy backend.**
6. **Deploy frontend.**
7. **Admin: refresh the catalog** — Pricing & Rates → Model Catalog → *Refresh
   models*. New discoveries land as `pending` and are hidden from tenants.
8. **Live compatibility tests** — see `runbook-live-tests.md`. Required before a
   fresh activation and before assigning a model to a new tenant.
9. **Activate only for a staging tenant first**, verify a real request bills
   correctly (see runbook), then widen.

## What is safe to leave as-is

The 11 grandfathered models are already `is_active` and keep working after
deploy. They show as **"Active (legacy — not live-tested)"**. They do **not**
need re-activation. A fresh activation, or assigning one to a *new* tenant,
requires a real passing compatibility test.

## Rollback

Do **not** roll back by "restoring the old fallback logic" — the pre-catalog
code priced unknown models as `gpt-4o-mini` and fell back to the first active
pricing row. Both are unsafe. Follow this instead:

1. **Identify affected tenants** — any tenant whose `ai_settings.input_model` /
   `output_model` / `vision_model` / `*_fallback_model` is a model that was
   *newly activated* after this deploy (i.e. not one of the 11 grandfathered
   models):
   ```
   node src/scripts/checkAiCatalogRollout.js
   ```
   plus a query of `tenants.ai_settings` for the new model ids.
2. **Disable the new selections** — deactivate the newly-activated models via
   Model Catalog → *Deactivate*. This sets `ai_pricing.is_active = false`;
   `resolveModel` then routes those tenants to their explicit fallback or
   returns a controlled error (it never silently reprices).
3. **Move affected/staging tenants back to a verified legacy model** through an
   explicit AI-settings save (Organizations → edit, or the tenant's General
   Settings → AI Models). Never edit `ai_settings` in the DB by hand.
4. **Confirm no in-flight requests** for the new models — watch
   `[AI-SERVICE]` / `[AI-TOKEN-TRACKER]` logs for ~5 minutes.
5. **Run the rollout preflight** again — it should pass with only grandfathered
   models in use.
6. **Revert the frontend** commit(s), redeploy.
7. **Revert the backend** commit(s), redeploy.
8. **Retain** the additive catalog tables and the `cached_input_price_per_million`
   / `ai_token_usage` billing columns. They are inert when the old code runs
   (the old code never reads them) and dropping them loses reconciliation data.
9. **Verify wallet + ledger health** — `GET /api/whatsapp/billing/admin/health-summary`;
   `total_unresolved` and `ai_reconciliation_open` should be flat.
10. **Monitor** `[AI-SERVICE]` errors and `billing_failure` health events for
    24h.

### Safety patch during rollback

The reverted backend restores `costEstimator`'s old behavior. If a staged
rollback must keep exact-pricing enforcement, cherry-pick only
`src/utils/billing/costEstimator.js` and `src/utils/ai/trackAiTokenUsage.js`
from the catalog commit onto the rollback branch — they enforce "no exact
approved pricing → block" without needing the rest of the catalog runtime.

## Reconciliation ownership

`billing_failure` events whose message starts with **"AI usage uncharged"** are
AI billing reconciliations: a real OpenAI request succeeded but could not be
mapped to the approved standard-tariff pricing rule, so the wallet was **not**
charged. Owner: **platform billing operator**. Procedure:

1. Open `GET /api/whatsapp/billing/admin/health-summary` → `ai_reconciliation_open`.
2. For each event read `metadata` — `reason`, `requested_model`, `actual_model`,
   `pricing_rule_id`, `pricing_version`, normalized `usage`, `occurrences`.
3. Fix the root cause:
   - `cached_input_unpriced` → add a verified rate to
     `src/config/aiCachedInputPricing.js`, run the backfill `--apply`.
   - `unmapped_actual_model` → add the returned id to the profile's
     `actualModelIds` via Model Catalog → Review, then re-test.
   - `unsupported_service_tier` → investigate why OpenAI applied a non-standard
     tier; usually an org-level setting.
   - `request_over_max_bytes` → raise `maxInputBytes` in the profile if the
     larger request is expected and priced at the standard rate.
4. If the tenant should be charged for the historical usage, raise a manual
   wallet adjustment referencing the event id, then mark the event `resolved`.
