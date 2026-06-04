# CLAUDE.md — Rafter Platform

@docs/claude-code-tuning.md

> **⚠️ SESSION-START PROTOCOL — do this before reading anything else, every session, every machine.**
>
> This file is canonical **only on `origin/main`**. The copy on your disk is a *reader*, never a master.
> A working tree that is behind origin, or has uncommitted edits to this file, is NOT to be trusted or written from.
>
> **At the start of every Claude Code session, before reading the rest of this file or touching any resource:**
> 1. `git fetch && git status` — confirm you are on `main` and **0 commits behind**. If behind, `git pull --ff-only` to current.
> 2. If the working tree is dirty (`git status` shows modified/deleted files), STOP and resolve before working — do not build on or around uncommitted changes. Report the dirty state to Will.
> 3. Re-read this file *after* syncing. The UUID table below is safety-critical; a stale copy has caused live-data risk before (the 2026-05-28 incident). Confirm the three-UUID table is present before any KV/SM8/Cloudflare operation.
>
> **One writer, many readers.** This file is edited only by commit-and-push to `origin/main`. Never as an uncommitted local-only change, never by hand-editing a Drive/laptop copy. Every machine (desktop, laptop) and both surfaces (Claude Code reads it from the repo; Claude Chat reads it via the GitHub connector or a current paste) read the *same* origin copy. If you find yourself with a second editable copy, that copy is the bug — delete it or make it a read-only mirror.
>
> **Why this protocol exists:** on 2026-05-30 a Code session was found 69 commits behind origin, working from a pre-2026-05-28 CLAUDE.md whose UUID table was stale — it labelled `448e12a8-…` as the dev/trial instance when that UUID is actually an orphaned record on Andy's live SM8 vendor identity. Building from that copy would have routed "dev" writes to Andy's live data. The cause was a working tree allowed to drift and be edited. This protocol removes the ability for that to happen silently.
>
> Read this file at the start of every Claude Code session — it contains everything needed to work on Rafter without a context dump. Do not make assumptions about endpoints, UUIDs, or configuration values — they are all here or flagged as requiring verification.
>
> **Version 2.0 — Updated May 2026.** Major changes: Clerk auth + billing, Admin API Worker,
> D1 event logging, central dashboard, Linear issue tracking. See change summary below.
>
> **Companion doc: `TRADIE.md` (repo root)** — target-user persona and design/appraisal lens. Consult for any user-facing product decision.

---

## ⚠️ CRITICAL SAFETY RULE

**NEVER use Andy's live ServiceM8 instance UUID during development or testing.**

| Instance | UUID | Role | Use |
|----------|------|------|-----|
| **Trial (DEV/TEST)** | `010895db-e06c-465d-bce9-2424477be15b` | Will's thurlow.net SM8 vendor UUID | All development — `slug:dev` resolves here. **Provisioned 2026-05-30: KV record created, OAuth done, 114 materials synced.** |
| **Andy's KV record** | `0e604a45-84fd-4789-a2cb-662bcba51a8b` | Active KV key — `slug:andy` resolves here | The record the form reads. Production — explicit sign-off required for any write. |
| **Andy's SM8 vendor UUID** | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` | SM8 API identity (vendor.json) | SM8 API calls use this as the account identity. KV record at this key is an orphaned duplicate — do not use. |

If you are about to write code that references the live UUID, stop and confirm with Will first.

### Incident note — 2026-05-28: UUIDs were documented swapped

CLAUDE.md v2.0 (and the rafter-continuation-prompt before it) had these two UUIDs reversed. The UUID labelled "Trial" (`448e12a8-…`) is actually **Andy's live**, and the UUID labelled "Andy's live" (`010895db-…`) is actually the trial. Discovered via SM8 OAuth `/vendor.json` traces from Make scenario `5612449` runs on 2026-05-28.

Consequence: every prior "dev/test" call against `448e12a8-…` — every KV write, every materials sync, every PDF preview, every Worker deploy verified against that UUID — has been hitting Andy's live SM8 instance. The KV record at `448e12a8-…` contains Andy's real branding, real materials (117 items), real customer list. The "trial KV record" referenced throughout this document up to v2.0 *is* Andy's live record.

