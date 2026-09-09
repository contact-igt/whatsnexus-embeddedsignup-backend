# AI Model Catalog — Live Test Runbook (admin actions)

These are **manual, authorised** actions performed in the admin UI or with a
configured platform/tenant OpenAI key. Automated test suites never make live
billable OpenAI calls. Every automated test caps output tokens; every step below
also caps output tokens.

Nothing here should be run without an operator explicitly deciding to spend
provider tokens.

---

## 0. Catalog refresh

- **UI:** Pricing & Rates → Model Catalog → *Refresh models*.
- **Expected request:** `GET https://api.openai.com/v1/models` (platform key), paginated.
- **Expected result:** `ai_model_sync` row `status=success`; new ids appear as
  `review_status=pending`, hidden from tenants.
- **DB records:** one `ai_model_sync` row; `ai_model_catalog` rows upserted
  (reviewed fields, pricing, activation preserved).
- **Pass:** models list grows/updates, no existing review lost.
- **Fail / recovery:** `status=failed` with a sanitized error; the previous
  catalog is unchanged. Fix the key/network and retry.

---

## 1. Platform-scope compatibility test

- **UI:** Model Catalog → *Review* on an approved model → *Run capped test* with
  scope **Platform**.
- **Expected requests:** 1–4 small calls (text, and — if the profile enables
  them — JSON, structured, vision), each `max_tokens ≤ 512`.
- **Expected sanitized result:**
  ```json
  { "success": true, "requestedModel": "...", "actualModel": "...",
    "endpoint": "chat_completions|responses",
    "usage": { "inputTokens": n, "cachedInputTokens": n, "outputTokens": n, "reasoningTokens": n, "totalTokens": n },
    "checks": [{ "name": "text", "passed": true }, ...], "warnings": [] }
  ```
  No API key or fingerprint in the response.
- **DB records:** `ai_model_catalog.test_status = passed`, `test_result` stored,
  `last_tested_at` set; an `admin_audit_log` row (`action_type=pricing_update`,
  `details.action=compatibility_test`).
- **Pass:** all `checks[].passed`, `actualModel` maps to an approved id.
- **Fail:** `test_status = failed`, `test_error` set; activation stays blocked.

## 2. Tenant-scope compatibility test

- Same as §1 but scope **Tenant** + a valid tenant id.
- **Expected:** requests use that tenant's effective OpenAI credential.
- **Pass criteria add:** `credentialScope: "tenant"`, `tenantId` echoed.
- **Recovery:** if the tenant key lacks model access → `AI_MODEL_ACCESS`; ask
  the tenant to enable the model on their OpenAI org.

## 3. Chat Completions test

- Profile `endpoint: chat_completions`. `text` check must return non-empty
  content with `finish_reason: stop`.
- **Expected usage fields:** `prompt_tokens`, `completion_tokens`,
  `total_tokens`; `prompt_tokens_details.cached_tokens` when cached.

## 4. Responses test

- Profile `endpoint: responses`. Request carries `input`/`instructions`,
  `max_output_tokens`, `store: false`.
- **Expected:** `output[].content[].type == "output_text"`, `status: completed`.
- **Usage fields:** `input_tokens`, `output_tokens`,
  `output_tokens_details.reasoning_tokens` for reasoning models.

## 5. Structured / JSON test

- Profile `supportsStructuredOutput` or `supportsJsonMode` true.
- **Expected result:** `content` parses as JSON; `{ "ok": true }` for the
  built-in check.
- **Fail:** invalid JSON → `test_status = failed`.

## 6. Vision test

- Profile `modalities` includes `image_input`.
- **Expected request:** a 1×1 PNG data URI plus a text part; `detail: low`.
- **Pass:** non-empty content, no refusal.

## 7. Cached-input test  (authorised stage run only)

**Do not run without explicit authorisation — this makes real billable calls.**

Preconditions:
- An authorised stage tenant with a working OpenAI credential.
- A supported active model whose pricing rule has a non-null
  `cached_input_price_per_million` and whose catalog profile has
  `billingCapabilities.cachedInput: true` (run `backfillAiCachedInputPricing.js`
  first). Use e.g. `gpt-4o` or `gpt-5.4`.
- Note the tenant wallet balance and the model's `pricing_version`.

Procedure:
1. Build a **stable** prompt of **> 1,024 tokens** (prompt caching only kicks in
   above that). Keep the leading content byte-for-byte identical between calls —
   put any variable text at the very end.
2. Send request #1 (warms the cache). Wait a few seconds.
3. Send request #2 with the identical prompt prefix.
4. Repeat #3 two or three more times if #2 shows `cachedInputTokens = 0` (cache
   population is best-effort and can lag).

Expected sanitised result (a cache-hit call):
```json
{ "usage": { "inputTokens": N, "cachedInputTokens": C, "outputTokens": O, ... } }
```
with `C > 0` and `C <= N`.

