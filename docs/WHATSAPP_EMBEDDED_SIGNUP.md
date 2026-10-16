# WhatsApp Embedded Signup + Business App Coexistence

Additive feature. **Default OFF for every organization** — an organization with no
flags set behaves exactly as before (manual Cloud API credentials).

## Connection types

| Type | Meaning | How it is set |
| --- | --- | --- |
| `LEGACY_MANUAL` | Existing manual Cloud API connection | Read as the fallback for `whatsapp_accounts.whatsapp_connection_type IS NULL`. No row is rewritten. |
| `EMBEDDED_STANDARD` | Meta Embedded Signup, Cloud API number | Embedded Signup completion |
| `EMBEDDED_COEXISTENCE` | Meta Embedded Signup, existing WhatsApp Business App number + Cloud API | Embedded Signup completion |

## Feature flags (Super Admin)

`tenants.embedded_signup_enabled`, `tenants.coexistence_enabled` (both default `0`).

- Coexistence is only effective when Embedded Signup is on. Turning Embedded Signup off clears coexistence.
- Changing a flag **never** touches `whatsapp_accounts` / `tenant_secrets` — an established connection keeps working.
- Only `super_admin` can write (`PATCH /api/management/tenant/:tenantId/whatsapp-capabilities`); `platform_admin` can read.
- Writes are recorded in `admin_audit_log` (`whatsapp_capability_change`, before/after state).
- Every flag is re-checked server-side on `start` **and** `complete`.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/whatsapp/whatsapp-account/onboarding-config` | tenant admin/staff | Which options the Settings page may show (no secrets) |
| POST | `/api/whatsapp/whatsapp-account/embedded-signup/start` | tenant admin | Server gate + launch params (app id, config id, extras) + signed 30-min session token |
| POST | `/api/whatsapp/whatsapp-account/embedded-signup/complete` | tenant admin | Code exchange, validation, subscription, atomic persist |
| GET/PATCH | `/api/management/tenant/:tenantId/whatsapp-capabilities` | management | Read / (super_admin) write flags |

`GET /api/whatsapp/whatsapp-account` additionally returns `whatsapp_connection_type` (additive key).

## Environment variables

**One Meta app, ONE Embedded Signup Login Configuration, both modes.** Templates: `invictus-chatbot/.env.example` and `Whatnexus-frontend/.env.example` (placeholders only).

Backend (required for Embedded Signup — checked lazily per request, never at boot, so tenants that don't use it are unaffected):

| Variable | Notes |
| --- | --- |
| `WHATSNEXUS_META_APP_ID` | Provider Meta app id. |
| `WHATSNEXUS_META_APP_SECRET` | **Backend only.** Never sent to the browser, never logged. |
| `WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID` | The single Embedded Signup configuration (Standard **and** Coexistence). |
| `WHATSNEXUS_META_GRAPH_API_VERSION` | Optional. Falls back to the project-wide `META_API_VERSION`, then `v25.0`. |

Reserved (documented for the provider setup; **not read by the code yet**): `WHATSNEXUS_META_BUSINESS_ID`, `WHATSNEXUS_META_SYSTEM_USER_ID`, `WHATSNEXUS_META_SYSTEM_USER_ACCESS_TOKEN`, `WHATSNEXUS_META_WEBHOOK_VERIFY_TOKEN`. (Existing client webhooks keep their per-tenant verify tokens.)

Frontend (optional, browser-safe): `NEXT_PUBLIC_WHATSNEXUS_META_APP_ID`, `NEXT_PUBLIC_WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID`. The backend `start` response is authoritative (the App Secret that exchanges the auth code must belong to the app that issued it); when these are set they are only compared with the server's values, and a mismatch disables the buttons with a generic message.

Deprecated / removed:

| Variable | Status |
| --- | --- |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Renamed. Still read as a fallback with a safe warning (variable *name* only, never the value). |
| `META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID` | Removed. Ignored (warning). One configuration serves both modes. |
| `META_APP_ID` / `META_APP_SECRET` | **Not** consumed by Embedded Signup. These names are shared with legacy code (media gallery / templates / campaigns fall back to `META_APP_ID` when a tenant has no `app_id`). If you set them for an earlier Embedded Signup trial, rename them to `WHATSNEXUS_*` and remove them so legacy fallbacks behave as before. |

Customer WABA ids and Phone Number ids are tenant data (database), never environment.

Missing settings → `EMBEDDED_SIGNUP_NOT_CONFIGURED` (503, generic message; the server log names the missing *setting names*, never values), raised at `start`, `complete` and `resume` — before any single-use auth code is spent.

## One configuration, mode-aware Meta Feature Type

| WhatsNexus mode (server-side) | Meta Feature Type | `FB.login` `extras` | Registration |
| --- | --- | --- | --- |
| `EMBEDDED_STANDARD` | None | `{ setup: {}, sessionInfoVersion: "3" }` (no `featureType` key) | standard `/register` |
| `EMBEDDED_COEXISTENCE` | WhatsApp Business App Onboarding | `{ setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }` | **never** |

- The mapping lives in one place: `MODE_FEATURE_TYPE` / `getEmbeddedSignupLaunchConfig()` in `src/config/metaEmbeddedSignup.config.js`.
- The Meta Feature Type only controls Meta's launch behaviour. WhatsNexus stores `connection_type` (`EMBEDDED_STANDARD` / `EMBEDDED_COEXISTENCE`); "None" is never persisted.
- `start` returns only `mode`, `app_id`, `config_id`, `graph_api_version`, `feature_type`, `extras`, `session_token` — no secret. The token is server-signed (tenant + user + mode + expiry + nonce).
- `complete` uses the mode inside the signed session. A `connection_type` in the request body is only a consistency claim: a mismatch is rejected (`MODE_MISMATCH`) before the auth code is spent, and a browser `event` cannot flip the mode.

## Completion rules (backend)

1. Session token (signed with a purpose-derived key, 30 min) must belong to the calling tenant and mode.
2. Flags re-checked. An existing connection is **not** rejected any more: it is classified (see *Phone identity & chat history*). Replacing a working connection requires `confirm_switch: true` (checked *before* the single-use code is consumed).
3. Auth code exchanged server-side; the WABA and phone are resolved *with the new token* (proves the customer authorised them).
4. Number / WABA owned by another organization → 409, never reassigned.
5. `EMBEDDED_STANDARD`: `/register` only if the number is not already a connected Cloud API number; PIN stored encrypted (`tenant_secrets.whatsapp_register_pin`).
6. `EMBEDDED_COEXISTENCE`: **never calls `/register`**; requires the number to already be `CONNECTED`, otherwise `COEXISTENCE_NOT_ELIGIBLE` (422) and nothing changes. The coexistence session event only carries `waba_id`, so the phone is resolved from the WABA.
7. Business number is canonicalized to E.164 and compared with the previous connection server-side (`FIRST_CONNECTION` / `SAME_NUMBER` / `NEW_NUMBER`).
8. `POST /{waba}/subscribed_apps` through the existing `subscribeToWebhookFieldsService`.
9. Single transaction: identity records + account row (`status='active'`) + encrypted token (the superseded token is kept encrypted as `whatsapp_previous`). Any earlier failure persists nothing; an optimistic check aborts if the connection changed meanwhile.

## Phone identity & chat history

**Chat history belongs to organization + canonical business number + contact — never to WABA id / Phone Number id / app id**, which are transport details that can change.

- Before this feature, messages had no business-number identity (they only carried the `phone_number_id` they were sent/received on). Nothing else in the codebase scoped history by number.
- New append-only table `whatsapp_number_identities` maps every transport id (`phone_number_id`) an organization has used to its canonical E.164 business number, and records the decision (`LEGACY_SEED` / `FIRST_CONNECTION` / `SAME_NUMBER` / `NEW_NUMBER`, previous number). It is **empty for every organization that never switches**.
- Numbers are normalized with libphonenumber (`src/utils/businessNumber.js`): `+91 98765 43210`, `919876543210`, `+919876543210` and (with the tenant's calling code) `9876543210` are the same number. If the existing number cannot be canonicalized the switch is refused (`EXISTING_NUMBER_UNVERIFIABLE`) — history is never guessed.

| Result | What happens |
| --- | --- |
| **FIRST_CONNECTION** (no previous row) | Nothing inherited. Empty inbox until traffic arrives. |
| **SAME_NUMBER** | Only transport metadata (WABA, Phone Number id, type, token) changes. All contacts, threads, messages, CRM/lead data, assignments stay. Old and new transport ids are recorded against the one number. |
| **NEW_NUMBER** | Previous history stays in the database, unmodified, but the new number's inbox / AI context show only its own conversations. The previous number's transport ids (plus every id already present on the org's stored messages) are attributed to the previous number. Contacts/CRM stay (organization data). Quality/tier are reset for the new number. Switching back to the earlier number brings its history back. |

Read-side rule (`whatsappNumberScope.*`): a message is hidden from the active number's views **only** if its `phone_number_id` belongs to a *different* business number of the same organization. Applied to the live-chat list, history list, chat list, thread fetch, mark-seen, suggested-reply and AI conversation memory. An organization with no identity rows runs the **original SQL with the original parameters** (tested); the lookup fails open on error. Nothing is deleted or rewritten. The frontend cannot influence the decision.

Not scoped (organization-level analytics, unchanged): dashboards, campaign reports, lead statistics, billing.
Not supported: there is still one active number per organization, and no UI to browse a previous number's archived conversations (they are retained in the DB).

## Webhooks

No routing change. Existing per-tenant URLs and verify tokens are untouched.
New: `smb_message_echoes` (messages sent from the Business App) is handled by an isolated
early branch in `receiveMessage`. It only acts on `EMBEDDED_COEXISTENCE` accounts, dedupes on the
Meta message id (`processed_messages` + a `messages.wamid` check), stores the message as
`sender='admin'`, `sender_id='WhatsApp Business App'`, and emits `new-message` into the same thread.
It does **not** trigger AI, lead scoring or campaigns. `history` and `smb_app_state_sync` remain ignored.

## Rollout order

1. `node migrations/20260921_whatsapp_embedded_signup.js` **before** deploying the code (models now include the new columns; it also creates `whatsapp_number_identities`).
2. Deploy backend, then frontend.
3. Set env vars; complete the Meta dashboard steps below.
4. Enable flags for the pilot organization only.

## Rollback

- Turn the organization's flags OFF (UI hides the options; server refuses `start`/`complete`). Existing connections keep working.
- Code rollback is safe with the migration left in place (all new columns are nullable/defaulted and unused by old code).
- `node migrations/20260921_whatsapp_embedded_signup.js down` removes the new columns. **Only run it after the flags are off and no `EMBEDDED_*` connection exists**, otherwise those rows lose their type (they would be read as `LEGACY_MANUAL` and echoes would stop being ingested). `down` keeps `whatsapp_number_identities` if any `NEW_NUMBER` decision exists (dropping it would re-expose the old number's history under the new one).
- Reverting a switch: the superseded credentials are in `tenant_secrets` type `whatsapp_previous` (encrypted) and the previous transport ids in `whatsapp_number_identities`; restoring is a support operation, not automatic.

## Manual QA checklist

A. **Existing client** — log in, open WhatsApp Settings (unchanged), send + receive a message, check templates and delivered/read statuses. *No change.*
B. **BirthWave, flags OFF** — current Settings only; no "Connect WhatsApp" card.
C. **BirthWave, Embedded Signup ON** — "Connect WhatsApp" with "Set up WhatsApp with Meta" appears (only when no connection exists).
D. **BirthWave, coexistence ON** — "Connect Existing WhatsApp Business App" also appears; hidden when OFF.
E. **Cancel / fail** — close the Meta popup → CANCELLED; existing data untouched; retry works. Try an expired code → clear error, nothing persisted.
F. **Success** — WABA id, phone id and display number saved; `whatsapp_connection_type` correct; status `active`; `GET /{waba}/subscribed_apps` lists the app; inbound message appears once; reply sends via Cloud API; delivered/read update; message visible only under BirthWave.
G. **Coexistence** — WhatsApp Business App still works; a message sent from the app appears in WhatsNexus as an admin message, once (retry the webhook to confirm idempotency).
H. **Restart / re-login** — no reconnect needed. Disable flags — connection unaffected.
H2. **Same number** — legacy client with history, complete Embedded Signup with the same number: confirm box required; all chats/contacts remain; new messages continue the same thread; no duplicate contact.
H3. **Different number** — previous chats no longer appear in the inbox / suggested replies; database rows intact (`SELECT COUNT(*) FROM messages WHERE tenant_id=…` unchanged); new messages appear only for the new number.
H4. **New organization** — inbox empty; nothing from any other organization.
I. **Security** — no token / secret in responses, network tab, console or logs (`complete` request bodies are not logged by the axios helper and are never auto-retried).

## Meta dashboard — must be done manually

1. **App**: use a Meta app that is a **Tech Provider** (or Solution Partner) for production; a development-mode app + app roles is enough for the pilot. Advanced access / App Review for `whatsapp_business_management` and `whatsapp_business_messaging`, and business verification, are Meta's requirements — nothing here bypasses them.
2. **Facebook Login for Business → Configurations**: create ONE WhatsApp Embedded Signup configuration on **Embedded Signup v4** (v2 is scheduled for deprecation on 2026-10-15). Its id is `WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID`. The WhatsApp Business App onboarding (coexistence) option is selected at launch through the Feature Type; a second configuration is only needed if live testing proves this one cannot serve both modes.
3. **Facebook Login settings**: allow JavaScript SDK login and add the WhatsNexus frontend domain(s) to the allowed domains.
4. **Webhooks**: callback URL `https://<backend>/api/whatsapp/webhook/<TENANT_ID>` with that tenant's existing verify token. Subscribe fields: `messages`, `message_template_status_update`, `phone_number_quality_update`, `business_capability_update`, **`smb_message_echoes`** (and optionally `history`, `smb_app_state_sync`).
5. Put `WHATSNEXUS_META_APP_ID`, `WHATSNEXUS_META_APP_SECRET`, `WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID` in the backend environment (see `.env.example`).

