# Workers reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Cloudflare infrastructure

**KV tooling note:** Wrangler v4 `kv key list` returns `[]` — use Cloudflare REST API directly
for KV reads during development. Cloudflare MCP `kv_list` / `kv_get` tools also work.

**Worker-to-Worker calls:** Same-account Workers MUST use a **Service Binding**, NOT a workers.dev URL. Cloudflare blocks W2W subrequests via workers.dev at the edge — they are silently never delivered (wrangler tail shows zero events). Admin API → materials-sync uses binding `MATERIALS_SYNC_WORKER` (declared in admin-api wrangler.toml `[[services]]`). Any new Worker-to-Worker call must follow the same pattern.

**KV key format:** `client:{uuid}`, `slug:{slug}` → uuid, `clerk_org:{orgId}` → uuid (reverse index — written by admin-api webhook handler on org.created, and by materials-sync `handleStoreToken` as a safety fallback). The clerk_org reverse index is required by `/onboarding/sm8-prefill`, `/onboarding/photos`, and `/onboarding/provision` to find the uuid from the JWT org_id.

### KV records (audited 2026-05-30)

| Key | UUID | Status | Used by |
|-----|------|--------|---------|
| `slug:andy` | → `0e604a45-84fd-4789-a2cb-662bcba51a8b` | Active | slug resolution |
| `client:0e604a45-84fd-4789-a2cb-662bcba51a8b` | Andy's Rafter record | **Active — form uses this** | index.html, Make, rafter-pdf |
| `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b` | **KV record DELETED 2026-06-07** (RFT-83) — UUID retains safety status per CLAUDE.md safety table | — | — |

**`0e604a45-…` is the KV record the form actually reads.** `448e12a8-…` is not a Rafter client UUID — see the CLAUDE.md safety table for the current understanding (2026-06-07 BVT trace, RFT-80). The KV record at that key was an orphaned dev duplicate (hybrid contents per RFT-83) and was deleted 2026-06-07 after KV-read clarification confirmed no readers or writers remained. The UUID itself remains a safety-flagged value — never create another client record at this key.

### KV record contents (`client:0e604a45-…` — verified clean 2026-05-30)