Expected billing for that call:
```
uncached = max(inputTokens − cachedInputTokens, 0)
baseUsd  = uncached/1e6 · input_rate
         + cachedInputTokens/1e6 · cached_input_price_per_million
         + outputTokens/1e6 · output_rate            (output charged ONCE; reasoning is already inside outputTokens)
finalUsd = baseUsd · (1 + markup_percent/100)
finalInr = finalUsd · usd_to_inr_rate               (via the currency service)
```

Expected database records:
- `ai_token_usage`: `cached_input_tokens = C`, `cached_input_price_per_million`
  snapshotted, `pricing_version` == the rule's current version,
  `requested_model` / `actual_model` / `pricing_model` set, `base_cost_usd`,
  `final_cost_usd`, `final_cost_inr` matching the formula, `billed: true`.
- `billing_ledger`: one `entry_type: ai`, `billing_status: charged` row, same
  `pricing_version` and `usd_to_inr_rate`.
- wallet balance decreased by **exactly** `final_cost_inr` (6-dp rounded).
- **No** `billing_system_health` row with message starting "AI usage uncharged".

Pass criteria (all must hold):
- `cachedInputTokens > 0` on at least one call.
- uncached and cached input are split per the formula above.
- output is charged once (compare against a no-cache call of the same size).
- markup and FX unchanged from a non-cached baseline call.
- wallet delta == calculated `final_cost_inr`.
- ledger + usage snapshot agree; no reconciliation event.

Recovery if it fails:
- `cachedInputTokens` always 0 → the prompt prefix isn't stable enough or is
  < 1,024 tokens; not a billing bug. Fix the prompt and retry.
- Preflight throws `AI_TARIFF_UNSUPPORTED` / reason `CACHED_INPUT_RATE_MISSING`
  → the rule has no cached rate. Run
  `node src/scripts/backfillAiCachedInputPricing.js --dry-run` then `--apply`.
- A "AI usage uncharged — cached_input_unpriced" health event with no wallet
  charge → same cause; the request was correctly **not** billed. Add the rate,
  then decide whether to raise a manual wallet adjustment for the untracked
  usage (event id in the metadata).
- wallet delta ≠ `final_cost_inr` → do NOT widen rollout. Capture the
  `ai_token_usage` + `billing_ledger` rows and the raw usage, open a billing
  incident, and revert the tenant to a non-cached model.

## 8. Wallet deduction

- Make one real generation request as a prepaid tenant with a small balance.
- **Expected DB records:** `ai_token_usage` (`billed: true`), `billing_ledger`
  (`entry_type: ai`, `billing_status: charged`), wallet balance decreased by
  `final_cost_inr`.
- **Pass:** balance delta == `final_cost_inr` (rounded to 6 dp).
- **Recovery:** insufficient balance → `billing_status: insufficient_balance`,
  usage recorded `billed: false`, `insufficient-balance` socket event.

## 9. Ledger snapshot

- Inspect the `billing_ledger` + `ai_token_usage` rows from §8.
- **Expected fields:** `pricing_version`, `markup_percent`, `usd_to_inr_rate`,
  `base_cost_usd`, `final_cost_usd`, `final_cost_inr`, `requested_model`,
  `actual_model`, `pricing_model`, `pricing_rule_id`, `endpoint`,
  `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`.
- **Pass:** `pricing_version` matches the rule at request time; historical rows
  never change when the rule is later edited.

## 10. Fallback test

- Set `ai_settings.output_fallback_model` to an eligible model, then deactivate
  the tenant's primary `output_model` in the catalog.
- **Expected:** next request resolves to the fallback; `ai_token_usage` /
  ledger `fallback_reason` is set (e.g. `AI_MODEL_UNAVAILABLE`);
  `ai_settings.output_model` in the DB is **unchanged**.
- **No eligible fallback:** controlled `AI_MODEL_UNAVAILABLE` error, no charge.

## 11. Deactivation test

- Model Catalog → *Deactivate* a model in use.
- **Expected:** `ai_pricing.is_active = false`; `ai_model_catalog.activated_at`
  cleared; `admin_audit_log` row; caches invalidated; frontend catalog + pricing
  + available-models queries refetch.
- **History:** existing `ai_token_usage` / `billing_ledger` rows unchanged.

## 12. Rollback to previous tenant model

- Organizations → edit the tenant → set input/output model back to a verified
  legacy model → Save.
- **Expected:** backend `validateAiModelSelections` accepts the change (legacy
  model, unchanged-or-eligible); `ai_settings` updated; `invalidateOpenAIClient`
  fires.
- **Pass:** next request uses the reverted model; wallet/ledger continue normally.

---

## General pass/fail

| Signal | Meaning |
|---|---|
| `test_status = passed` | model is live-tested and activatable |
| `test_status = legacy_grandfathered` | in use, never live-tested — run §1 before re-activating or assigning to a new tenant |
| `test_status = failed` | do not activate; fix the profile / access and re-test |
| `billing_failure` "AI usage uncharged" | provider request succeeded, wallet **not** charged — reconcile per `deployment-and-rollback.md` |
| `AI_TARIFF_UNSUPPORTED` / `CACHED_INPUT_RATE_MISSING` | pre-request block — the model can be cache-served but its rule has no cached rate. Run the backfill. |