**Dev environment provisioned 2026-05-30.** `slug:dev` → `010895db-…` KV record, OAuth complete (will@thurlow.net), 114 materials synced, dev Make scenario 5962197 active. Use `rafter.deepgreensea.au/dev` for all development and testing. Treat `448e12a8-…` as production for any write operation.

**KV audit — completed 2026-05-30:** The active record (`client:0e604a45-…`) was audited and is clean — correct prod webhook, Andrew Little staff_uuid, Andy's logo, 6-tier payment thresholds, 24 templates, correct credentials/T&Cs. The orphaned record (`client:448e12a8-…`) has stale dev values but is not used by the form.

---

## What Rafter is

Rafter is an AI-assisted quoting and operations platform for Australian tradespeople, built by
Deep Green Sea Pty Ltd (Will Thurlow). It generates branded PDF quotes from a web form,
creates jobs in ServiceM8, and attaches the PDF to the SM8 job via the two-step SM8 Attachment API.

**First client:** Andy — 2 Men and a Shovel, Melbourne landscaper.
**Operator email (Andy's SM8):** will@deepgreensea.au
**Trial email:** will@thurlow.net
**GitHub:** shikaishi/Rafter
**Hosting:** `workers/rafter` Worker with Assets at rafter.deepgreensea.au (custom domain binding — deploy manually from `workers/rafter/`)
**Issue tracking:** Linear — https://linear.app/deepgreensea · Team: Rafter · Issue prefix: RFT

---

## v2.0 changes — session May 2026

| Area | Change |
|------|--------|
| Auth | Clerk organisations replace URL-as-password. One Clerk org per client. JWT validated at Worker edge. |
| Billing | Clerk Billing + Stripe. Plans in Clerk dashboard. Subscription state gates Worker access. |
| Onboarding | Clerk session task flow → onboarding.html intake → Admin API provisions KV. Replaces manual checklist. |
| Admin API | New Worker: privileged surface for provisioning, verification, sync, secret rotation. Claude Code operates against this. |
| D1 | rafter-events database: submissions + events tables. 90-day retention. Feeds dashboard. |
| Dashboard | New: rafter.deepgreensea.au/dashboard. Business view + tech/ops view. |
| Build agent | Claude Code + Cloudflare MCP (89 tools) + GitHub MCP (42 tools) + Linear MCP (35 tools). |
| Issue tracking | Linear replaces Google Sheets issue tracker. |
| Make.com | Retained as-is. Replacement deferred — separate future decision. |
| Security model | Per-client Clerk org replaces "know the URL". |

---

## Repository structure

```
/ (repo root)
└── workers/
    ├── rafter/              # Site Worker — Worker with Assets, rafter.deepgreensea.au
    │   ├── wrangler.toml    # custom_domain = rafter.deepgreensea.au
    │   ├── index.html       # Quoting form (operator-facing)
    │   ├── setup.html       # SM8 OAuth initiation
    │   ├── callback.html    # OAuth callback
    │   └── onboarding.html    # NEW v2.0 — browser intake form, posts to /onboarding/provision
    ├── materials-sync/      # rafter-materials-sync Worker
    │   ├── wrangler.toml
    │   └── index.js
    ├── pdf/                 # rafter-pdf Worker
    │   ├── wrangler.toml
    │   └── index.js
    └── admin-api/           # rafter-admin-api Worker (NEW v2.0 — stub deployed, provisioning TBD)
        ├── wrangler.toml
        ├── package.json
        └── index.js
```

**CRITICAL:** Never put wrangler.toml at repo root. All Workers deploy manually:
`cd workers/<name> && npx wrangler deploy`. The site is served by `workers/rafter/` (Worker with
Assets, custom domain binding in wrangler.toml). No git auto-deploy is active — the Pages project
build command is `exit 0`.

---

## Cloudflare infrastructure

| Resource | Name / ID |
|----------|-----------|
| Site Worker | `rafter` — rafter.deepgreensea.au (custom domain, Worker with Assets) |
| R2 bucket | `rafter-assets` |
| KV namespace | `RAFTER_CLIENTS` |
| KV namespace ID | `7c7ad02d8136452eb6d03d1af89a684f` |
| wrangler.toml binding | `binding = "RAFTER_CLIENTS", id = "7c7ad02d8136452eb6d03d1af89a684f"` |
| D1 database | `rafter-events` — ID `39f38376-d163-439b-984d-2f0889e88d56` (built 2026-05-31) |
| D1 database | `rafter-quotes` — quote payload persistence for edit/versioning (RFT-32). ID: TBD on creation (RFT-36). Durable retention — NOT on the `rafter-events` 90-day prune. |

**KV tooling note:** Wrangler v4 `kv key list` returns `[]` — use Cloudflare REST API directly
for KV reads during development. Cloudflare MCP `kv_list` / `kv_get` tools also work.

**Worker-to-Worker calls:** Same-account Workers MUST use a **Service Binding**, NOT a workers.dev URL. Cloudflare blocks W2W subrequests via workers.dev at the edge — they are silently never delivered (wrangler tail shows zero events). Admin API → materials-sync uses binding `MATERIALS_SYNC_WORKER` (declared in admin-api wrangler.toml `[[services]]`). Any new Worker-to-Worker call must follow the same pattern.

**KV key format:** `client:{uuid}` and `slug:{slug}` → uuid

### KV records (audited 2026-05-30)

| Key | UUID | Status | Used by |
|-----|------|--------|---------|
| `slug:andy` | → `0e604a45-84fd-4789-a2cb-662bcba51a8b` | Active | slug resolution |
| `client:0e604a45-84fd-4789-a2cb-662bcba51a8b` | Andy's Rafter record | **Active — form uses this** | index.html, Make, rafter-pdf |
| `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b` | Andy's SM8 vendor UUID | Orphaned — not used by form | — |

**`0e604a45-…` is the KV record the form actually reads.** `448e12a8-…` is Andy's SM8 vendor UUID (confirmed via vendor.json 2026-05-28) but the KV record at that key was set up as a dev duplicate and has stale values (dev webhook_url, wrong staff_uuid, Rafter logo). Do not use it.

### KV record contents (`client:0e604a45-…` — verified clean 2026-05-30)

- `uuid`, `company_name` ("2 Men and a Shovel"), branding, `r2_photo_path`
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
- `clerk_org_id` (NEW v2.0 — added at onboarding time)

---

## Clerk (NEW v2.0)

**Purpose:** Identity, onboarding gate, billing. Replaces URL-as-password security model.
**Integration:** Cloudflare Workers validate Clerk JWTs at edge before serving any protected page.

### Org model
- One Clerk Organisation per Rafter client
- Clerk org ID stored in KV record: `clerk_org_id` field
- Roles: `admin` (client owner) + `member` (staff) — embedded in JWT, no extra network call
- Subscription state embedded in JWT — Worker checks on every request

### Onboarding flow (Flow E)
1. Client signs up at rafter.deepgreensea.au/sign-up — magic link, no password
2. Clerk session task flow prompts org creation
3. Clerk webhook fires `org.created` → Admin API triggered
4. Client completes onboarding.html intake form (ABN, branding, payment thresholds, etc.)
5. Admin API writes KV record, uploads logo to R2, triggers materials sync, runs verification
6. **SM8 OAuth (unavoidable human step)** — client must click Authorise in SM8 (Flow D)
7. Verification pass → Clerk public metadata marks onboarding complete → client lands on quoting form

**Onboarding — client-facing surfaces that require KV fields to be correct before go-live:**
- `logo_url` + `company_name`: shown on the **PDF preview loading screen** (the branded interstitial the operator sees while the PDF renders). If `logo_url` is missing the loading screen falls back to `company_name` as text; if both are missing it falls back to "Rafter". Must be provisioned in step 5 before the operator uses the form.
- `logo_url` is also embedded in the PDF cover page and in the quote email template (`email_template` field). All three surfaces pull from the same KV field — one logo upload covers all.

### Billing
- Clerk Billing + Stripe. Plans defined in Clerk dashboard.
- `<PricingTable />` component for plan selection
- 0.7% per transaction + Stripe fees. Australia fully supported.
- GST/tax: not yet supported in Clerk. Manual invoice short-term.
- Subscription lapse → Worker gates access, redirects to billing page

**Clerk instance (test):**
- Publishable key: `pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ`
- Clerk domain: `first-kiwi-3.clerk.accounts.dev`
- JWKS: `https://first-kiwi-3.clerk.accounts.dev/.well-known/jwks.json`

**Clerk environment variables (to be added to all Workers):**
```
CLERK_PUBLISHABLE_KEY=pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...
```

---

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

**Materials filter:** Always use `?$filter=active eq 1` on `/api_1.0/material.json` fetches — without it inactive (archived) materials are returned alongside active ones.

**SM8 materials:** 117 items. Fields: uuid, name, price, active, cost, quantity_in_stock,
item_description, unit.

**store-token body:**
```json
{
  "uuid": "010895db-e06c-465d-bce9-2424477be15b",
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "..."
}
```

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

**Font loading:** Google Fonts does NOT load in headless Chromium. All fonts (Mulish 400/700,
Playfair Display 600) must be inlined as base64 data URIs. Do not reference Google Fonts CDN.

**Photo compression:** Section photos are compressed inside the Puppeteer browser context (via Canvas API) before PDF generation — resized to 400px wide at JPEG quality 0.78. `OffscreenCanvas` is not available in the Cloudflare Workers runtime so compression cannot happen in the Worker itself; it must run inside `page.evaluate()` where the full browser Canvas API is available. A 20-photo quote produces ~2MB. Do not move compression back to the Worker layer.

**PDF preview loading screen:** `index.html` writes a branded interstitial to the new tab synchronously (before the fetch) using `win.document.write()`. It shows `client.logo_url` pulsing over the `#ECF1E8` background with animated lime dots. Falls back to `client.company_name` as text if no logo. The window then navigates to the PDF blob URL when rendering completes. The `window.open()` call must remain synchronous inside the click handler — moving it after an `await` causes browsers to block it as a popup.

### rafter-admin-api (NEW v2.0)

**URL:** https://rafter-admin-api.will-8e8.workers.dev
**Location:** `workers/admin-api/`
**Status:** Implemented 2026-05-31. All routes live: provisioning (POST /admin/clients), list clients (GET /admin/clients), smoketest (POST /admin/clients/{uuid}/verify), sync trigger (POST /admin/clients/{uuid}/sync). CLERK_JWT_KEY set — networkless JWT verification working. onboarding.html built 2026-05-31. Pending: CLERK_SECRET_KEY (subscription_gate smoketest), Clerk webhook org.created trigger.

**Bindings:** KV (`RAFTER_CLIENTS`), R2 (`RAFTER_ASSETS`), D1 (`RAFTER_EVENTS`), Service Binding (`MATERIALS_SYNC_WORKER` → `rafter-materials-sync`). The service binding is required for Worker-to-Worker calls — see W2W note in Cloudflare infrastructure section.

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

---

## D1 — rafter-events (NEW v2.0 — built 2026-05-31, RFT-27)

**Database name:** `rafter-events`
**Database ID:** `39f38376-d163-439b-984d-2f0889e88d56`
**Write ownership:** `rafter-materials-sync` Worker — binding `RAFTER_EVENTS` in wrangler.toml
**Retention:** 90-day rolling window
**Purpose:** Event logging for dashboard. Not quote persistence — Rafter remains stateless.

### Schema

```sql
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  client_uuid TEXT NOT NULL,
  quote_ref TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  total_value REAL,
  proposal_type TEXT,
  status TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  client_uuid TEXT,
  event_type TEXT NOT NULL,  -- quote_submitted, sync_completed, onboarding_completed, sync_failed, etc.
  occurred_at TEXT NOT NULL,
  payload TEXT                -- JSON blob, optional
);
```

### Make.com integration points
- Quote submission → POST event to `/store-event` endpoint on rafter-materials-sync
- Sync completion → write event directly from Sync Worker

---

## ServiceM8 API

**Base URL:** `https://api.servicem8.com/api_1.0/`
**Auth:** `Authorization: Bearer {access_token}` (from KV)
**Token endpoint:** `POST https://go.servicem8.com/oauth/access_token` (1-hour access token; refresh implemented in `rafter-materials-sync` Worker — see `workers/materials-sync/index.js`)
**App ID:** 781230

### Key endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/company.json?search={q}` | GET | Client search (min 3 chars, debounced 400ms) |
| `/job.json` | POST | Create job — UUID returned in `x-record-uuid` response header (not body) |
| `/jobactivity.json` | POST | Create job note |
| `/staff.json` | GET | List staff (for UUID lookup) |
| `/api_1.0/Attachment.json` | POST | Create attachment record — step 1 of PDF delivery. Returns attachment UUID in `x-record-uuid` header. |
| `/api_1.0/Attachment/{uuid}.file` | POST | Upload PDF binary — step 2 of PDF delivery. Multipart, field name `file`. |

**PDF delivery is two-step Attachment API** (not SM8 Inbox). Inbox delivery is not viable — SM8 Inbox has no file attachment field (VER-01 closed negative).

**Trial UUID token:** Trial UUID `010895db-e06c-465d-bce9-2424477be15b` is provisioned — KV record created, OAuth done (will@thurlow.net), 114 materials synced (2026-05-30). Use `slug:dev` for all dev/test SM8 API calls. Andy's live token at `client:0e604a45-…` is read-only — never use for writes that create jobs, clients, or attachments.

### OAuth scopes (current)
```
vendor, vendor_logo, read_staff, read_inventory, read_job_categories, read_job_queues,
manage_templates, manage_badges, read_tax_rates, read_forms, read_customers, read_jobs
```

**`create_jobs`:** present on trial, working (RFT-26). **For edit-quote (RFT-32), three further scopes are required and currently MISSING:** `manage_jobs` (update job_description), `publish_job_attachments` (create attachment + upload binary), `read_attachments` (list attachments — runtime-confirmed name; docs say `read_job_attachments`, runtime error is authoritative). Add to the scope string in `workers/rafter/setup.html`, then re-auth (Flow D — human, ~1 min). No scope elevation without a new grant.
**Inbox scope:** `publish_inbox` — undocumented on public scopes page, defined in OpenAPI only. Moot until VER-01 resolved.

---

## Make.com scenarios

| Scenario | Webhook URL | Purpose |
|----------|-------------|---------|
| Account Discovery | `hook.eu1.make.com/38k3vwhijsfun40uu3pmk942gdjnvj32` | OAuth token exchange |
| Data Retrieval | `hook.eu1.make.com/hao3fhj1n2d1il4bhkkabozjwl892ujt` | Pull SM8 data on callback |
| Rafter Form (prod) | (no external webhook — `5537814`) | Quote submission → SM8 job creation |
| Rafter Form - Dev | (no external webhook — `5962197`) | Dev/trial submissions |

**Probe 2 monitoring (RFT-47 — nightly cron):** For each scenario above (5612449, 5537814), Probe 2 checks: `isPaused`, `isActive === false`, `dlqCount > 0` (dead-letter queue — failed executions awaiting retry). Any of these signals an alert. `dlqCount > 0` is the primary early-warning signal for execution failures that did not yet deactivate the scenario.

**Make Data Store:** "Rafter Tokens" — fields: uuid, access_token, refresh_token, expires_at.

**Make is UI-only** — Claude Code cannot modify Make scenarios. Document the required Make
changes and hand them to Will for manual configuration.

**⚠️ Make UI fragility (BUG-25):** Two modules in the Rafter Form prod scenario were fixed by direct API PATCH and will **silently revert** if the scenario is opened and saved through the Make UI: M3 `company_uuid: {{ifempty(1.client_sm8_uuid; 2.headers.\`x-record-uuid\`)}}` and M33/M37 subject expressions. If new-customer jobs start appearing with blank `company_uuid`, or the email subject regresses, re-PATCH from `make-blueprints/rafter-form-prod-2026-05-21-final.json`. **Avoid opening the Rafter Form prod scenario in the Make UI.**

**Make.com replacement** is a deferred future decision. Candidates: Pipedream (has REST API,
programmable scenario provisioning) or Cloudflare Workers + Queues (eliminates iPaaS entirely).
Do not act on this until Will explicitly initiates the workstream.

---

## Andy's branding

| Element | Value |
|---------|-------|
| Primary dark green | `#0D2E1C` |
| Lime accent | `#84B741` |
| Light background | `#ECF1E8` |
| Heading font | Playfair Display Semi-Bold (600) |
| Body font | Mulish Regular (400) / Bold (700) |
| Logo (R2) | `clients/0e604a45-84fd-4789-a2cb-662bcba51a8b/logo.png` |

---

## Open issues — tracked in Linear

**Issue tracker:** https://linear.app/deepgreensea · Team: Rafter · Prefix: RFT

Google Sheets issue tracker is retired. All issues now in Linear. Current open items:

| Linear ID | Title | Priority | Status |
|-----------|-------|----------|--------|
| RFT — VER-01 | SM8 Inbox API PDF attachment support | — | Closed (answered negative 2026-05-14) — Inbox has no file attachment field; re-examine D5 before T1-E1 |
| RFT — VER-02 | SM8 OAuth scope includes Inbox write access | — | Closed (moot — VER-01 answered negative) |
| RFT — DEBT-01 | Make email delivery template not served from KV | High | In Progress |
| RFT — DEBT-03 | Make dev/prod scenario separation | Medium | **Done** — slug:dev → trial → dev scenario 5962197; slug:andy → Andy live → prod 5537814 (2026-05-30) |

**VER-01 (closed negative 2026-05-14):** SM8 Inbox API has no file attachment field — `createInboxMessage` OpenAPI schema has no file/attachment property. Account also returns `Inbox functionality is not available on this account`. Inbox delivery is not viable. D5 must be re-examined before T1-E1 to determine the PDF delivery path.

**VER-02 (closed — moot):** `publish_inbox` scope is irrelevant given VER-01 negative result.

**VER-03 (closed):** New job UUID returned in `x-record-uuid` response header, not body.
Any consumer of `POST /job.json` must read headers.

---

## Architecture decisions (locked — do not reopen without explicit instruction)

| ID | Decision |
|----|----------|
| D1 | Photos: Cloudflare R2, bucket `rafter-assets`, zero egress |
| D2 | PDF: Browser Rendering API via Cloudflare Worker |
| D3 | Client deduplication: deferred — SM8 native Merge Clients |
| D4 | Materials: KV cache 24hr TTL, nightly cron sync |
| D5 | Amendments: **RESOLVED 2026-06-02 → edit-quote feature (Linear RFT-32).** Versioned amend onto the existing SM8 job: new PDF attachment (Attachment API — multiple-attachments-per-job confirmed, RFT-33) + appended job_description version block. Rafter persists structured payload in `rafter-quotes` D1 for rehydration; `sm8_job_uuid` stored at submit time is the SOLE job-linkage (no SM8 job-search fallback exists — RFT-35). SM8 Inbox path abandoned (VER-01/02 negative). Customer artifact stays PDF-as-object; living-link delivery shelved. Requires SM8 scopes `manage_jobs` + `publish_job_attachments` + `read_attachments` (re-auth). |
| D6 | Quote ref: Q-YYYYMMDD-HHMM (Melbourne timezone) |
| D7 | Template library: per-client KV |
| D8 | Onboarding: **v2.0 — Clerk-driven self-service. Manual checklist retired.** |
| D9 | PDF preview: new browser tab, non-destructive |
| D10 | Devices: 768px min, tablet landscape, touch-first |
| D-NEW-1 | Auth: Clerk organisations replace URL-as-password. One org per client. JWT validated at Worker edge. |
| D-NEW-2 | Billing: Clerk Billing + Stripe. Plans in Clerk dashboard. Subscription state gates Worker access. |
| D-NEW-3 | Admin API: privileged Worker surface for onboarding, verification, sync, secret rotation. Claude Code operates against this. |
| D-NEW-4 | Onboarding: Clerk session task flow → onboarding.html → Admin API provisions KV, triggers sync, verifies. |
| D-NEW-5 | Dashboard: single ops surface, business + tech view. Feeds from D1, Clerk API, Cloudflare Analytics, KV. |
| D-MAKE | Make.com retained as-is. Replacement deferred — separate future decision. |
| — | Agent lives on Rafter side. SM8 is a dumb REST recipient. |
| — | job_description is append-only with delimiter markers. Never overwrite. |
| — | Rafter is bounded-stateful — `rafter-quotes` D1 persists payloads for rehydration/versioning (RFT-32); `rafter-events` D1 is event-logging only; SM8 is system-of-record for issued quotes. |
| — | No client UUID or credential hardcoded in platform files. All config from KV. |

---

## PDF design spec (locked — T1-D1 complete)

**Cover page (Page 1 only):**
1. Header: phone left (lime `#84B741`) · total right (lime) · thin rule
2. Logo from R2 left · business address/ABN right
3. "PREPARED FOR" lime uppercase · client name large bold · full address
4. Meta block right-aligned: Date / Reference / Total — lime label + Mulish 400 value. **No proposal number.**
5. Horizontal rule
6. Job title Playfair lime: `{type} — {street}, {suburb}` — no state, no country, one line

**Sections:** Playfair 600 ALL CAPS dark green heading · item name Mulish 700 + price right-aligned · rule · scope Mulish 400 · asterisk notes `#999`

**Footer:** page number right only, every page. No URL, no timestamp.

**Typography rules:**
- Playfair Display 600: section headings (ALL CAPS), block headings, job title
- Mulish 700: item names and prices
- Mulish 400: everything else
- All numbers in Mulish — no Playfair numerals

---

## Operator form design (index.html) — CSS variables

```css
--rf-navy: #1B4F72;
--rf-ocean: #2E86AB;
--rf-teal-bg: #EAF4F8;
--rf-teal-border: #A8D5E2;
--rf-outer: #1B3A52;
--rf-card: #FFFFFF;
--rf-row-bg: #F7F9FC;
--rf-border: #D4D0C8;
--rf-divider: #E8E4DC;
--rf-text: #1C1C1C;
--rf-muted: #6B6860;
--rf-green: #0D2E1C;
--rf-lime: #84B741;
--rf-danger-bg: #FFCDD2;
--rf-danger: #E57373;
```

---

## Build agent — MCP tools available (NEW v2.0)

Claude Code operates with the following MCP servers connected. Use these before reaching for
wrangler CLI or manual steps.

| MCP Server | Tools | Key capabilities |
|------------|-------|-----------------|
| Cloudflare | 89 | `kv_get` `kv_put` `kv_list` `kv_delete` · `r2_put_object` `r2_get_object` · `worker_deploy` · `d1_query` · `secret_put` |
| GitHub | 42 | Commits · PRs · issues · file reads/writes on shikaishi/Rafter |
| Linear | 35 | Issue create/update/search on Deep Green Sea workspace · RFT prefix |

**Claude Code can directly:**
- Read and write KV records without wrangler
- Upload files to R2 without wrangler
- Deploy Workers
- Query D1 (`rafter-events` — ID `39f38376-d163-439b-984d-2f0889e88d56`)
- Create and update Linear issues
- Commit code and open PRs on shikaishi/Rafter

**Make.com remains UI-only.** Document required Make changes and hand to Will.

### Tool discipline (token and approval efficiency)

**For file operations — always use the built-in tools, never Bash/PowerShell:**
- File search → `Glob` · Content search → `Grep` · File read → `Read`
- Never substitute `Bash(find ...)`, `Bash(grep ...)`, `PowerShell(Get-ChildItem ...)` for these

**For Cloudflare data — MCP first, wrangler CLI second:**
- KV reads → `mcp__cloudflare__kv_get` before `npx wrangler kv key get`
- Note: wrangler v4 `kv key list` and `kv key get` are broken (return empty/not-found). MCP is the reliable path.
- If `kv_get` returns `[object Object]` (MCP serialisation bug), fall back to wrangler; if that also fails, **stop and ask Will to retrieve the value from the Cloudflare dashboard** — do not explore workarounds iteratively.

**Dead-end rule:** If a data source is inaccessible after one attempt with each available tool, stop and ask Will one targeted question. State exactly what value is needed and why. Do not iterate through system directories or try multiple alternative approaches unilaterally.

---

## Claude Chat / Claude Code split

**Claude Code owns:**
- File reads and writes (index.html, Workers, scripts)
- API verification calls (GET /staff.json, test POSTs, etc.)
- Bulk operations and SM8 cleanup scripts
- KV reads/writes via Cloudflare MCP
- R2 uploads via Cloudflare MCP
- Linear issue management via Linear MCP
- GitHub commits and PRs via GitHub MCP
- Admin API calls for provisioning and verification
- Anything requiring execution and real output

**Claude Chat owns:**
- Architecture decisions and sequencing
- Make.com configuration (UI-based — Code cannot touch it)
- Bug triage and prioritisation
- Continuation prompts and session handoff

**Handoff format** (Chat → Code):
```
TASK: [one line]
FILE: [exact path or N/A]
ENDPOINT: [if API call]
INPUT: [exact values]
SUCCESS CONDITION: [what done looks like]
CONTEXT: See CLAUDE.md
```

---

## Things that require verification before building

**SM8 verifications — answered 2026-05-14:**
- **Inbox-attach delivery not supported** (VER-01 closed negative). No file field on `createInboxMessage`. D5 delivery path is unresolved — must be re-examined before T1-E1.
- **`publish_inbox`** scope is moot (VER-02 closed).
- **`create_jobs`** present and working (RFT-26). Edit-quote (RFT-32) additionally needs `manage_jobs`, `publish_job_attachments`, `read_attachments` — currently missing, re-auth required before amend testing.
- **New job UUID** in `x-record-uuid` response header, not body.

**v2.0 items requiring verification before building:**
- Clerk JWT validation in Cloudflare Workers — verify `@clerk/backend` works with Workers runtime before Admin API build
- Clerk webhook signature verification in Workers context
- D1 binding setup in rafter-materials-sync wrangler.toml
- Admin API Worker authentication pattern against Clerk webhook format

Check SM8 developer docs at https://developer.servicem8.com for new endpoints / changes,
and prefer test calls against the trial instance for new verification work.

---

## Non-negotiable constraints

1. **Trial instance only** for development. Andy's active KV record (`0e604a45-…`) is production — explicit sign-off required for any write. T1-F2 is complete; Andy is live.
2. **No client UUID, credential, or client-specific value hardcoded** in platform files.
3. **Rafter is bounded-stateful.** SM8 remains system-of-record for the issued quote. Rafter persists the structured submission payload in the `rafter-quotes` D1 database solely to enable quote rehydration and versioned editing (RFT-32). `rafter-events` D1 remains event-logging only. No other quote state is held; Rafter does not become the quote system-of-record.
4. **job_description is append-only** with delimiter markers, by Rafter convention. NB: SM8 itself permits overwrite via `POST /job/{uuid}.json` (verified RFT-34) — append is Rafter's deliberate choice, not an SM8 limitation. Revisitable pending Andy's input (RFT-41 Q1); changing to overwrite is a one-line change. Never overwrite while this convention stands.
5. **Agent on Rafter side only.** SM8 is a dumb REST recipient.
6. **768px minimum.** Touch-first. Mobile out of scope.
7. **No assumptions.** Flag for verification if not confirmed in this file.
8. **Citations required** for any external platform claim (API behaviour, endpoint shape, etc.).
9. **Admin API is the only privileged surface.** Claude Code operates against it — never directly against production KV with client data outside of the Admin API contract.
10. **Clerk org = security boundary.** No request reaches protected resources without a valid Clerk JWT with active subscription.
11. **Worker-to-Worker calls MUST use Service Bindings, never workers.dev URLs.** Cloudflare silently drops same-account W2W subrequests routed via workers.dev — zero events in wrangler tail, no error returned. Declare the target worker in wrangler.toml `[[services]]` and call via the binding. The `MATERIALS_SYNC_WORKER` binding on admin-api is the canonical example; every future W2W call must follow this pattern.
