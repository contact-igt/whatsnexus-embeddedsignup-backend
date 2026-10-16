# Dynamic AI catalog work plan

## Baseline

Both repositories contain existing uncommitted changes. Preserve course/session, invoice, theme, tabs, dashboard, appointment, query-client, and tenant-feature-access changes. No production data or secrets will be modified and no live generation tests will run automatically.

Verified: Sequelize/MySQL registration is in `src/database/index.js`, associations in `src/database/associations.js`, table names in `src/database/tableName.js`. Migrations are standalone additive scripts. The app starts node-cron jobs in `src/app.js`. Management routes use existing authenticate/authorize middleware. AI prices are cached in `costEstimator.js`; selected active models and credentials have separate five-minute caches. AI usage writes and wallet deductions/cycle totals are handled by `trackAiTokenUsage.js` within the existing ledger architecture. The Jest configuration targets `tests/`, which currently does not exist; existing root tests and utility checks coexist.

## Reviewable stages

1. Catalog/pricing: validated profiles, discovery and sync records, additive migration, pending discovery, review/test/activation gates, versioned inactive pricing, audit and cache invalidation. Unit tests mock providers/storage.
2. Runtime/billing: profile-driven Chat Completions and Responses adapters, normalized usage, exact pricing snapshots, tenant access isolation, shared vision, explicit fallbacks. Preserve wallet/ledger transactions and source routing.
3. Frontend: dynamic admin catalog, existing pricing form integration, purpose/tenant query keys, unavailable saved selections, explicit test/activation controls.
4. Scheduler: daily discovery invoking the tested sync service, distributed concurrency guard, no activation or generation. Finish with migration checks, backend tests, frontend lint/types/build, diff review, and delivery/rollback report.

## Deployment decision

User selected strict rollout after reviewing all existing models. No legacy bypass or automatic approval. Existing choices/pricing remain stored unchanged; deployment preflight must identify unresolved existing models before strict runtime rollout. Catalog administration must be deployed and used first.

## Test constraints

Use mocked SDK tests only. Do not run the backend application or migrations against configured databases: startup invokes schema synchronization. Live compatibility testing remains an explicit admin action. Validate migration structure without executing it against production.