## Manual Meta validation (single configuration) — staging only

Automated tests never contact Meta. Confirm each of these live:

**STANDARD**
1. Super Admin enables *Embedded Signup* for the pilot org (Coexistence may stay off).
2. Open WhatsApp Settings → only "Set up WhatsApp with Meta" is offered.
3. Click it; in the browser network/console confirm the launch uses the single config id and **no** `featureType` in `extras`.
4. Confirm the Meta popup behaves as Feature Type *None* (normal number add/verify).
5. Complete with a Meta test number. Confirm the session event carries `waba_id` and `phone_number_id`.
6. Confirm exactly one `/register` call, then `subscribed_apps`, then the account is `active` with `whatsapp_connection_type = EMBEDDED_STANDARD`.
7. Send a message, receive one, confirm delivered/read statuses arrive on the tenant webhook.

**COEXISTENCE**
1. Enable *Coexistence* for the pilot org.
2. Click "Connect Existing WhatsApp Business App"; confirm the **same** config id and `featureType: "whatsapp_business_app_onboarding"` in `extras`.
3. Confirm Meta launches the WhatsApp Business App onboarding flow (QR / existing-app screens), not the plain number-add flow.
4. Complete with an eligible Business App number. Confirm the session event is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` with a `waba_id`.
5. Confirm **no** `/register` request was made (backend log / Meta request log), `subscribed_apps` succeeded, and `whatsapp_connection_type = EMBEDDED_COEXISTENCE`.
6. Confirm the mobile WhatsApp Business App still works, Cloud API sending works, a message sent from the phone appears in WhatsNexus (`smb_message_echoes`), and statuses arrive.

**If either mode behaves unexpectedly** (e.g. the popup ignores the runtime Feature Type and follows a Feature Type fixed inside the configuration): that is the one thing live Meta testing can prove wrong. Do not change WhatsNexus logic; create a second configuration in the builder and reintroduce a per-mode config id (the launch resolver is the only place to change).

## Known limitations / follow-ups

- **One Embedded Signup Meta app per deployment** (env). App secrets are not stored per tenant today. `getEmbeddedSignupConfig()` is the single seam for a per-organization app later.
- **Webhook URL is tenant-scoped** (`/webhook/:tenantId`) and GET verification needs the tenant id, so one Embedded Signup app serving several organizations needs a follow-up decision (out of scope: "no global webhook migration"). Messages for a different tenant on a tenant-scoped URL are ignored.
- Coexistence **history / contacts sync** (`POST /{phone}/smb_app_data`, must be requested within 24 h of onboarding) is not implemented — only live `smb_message_echoes`.
- Pre-existing, unchanged: the webhook POST has no `X-Hub-Signature-256` verification. Worth a separate hardening task.
- Legacy connections are never migrated automatically: the option is shown only to a tenant admin of an org with Embedded Signup enabled, behind an explicit confirmation.
- If a legacy client manually edits its Phone Number ID in the old Settings form, that legacy flow has no identity tracking; the switch above attributes all transport ids found on their stored messages to the number that was connected at switch time.
- The scope is computed per request (no caching), so it is consistent across server instances.