- `uuid`, `company_name` ("2 Men and a Shovel"), branding
- `payment_thresholds`: 6-tier — `under_20k` (50/50), `20k_to_35k` (20/60/20), `35k_to_50k` (5/45/45/5), `50k_to_100k` (5/31/31/31/2), `100k_to_200k` (5/27/22/22/22/2), `over_200k` (5/21/18/18/18/18/2). Boundary: `<=` so $20,000 falls in tier 1, $20,001 in tier 2.
- `proposal_types`: `["LC", "GM"]`
- `job_categories`: `["Garden Maintenance", "Landscaping"]`
- `job_queues`: `["Leads - New", "Leads - Postponed", "Quotes - Accepted"]`
- `templates`: 24 items (name + text fields)
- `phone`, `business_address`, `abn`, `business_email`, `credentials[]` (16), `terms_and_conditions[]` (10)
- `staff_uuid`: `fe62e877-7a15-4a31-aac7-f670c78ef0ab` (Andrew Little)
- `operator_email`: `willthurlow73@gmail.com` (Will — intentional for now)
- `logo_url`: `https://rafter-materials-sync.will-8e8.workers.dev/logo/0e604a45-84fd-4789-a2cb-662bcba51a8b`
- `webhook_url`: `https://hook.eu1.make.com/oh8gh9i7cdadlmmcyh3ypeep1x1n9jd4` (prod Rafter Form scenario)
- `email_template`: Andy's logo + correct merge fields (`{client_name}`, `{job_address}`)
- `access_token`, `refresh_token`, `expires_at`, `token_updated_at` (OAuth — auto-refreshed)
- `clerk_org_id`: `org_3EnbpxAJBMUgMQSzhfBn7OIs5j0` (Andy's Clerk org — bound 2026-06-07 via Path 2)
- `connected_by_user_id`, `connected_at` (RFT-70 Option C — written by admin-api `/onboarding/sm8-callback` on each establish-or-refresh)

## Workers

### rafter-materials-sync

**URL:** https://rafter-materials-sync.will-8e8.workers.dev
**Location:** `workers/materials-sync/`

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Status check |
| `/refresh-materials?uuid={uuid}` | GET | Bearer `RAFTER_WORKER_SECRET` (operational) or HMAC form token (browser) | Sync materials from SM8 to KV — **auth required; CLAUDE.md previously said "None" which was wrong** |
| `/store-token` | POST | Bearer `MAKE_STORE_TOKEN_SECRET` (Make) or `RAFTER_WORKER_SECRET` (admin/Claude Code) | Write OAuth tokens to KV |
| `/client-config?uuid={uuid}` | GET | `x-rafter-secret` | Live client config for Make — returns `access_token`, `staff_uuid`, `email_template`, `company_name`, `phone`, `business_email`, `operator_email`, `logo_url`, `webhook_url`. Called at the top of every Make Rafter Form run. |
| `/render-email` | POST | `x-rafter-secret` | Render email HTML with merge fields `{client_name}`, `{job_address}`, `{quote_ref}`, `{total}`. Returns `{"html": "..."}`. |
| `/client/{uuid}` | GET | None | Sanitised KV record (no tokens) |
| `/materials/{uuid}` | GET | None | Cached materials from KV |
| `/sm8-staff?uuid={uuid}` | GET | None | List active SM8 staff |
| `/sm8-search?uuid={uuid}&q={q}` | GET | None | Search SM8 companies (min 3 chars) |
| `/logo/{uuid}` | GET | None | Serve client logo from R2 |
| `/resolve-slug/{slug}` | GET | None | Resolve URL slug → client UUID |
| `POST /send-test-alert` | POST | Bearer `RAFTER_WORKER_SECRET` | Fire one test Telegram alert — RFT-46 deploy verification |
| Cron `0 10 * * * UTC` | — | — | Nightly: materials sync + Probe 1 (SM8 token) + Probe 2 (Make scenarios) + Probe 3 (recovery components) + heartbeat ping |

**Worker secrets** (`npx wrangler secret put <NAME> --name rafter-materials-sync`):

| Secret | Purpose |
|--------|---------|
| `MAKE_STORE_TOKEN_SECRET` | Bearer token for `/store-token` — **used by Make Account Discovery only**. Rotate independently of `RAFTER_WORKER_SECRET`. **⚠️ Whenever this is rotated, the Make Account Discovery scenario HTTP module must be updated in the Make UI with the new value — if Make and the worker diverge, setup will fail with 500 and clients cannot re-authenticate.** |
| `RAFTER_WORKER_SECRET` | Bearer token for `/store-token` (admin/Claude Code fallback) and admin-api→`/refresh-materials`. Rotating this does NOT require a Make update. |
| `RAFTER_INTERNAL_SECRET` | Header auth (`x-rafter-secret`) for `/client-config` and `/render-email` (called by Make Rafter Form). **Must be provisioned on every new Worker deploy.** |
| `SERVICEM8_CLIENT_SECRET` | SM8 OAuth client secret for token refresh |
| `MAKE_API_TOKEN` | Make API token for Probe 2 (scenario status) and Probe 3 (Account Discovery logs). **Source of truth: Cloudflare Worker secret** — was incorrectly referenced as "in .env" in RFT-31 epic. Value lives on the Worker only; no local .env file. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alert channel (RFT-31). Stored via @BotFather. |
| `TELEGRAM_CHAT_ID` | Telegram chat/group ID that receives probe alerts (RFT-31). |
| `HEARTBEAT_URL` | healthchecks.io ping URL — **pending setup by Will**. Create check at healthchecks.io (free, 20 checks), set period=1d grace=2h, copy ping URL, then `npx wrangler secret put HEARTBEAT_URL --name rafter-materials-sync`. |

**Secret rotation checklist — `MAKE_STORE_TOKEN_SECRET`:**
1. `npx wrangler secret put MAKE_STORE_TOKEN_SECRET --name rafter-materials-sync` (new value)
2. Open Make Account Discovery scenario → HTTP module that POSTs to `/store-token` → update `Authorization: Bearer` value
3. Test: run setup flow end-to-end and confirm callback shows "Setup complete"

**SM8 token freshness invariant:** Every handler that returns `access_token` or calls SM8 MUST call `refreshTokenIfNeeded(uuid, env)` first. The nightly cron is a safety net only — Make calls `/client-config` at the top of every form scenario and relies on a valid token. Violating this invariant caused BUG-23. See `INVARIANT` comment at `workers/materials-sync/index.js:549`.

### rafter-pdf

**URL:** https://rafter-pdf.will-8e8.workers.dev
**Location:** `workers/pdf/`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/generate?mode=preview` | POST | Generate PDF, return binary |
| `/generate?mode=submit` | POST | Generate PDF → POST multipart to `client.webhook_url` (Make Rafter Form webhook). Returns 400 if `webhook_url` not in KV. |

**Required wrangler flags:**
```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"
```

PDF font, photo compression, and preview loading-screen constraints — see [pdf-spec.md](pdf-spec.md).

### rafter-admin-api (NEW v2.0)

**URL:** https://rafter-admin-api.will-8e8.workers.dev
**Location:** `workers/admin-api/`
**Status:** Fully operational as of 2026-06-05. Connect-first onboarding flow complete: SM8 OAuth → prefill → review → provision → photo upload. All routes live. Clerk webhook (`organization.created`) verified end-to-end. pdf_attach smoketest currently 403 — `publish_job_attachments` scope not yet in trial grant (deferred to RFT-32 re-auth). CLERK_SECRET_KEY set. sign-up.html live.

**Bindings:** KV (`RAFTER_CLIENTS`), R2 (`RAFTER_ASSETS`), D1 (`RAFTER_EVENTS`), Service Binding (`MATERIALS_SYNC_WORKER` → `rafter-materials-sync`), Service Binding (`PDF_WORKER` → `rafter-pdf`). The service bindings are required for Worker-to-Worker calls — see W2W note in Cloudflare infrastructure section.

**REQ-On-32 (trigger materials sync):** Admin API calls materials-sync via `MATERIALS_SYNC_WORKER` service binding, not HTTP. Auth still uses `RAFTER_WORKER_SECRET` bearer token (materials-sync `/refresh-materials` checks it regardless of call path).

**Route classes (auth pattern locked — RFT-25):**

| Route class | Auth | Callers |
|-------------|------|---------|
| `POST /webhooks/clerk` | Svix HMAC-SHA256 (`CLERK_WEBHOOK_SECRET`) | Clerk server-to-server only |
| `/admin/*` | Bearer `RAFTER_ADMIN_SECRET` | Claude Code / MCP — not browser-reachable |
| `POST /onboarding/*` | Clerk JWT (networkless via `CLERK_JWT_KEY`) | `onboarding.html` browser session |

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhooks/clerk` | POST | Receive Clerk org lifecycle events |
| `/admin/clients` | POST | Provision new client KV record |
| `/admin/clients` | GET | List all clients and status |
| `/admin/clients/{uuid}/verify` | POST | Run end-to-end health check (smoketest) |
| `/admin/clients/{uuid}/sync` | POST | Trigger materials sync |
| `/admin/clients/{uuid}/rotate-secret` | POST | Rotate client auth token |
| `/onboarding/provision` | POST | Browser-initiated provisioning (Clerk JWT scoped to org) |
| `/onboarding/verify` | POST | Browser-initiated smoketest trigger |
| `/onboarding/sm8-prefill` | GET | Fetch vendor.name/abn_number/billing_address + job templates + active staff from SM8 in one call |
| `/onboarding/abn-lookup` | GET | Live ABN validation via ABR SearchByABNv202001 SOAP API (ABR_GUID secret) |
| `/onboarding/photos` | POST | Upload single photo: multipart file+category → Canvas-pre-resized 400px/JPEG q0.78 → R2 `clients/{uuid}/photos/{category}/{filename}` |

**Called by:** Clerk webhook (`/webhooks/clerk`), Claude Code via MCP (`/admin/*`), `onboarding.html` (`/onboarding/*`).
**Not called by:** `index.html`, any other client-facing surface.

**Worker secrets** (`npx wrangler secret put <NAME> --name rafter-admin-api`):

| Secret | Purpose | Status |
|--------|---------|--------|
| `CLERK_WEBHOOK_SECRET` | Svix signing secret for `/webhooks/clerk` | Set 2026-05-30. **Rotated 2026-05-30** — original value was echoed to terminal via `Object.keys(env)` diagnostic log during RFT-24; new secret generated in Clerk Dashboard before close. |
| `RAFTER_ADMIN_SECRET` | Bearer token for `/admin/*` routes | Set 2026-05-30 |
| `CLERK_SECRET_KEY` | Clerk Backend API key — used by subscription_gate smoketest (GET /v1/organizations) and any future Clerk API calls | **Set 2026-05-31** |
| `RAFTER_WORKER_SECRET` | Bearer token for admin-api→materials-sync calls to `/refresh-materials`. **Same value as on materials-sync.** Required for sync and token_fresh smoketest assertion. | **Set 2026-05-31** (rotated on same date — previous value unknown, new value set on both workers simultaneously) |
| `CLERK_JWT_KEY` | PEM public key for networkless Clerk JWT verification (REQ-On-05) | **Set 2026-05-31** — RSA public key derived from JWKS at `https://first-kiwi-3.clerk.accounts.dev/.well-known/jwks.json` (decoded from publishable key `pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ`) |
| `ABR_GUID` | Australian Business Register API GUID for ABN lookups (`/onboarding/abn-lookup`) | Never hardcode, never log. Stored as Worker secret only. |
