# CLAUDE.md — Rafter Platform

---

## Session Protocol

This file is the single source of truth for the Rafter project. Read it in full at the start of every session.

**Claude Chat:** Will pastes this file at session start. Claude Chat coordinates all work — writes prompts for Code and Cowork, reviews outputs, decides next actions.

**Claude Code:** Read CLAUDE.md before every task. Update it after completing work — close issues, update status, add new findings. Push to GitHub after updating.

**Cowork:** Maintains CLAUDE.md between sessions. When instructed, edits in place and pushes to GitHub. Does not rewrite the whole file — targeted edits only.

**Never create new tracker or log files. Everything lives in CLAUDE.md. No Google Sheets. No duplicate files.**

---

> Last reconciled: 17 May 2026 (DEBT-04 closed — SM8 native modules replaced with HTTP Bearer auth; BUG-16/17, MAKE-09/10 closed; OAuth scopes updated; re-run setup.html OAuth required)

---

## ⚠️ CRITICAL SAFETY RULE

**NEVER use Andy's live ServiceM8 UUID during development or testing.**

| Instance | UUID | Use |
|----------|------|-----|
| **Trial (DEV/TEST)** | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` | All development and testing |
| **Andy's live (PRODUCTION)** | `0e604a45-84fd-4789-a2cb-662bcba51a8b` | T1-F2 only — explicit sign-off required |

If you are about to write code referencing the live UUID, stop and confirm with Will first.

---

---

# SECTION 1 — Project Overview

## What Rafter is

Rafter is an AI-assisted quoting and operations platform for Australian tradespeople, built by
Deep Green Sea Pty Ltd (Will Thurlow). It generates branded PDF quotes from a web form,
creates jobs in ServiceM8, and emails the quote PDF to the customer.

**First client:** Andy — 2 Men and a Shovel, Melbourne landscaper.
**Deep Green Sea entity:** Will Thurlow, ABN TBD, deepgreensea.au.
**GitHub:** shikaishi/Rafter (private)
**Platform URL:** rafter.deepgreensea.au
**SM8 operator email (Andy's instance):** will@deepgreensea.au
**Trial/dev email:** will@thurlow.net
**SM8 App ID:** 781230

## Repository structure

```
shikaishi/Rafter (local: C:\Users\will\Documents\GitHub\Rafter)
├── CLAUDE.md                         # This file
├── rafter-continuation-prompt.md     # Redacted copy of continuation prompt
├── docs/
│   └── client-onboarding-template.md # Repeatable onboarding checklist
└── workers/
    ├── rafter/                       # Main site — Worker with Assets
    │   ├── wrangler.toml
    │   ├── index.html                # Quoting form (operator-facing)
    │   ├── setup.html                # OAuth initiation
    │   └── callback.html             # OAuth callback
    ├── materials-sync/               # rafter-materials-sync Worker
    │   ├── wrangler.toml
    │   └── index.js
    └── pdf/                          # rafter-pdf Worker
        ├── wrangler.toml
        └── index.js
```

**CRITICAL deployment rules:**
- Never put `wrangler.toml` at repo root. No HTML files at repo root. The `workers/rafter/`
  Worker serves the site — deploy manually from that subdirectory.
- All Workers deploy manually: `cd workers/<name> && npx wrangler deploy`
- Cloudflare git auto-deploy is disabled (build command = `exit 0`).

## Cloudflare infrastructure

| Resource | Value |
|----------|-------|
| Site Worker | `rafter` — rafter.deepgreensea.au (custom domain) |
| materials-sync Worker | `rafter-materials-sync` — rafter-materials-sync.will-8e8.workers.dev |
| pdf Worker | `rafter-pdf` — rafter-pdf.will-8e8.workers.dev |
| R2 bucket | `rafter-assets` |
| KV namespace | `RAFTER_CLIENTS` |
| KV namespace ID | `7c7ad02d8136452eb6d03d1af89a684f` |
| KV binding in wrangler.toml | `binding = "RAFTER_CLIENTS", id = "7c7ad02d8136452eb6d03d1af89a684f"` |

**KV tooling notes:**
- Wrangler v4 `kv key list` returns `[]` — use Cloudflare dashboard or REST API to browse keys.
- **Never** use `wrangler kv key put "key" $value` from PowerShell — it corrupts JSON. Always
  write JSON to a UTF-8 file first, then: `npx wrangler kv key put "key" --path file.json --binding=RAFTER_CLIENTS --remote`
- Run all `wrangler` commands from `workers/materials-sync/`.

## Worker — rafter (site)

**URL:** https://rafter.deepgreensea.au  
**Location:** `workers/rafter/`  
**Type:** Worker with Assets (`not_found_handling = "single-page-application"`)

Serves static HTML files. Slug-based routing: `rafter.deepgreensea.au/{slug}` reads the first URL
path segment and resolves it to a client UUID via `/resolve-slug/{slug}` on rafter-materials-sync.

**Worker secrets:**  
*(none — site is static HTML)*

## Worker — rafter-materials-sync

**URL:** https://rafter-materials-sync.will-8e8.workers.dev  
**Location:** `workers/materials-sync/`

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Status check |
| `/store-token` | POST | Bearer `RAFTER_WORKER_SECRET` | Write OAuth tokens to KV after Account Discovery |
| `/client-config?uuid={uuid}` | GET | `x-rafter-secret` header | Live client config for Make scenarios |
| `/render-email` | POST | `x-rafter-secret` header | Render email template with merge fields |
| `/refresh-materials?uuid={uuid}` | GET | None | Sync SM8 materials to KV cache |
| `/resolve-slug/{slug}` | GET | None | Resolve URL slug → client UUID |
| `/client/{uuid}` | GET | None | Sanitised client KV record (no tokens) |
| `/materials/{uuid}` | GET | None | Cached materials from KV |
| `/photos/{uuid}` | GET | None | List photo categories from R2 |
| `/photo?uuid={uuid}&key={key}` | GET | None | Proxy photo from R2 |
| `/logo/{uuid}` | GET | None | Serve `clients/{uuid}/logo.{png,jpg,jpeg}` from R2 |
| `/brand/{key}` | GET | None | Serve `brand/{key}` from R2 publicly |
| `/sm8-staff?uuid={uuid}` | GET | None | List active SM8 staff (for UUID lookup) |
| `/sm8-search?uuid={uuid}&q={q}` | GET | None | Search SM8 companies (min 3 chars) |
| Cron `0 10 * * *` UTC | — | — | Nightly materials sync for all clients |

**Worker secrets** (set via `npx wrangler secret put <NAME> --name rafter-materials-sync`):

| Secret | Purpose |
|--------|---------|
| `RAFTER_WORKER_SECRET` | Bearer token auth for `/store-token` (called by Make Account Discovery) |
| `RAFTER_INTERNAL_SECRET` | Header auth (`x-rafter-secret`) for `/client-config` and `/render-email` (called by Make Rafter Form) |
| `SERVICEM8_CLIENT_SECRET` | SM8 OAuth client secret — used for token refresh |

**`/store-token` request body:**
```json
{ "uuid": "...", "access_token": "...", "refresh_token": "...", "expires_at": "..." }
```

**`/client-config` response** (8 fields — `refresh_token` and full KV record NOT exposed):
```json
{
  "access_token": "...",
  "staff_uuid": "...",
  "email_template": "...",
  "company_name": "...",
  "phone": "...",
  "business_email": "...",
  "operator_email": "...",
  "logo_url": "..."
}
```

**`/render-email` request body:**
```json
{
  "uuid": "...",
  "client_name": "Sandra Dogny",
  "job_address": "87 Gyrfalcon Way, Doreen VIC 3754",
  "quote_ref": "Q-20260516-1247",
  "total": "254.10"
}
```
**`/render-email` response:**
```json
{ "html": "<rendered email body with all {merge_fields} substituted>" }
```

**Token refresh logic:** `refreshTokenIfNeeded()` — proactive, time-based (refreshes if token expires
within 5 minutes). Calls `https://go.servicem8.com/oauth/access_token` with `grant_type=refresh_token`.
Writes updated tokens directly to KV. Not reactive to 401s.

## Worker — rafter-pdf

**URL:** https://rafter-pdf.will-8e8.workers.dev  
**Location:** `workers/pdf/`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/generate?mode=preview` | POST | Generate PDF, return binary blob for browser preview |
| `/generate?mode=submit` | POST | Generate PDF for Make to deliver to SM8 |

**Required wrangler.toml flags:**
```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"
```

**Font loading:** Google Fonts does NOT load in headless Chromium. Mulish 400/700 and Playfair
Display 600 must be inlined as base64 data URIs. Never reference Google Fonts CDN in PDF HTML.

## ServiceM8 API

**Base URL:** `https://api.servicem8.com/api_1.0/`  
**Auth:** `Authorization: Bearer {access_token}`  
**Token endpoint:** `POST https://go.servicem8.com/oauth/access_token`  
**App ID:** 781230

**Current OAuth scopes:**
```
vendor vendor_logo read_staff read_inventory read_job_categories read_job_queues
manage_templates manage_badges read_tax_rates read_forms read_customers read_jobs publish_email
create_jobs manage_customers
```

| SM8 Endpoint | Method | Purpose |
|-------------|--------|---------|
| `/company.json?search={q}` | GET | Client search (min 3 chars, debounced 400ms) |
| `/staff.json` | GET | List staff |
| `/material.json` | GET | List materials |
| `/job.json` | POST | Create job — native Make module returns Job UUID directly |
| `/jobactivity.json` | POST | Create job note/activity |
| `/attachment.json` | POST | Create attachment record (step 1 of PDF delivery) |
| `/Attachment/{uuid}.file` | POST | Upload PDF binary (step 2 of PDF delivery) |
| `https://api.servicem8.com/platform_service_email` | POST | Send quote email to customer |

**SM8 email API headers:**
```
Authorization: Bearer {access_token}
x-impersonate-uuid: {staff_uuid}
Content-Type: application/json
```
**SM8 email API body:**
```json
{
  "to": "{customer_email}",
  "subject": "Your quote from 2 Men and a Shovel – {quote_ref}",
  "htmlBody": "{rendered HTML from /render-email}",
  "regardingJobUUID": "{job_uuid}",
  "attachments": ["{attachment_uuid}"]
}
```

**SM8 Inbox API (VER-01 — CLOSED/INVALID):** The Inbox API has no file attachment support at
the API level. The `inboxmessage.json` schema has no file field. PDF delivery via Inbox is not
possible. Use the Attachment endpoint (two-step above) instead.

**Trial instance token:** Read from KV — `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b` → `access_token`.  
Alternatively from Cloudflare dashboard → KV → RAFTER_CLIENTS.  
**ALWAYS use trial UUID for any test API call. Never the live UUID.**

## SM8 Developer Account

| Field | Value |
|-------|-------|
| Account email | will@thurlow.net |
| Account type | Partner (upgraded from trial May 2026) |
| App name | Rafter Setup |
| App ID | 781230 |
| App Secret | [stored in Make Account Discovery Module 2 — do not record here] |
| Trial UUID | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` |

This is the dev/trial SM8 instance used for all Rafter development and testing.
The Rafter OAuth app is registered under this account and must remain active (paid)
for OAuth to work for any client.

---

---

# SECTION 2 — Client Config Reference

## KV record structure

**Key pattern:** `client:{uuid}`  
**KV namespace:** RAFTER_CLIENTS (`7c7ad02d8136452eb6d03d1af89a684f`)

All fields documented below. Fields marked [OAuth] are populated automatically by the OAuth flow
via `/store-token`. Fields marked [post-OAuth] must be set manually after OAuth completes.

| Field | Type | Source | Returned by | Description |
|-------|------|--------|-------------|-------------|
| `uuid` | string | SM8 / Prerequisites | `/client/{uuid}` | SM8 company/operator UUID |
| `company_name` | string | Client | `/client/{uuid}`, `/client-config` | Display name e.g. "2 Men and a Shovel" |
| `branding.primary` | string | Client | `/client/{uuid}` | Dark colour hex e.g. `#0D2E1C` |
| `branding.accent` | string | Client | `/client/{uuid}` | Accent colour hex e.g. `#84B741` |
| `branding.background` | string | Client | `/client/{uuid}` | Light bg hex e.g. `#ECF1E8` |
| `branding.heading_font` | string | Client | `/client/{uuid}` | e.g. `"Playfair Display"` |
| `branding.body_font` | string | Client | `/client/{uuid}` | e.g. `"Mulish"` |
| `r2_photo_path` | string | Derived | `/client/{uuid}` | Always `"clients/{uuid}/photos/"` |
| `payment_thresholds` | object | Client | `/client/{uuid}` | Keys: `under_15k`, `between_15k_50k`, `over_50k`. Values: e.g. `"50/50"`, `"20/60/20"`, `"5/progress/final"` |
| `proposal_types` | string[] | Client | `/client/{uuid}` | e.g. `["LC", "GM"]` — abbreviations used in PDF cover title |
| `job_categories` | string[] | SM8 | `/client/{uuid}` | From SM8 Settings → Job Categories |
| `job_queues` | string[] | SM8 | `/client/{uuid}` | From SM8 Settings → Job Queues |
| `templates` | object[] | Manual | `/client/{uuid}` | Array of `{"name": "TEMPLATE NAME"}` — must match SCOPE_MAP keys in index.html. 26 fixed landscaping categories (BRICK EDGING, CONCRETING, etc.). NOT sourced from SM8 document templates. Write manually at onboarding. |
| `phone` | string | Client | `/client/{uuid}`, `/client-config` | Business phone e.g. `"(03) 9013 6588"` |
| `business_address` | string | Client | `/client/{uuid}` | Full address, newline between street and suburb line |
| `business_email` | string | Client | `/client/{uuid}`, `/client-config` | Public contact email |
| `operator_email` | string | Client | `/client/{uuid}`, `/client-config` | Email for operator notifications (Make Gmail module To field) |
| `abn` | string | Client | `/client/{uuid}` | e.g. `"18 652 417 171"` |
| `bank_details` | object | Client | `/client/{uuid}` | Keys: `name`, `bsb`, `account` |
| `credentials` | object[] | Client | `/client/{uuid}` | Array of `{"name": "...", "detail": "..."}` — printed on PDF appendix |
| `terms_and_conditions` | string[] | Client | `/client/{uuid}` | Array of strings — printed on PDF appendix |
| `staff_uuid` | string | SM8 [post-OAuth] | `/client/{uuid}`, `/client-config` | Account owner SM8 UUID — used as `x-impersonate-uuid` in email API. Trial: `5ba57e76-53c0-4340-86ce-24244cfa725b` (Will Thurlow). Andy's live: obtain via `/sm8-staff` endpoint after OAuth. |
| `email_template` | string | Client | `/client/{uuid}`, `/client-config`, `/render-email` | HTML email body. Merge fields: `{client_name}`, `{job_address}`, `{quote_ref}`, `{total}`. `/render-email` substitutes these server-side. |
| `logo_url` | string | Derived | `/client/{uuid}`, `/client-config` | Public URL of client logo for form header and favicon. Trial: `https://rafter-materials-sync.will-8e8.workers.dev/brand/rafter-logo.png`. Andy's live: `https://rafter-materials-sync.will-8e8.workers.dev/logo/0e604a45-84fd-4789-a2cb-662bcba51a8b` |
| `webhook_url` | string | Client | `/client-config` | Make Scenario 3 (Rafter Form) webhook URL. Required for submit mode — rafter-pdf reads this from KV; returns 400 if missing. Per-client, must be written to KV for each instance. |
| `access_token` | string | OAuth | `/client-config` only | SM8 Bearer token (NOT in `/client/{uuid}` — sanitised out) |
| `refresh_token` | string | OAuth | NOT exposed | SM8 refresh token — never returned by any endpoint |
| `expires_at` | string | OAuth | NOT exposed | ISO 8601 expiry timestamp |
| `token_updated_at` | string | OAuth | NOT exposed | ISO 8601 timestamp of last token write |

**Sanitised fields** (never returned by `/client/{uuid}`):
`access_token`, `refresh_token`, `expires_at`, `token_updated_at`

**`/client-config` fields** (returned to Make, auth required):
`access_token`, `staff_uuid`, `email_template`, `company_name`, `phone`, `business_email`,
`operator_email`, `logo_url`, `webhook_url`

## Trial instance known values (448e12a8...)

| Field | Value |
|-------|-------|
| `uuid` | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` |
| `company_name` | `"2 Men and a Shovel"` |
| `branding.primary` | `#0D2E1C` |
| `branding.accent` | `#84B741` |
| `branding.background` | `#ECF1E8` |
| `phone` | `(03) 9013 6588` |
| `business_email` | `hello@2menandashovel.com` |
| `operator_email` | `willthurlow73@gmail.com` |
| `abn` | `18 652 417 171` |
| `bank_details` | `{name: "2 Men and a Shovel", bsb: "083-231", account: "958330593"}` |
| `staff_uuid` | `5ba57e76-53c0-4340-86ce-24244cfa725b` (Will Thurlow) |
| `logo_url` | `https://rafter-materials-sync.will-8e8.workers.dev/brand/rafter-logo.png` |
| `webhook_url` | `https://hook.eu1.make.com/i8gukma8y3vs1gff7dihku8inotgy7lg` |
| `templates` | 26 items (see KV record for names) |
| `proposal_types` | `["LC", "GM"]` |

## Supplementary KV key patterns

| Key pattern | Purpose |
|-------------|---------|
| `client:{uuid}` | Full client config record |
| `materials:{uuid}` | Cached SM8 materials array (86400s TTL) |
| `slug:{slug}` | Maps URL slug → UUID e.g. `slug:andy` → `448e12a8-...` |

**Slug for trial instance:** `slug:andy` → `448e12a8-f7d9-4ace-b8c6-242bf678db3b`

---

---

# SECTION 3 — Issue Tracker

Status as of 17 May 2026. Owner: Code = Claude Code (includes Make API changes); Will = Will manually.

## Bugs

| ID | Title | Status | Priority | Owner | Notes |
|----|-------|--------|----------|-------|-------|
| BUG-01 | Google Maps API key domain restriction | **Closed** | P1 | Will | `rafter.deepgreensea.au/*` added to Google Cloud Console authorised referrers. Also: site_address field mapping fixed in Make (was snake_case rename issue). |
| BUG-02 | Account Discovery Webhook Response returning "Accepted" not JSON | **Closed** | P1 | Will-Make | Webhook Response module body: `{"access_token": "{{2.body.access_token}}", "expires_in": {{2.body.expires_in}}}`. Content-Type: application/json. Status 200. |
| BUG-03 | OAuth token refresh logic not built | **Closed** | P1 | Code | `refreshTokenIfNeeded()` at `workers/materials-sync/index.js:83–137`. Proactive time-based refresh (within 5 min of expiry). Writes to KV directly. Not reactive to 401s. |
| BUG-04 | Job Note module — staff_uuid empty | **Closed** | P1 | Will-Make | Uses `3. Created by Staff UUID` from Create a Job module output dynamically. |
| BUG-05 | Job Note module — note field not populating | **Closed** | P1 | Will-Make | Mapped to `3. Job Description`. |
| BUG-06 | PDF not arriving in SM8 on submit | **Closed** | P1 | Code | PDF delivers via two-step Attachment endpoint. Confirmed working. |
| BUG-07 | SM8 client search too fuzzy | **Closed** | P2 | Code | Fixed in T1-F1. |
| BUG-08 | Make Rafter Form — existing client routing unconfirmed | **Closed** | P1 | Will-Make | Confirmed working end-to-end in T1-F1 acceptance test. |
| BUG-09 | Photos not appearing in PDF | **Closed** | P1 | Code | Fixed — R2 paths fetched and embedded. |
| BUG-10 | No spinner/disabled state on submit buttons | **Closed** | P1 | Code | Spinner + disabled state added. |
| BUG-11 | SM8 client search dropdown clipped | **Closed** | P1 | Code | Z-index and overflow fixed. |
| BUG-12 | `lineItems[]` array missing from payload | **Closed** | P1 | Code | Restored. Also fixed compositing regression on material search dropdown. |
| BUG-13 | PDF credentials block forced to wrong page | **Closed** | P1 | Code | Moved to forced-page-break appendix. |
| BUG-14 | PDF bank details missing | **Closed** | P1 | Code | Moved to financial summary section in body. |
| BUG-15 | PDF terms and conditions missing | **Closed** | P1 | Code | Added to appendix page. |
| BUG-16 | Rafter Form module 8 — orphaned duplicate attachment record | **Closed** | P2 | Code | Module 8 (`servicem8:makeApiCall`) in route 2 creates a second attachment record on every submission using `{{1.pdfName}}` (field does not exist — should be `{{1.pdf.name}}`). The actual PDF is already attached correctly by modules 14/15 which run unconditionally before the router. Module 8 creates an empty-filename ghost record in SM8 on every submission. Remove module 8. |
| BUG-17 | `tax_rate_uuid` hardcoded in createclient module — breaks multi-tenant | **Closed** | P2 | Code | Module 2 (`servicem8:createclient`) has `tax_rate_uuid: 1643d783-b682-4ddf-aa7b-24244abe149b` hardcoded. This is Andy's SM8 tax rate UUID. Passing it to a second client's SM8 account will error or apply wrong tax rate. Remove the field — SM8 will apply the account default. |
| BUG-18 | Email subject hardcodes "2 Men and a Shovel" | **Open** | P2 | Code | Rafter Form module 37 (`json:CreateJSON`) subject field: `"Your quote from 2 Men and a Shovel – {{1.quote_ref}}"`. Should use `{{35.data.company_name}}` from `/client-config`. Affects both prod and dev scenarios. |
| BUG-19 | Operator notification email body hardcodes "Two Men and a Shovel" | **Open** | P2 | Code | Rafter Form module 12 (Gmail) HTML body has "Two Men and a Shovel" and company-specific branding baked in. Should use `/render-email` or at minimum pull company name dynamically. Affects both prod and dev. |
| BUG-20 | `expires_at` hardcoded as 3600s in Account Discovery | **Open** | P3 | Code | Account Discovery modules 4 and 5 use `addSeconds(now; 3600)`. Should use `addSeconds(now; {{2.data.expires_in}})` so actual SM8 token expiry is respected. Currently matches SM8's 3600s default but will silently break if SM8 changes it. |

## Tech Debt

| ID | Title | Status | Priority | Owner | Notes |
|----|-------|--------|----------|-------|-------|
| DEBT-01 | Make reading tokens from Data Store (stale every hour) | **Closed** | P1 | Code + Will-Make | `/client-config` endpoint built, deployed. Module 35 in Rafter Form scenario calls it. Make Data Store for tokens is redundant. |
| DEBT-02 | Currency values not formatted to 2dp in payload | **Closed** | P2 | Code | `toFixed(2)` applied to all currency fields in `buildPayload()` in index.html. |
| DEBT-03 | `operator_email` hardcoded in Make Gmail module | **Closed** | P1 | Code + Will-Make | Code complete: operator_email in KV and /client-config. Make Gmail module To field updated to {{35.data.operator_email}} — confirmed working 16 May 2026. |
| DEBT-04 | SM8 native modules use hardcoded Make OAuth connection — multi-tenant limitation | **Closed** | P2 | Code | Modules 2 and 3 converted to `http:MakeRequest` using `{{35.data.access_token}}` from `/client-config`. Module 35 moved before the router so token is available for all SM8 calls. Modules 13/14/15/17 also converted to Bearer auth. Make connection 7467476 no longer referenced in any blueprint module. |
| DEBT-05 | Make Data Store write still present in Account Discovery despite DEBT-01 closure | **Open** | P3 | Code | Account Discovery module 4 (`datastore:AddRecord`) still writes tokens to Make datastore 122745 on every OAuth. No downstream scenario reads from this datastore. Module 4 is dead weight — remove from Account Discovery blueprint. |
| DEBT-06 | Secrets hardcoded in Make blueprint plaintext | **Open** | P2 | Code | `RAFTER_INTERNAL_SECRET` hardcoded in Rafter Form module 35 `x-rafter-secret` header. SM8 `client_secret` hardcoded in Account Discovery module 2. `RAFTER_WORKER_SECRET` hardcoded in Account Discovery module 5 (with extra leading space). Should be stored in Make variables/keychain, not mapper values. |

## Verifications

| ID | Title | Status | Priority | Notes |
|----|-------|--------|----------|-------|
| VER-01 | SM8 Inbox API PDF attachment support | **Closed/Invalid** | — | SM8 Inbox API has no file attachment field at API level. Cannot attach PDFs to Inbox messages. PDF delivery via Attachment endpoint (already working) is the correct approach. |
| VER-02 | SM8 OAuth scope for Inbox write | **Closed/Invalid** | — | Moot — Inbox delivery abandoned (VER-01). `publish_inbox` scope not needed. |
| VER-03 | SM8 job creation response includes job UUID | **Closed** | — | Native Make SM8 module returns `Job UUID` directly as output field. Confirmed used by downstream modules. |

## Make tasks (Claude Code via API)

Claude Code manages Make scenarios via the Make API. See `.env` for token and scenario IDs. Blueprint workflow: GET blueprint → edit JSON → PUT blueprint. OAuth connections (Gmail, ServiceM8) require one-time UI creation; all else is API-driven.

| Task | Description | Priority | Status |
|------|-------------|---------|--------|
| MAKE-01 | Gmail module To field → `{{35.data.operator_email}}` | P1 | **Closed** 16 May 2026 |
| MAKE-02 | Add `/render-email` HTTP POST as Module 36 | P1 | **Closed** — confirmed in blueprint (Module 36 present and wired) |
| MAKE-03 | SM8 email module `htmlBody` → `/render-email` response | P1 | **Closed** — confirmed in blueprint (Module 37 uses `{{36.data.html}}`) |
| MAKE-04 | Account Discovery — make `/store-token` UUID dynamic | P2 | **Open** — module 4 body hardcodes `448e12a8-...`; change to `{{6.data[].uuid}}` (vendor UUID from module 6 fetch) |
| MAKE-05 | Account Discovery Module 2 — fix `client_id` and `client_secret` | P1 | **Open** — `client_id` is `782214` (wrong, must be `781230`); `client_secret` must be updated to current value from SM8 Partner Portal |
| MAKE-06 | Account Discovery Module 5 — remove double space in Bearer token | P3 | **Open** — `"Bearer  Kf..."` has two spaces |
| MAKE-07 | Account Discovery — `expires_at` should use `{{2.data.expires_in}}` | P3 | **Open** — modules 4 and 5 hardcode 3600s (see BUG-20) |
| MAKE-08 | Rafter Form module 37 — subject use `{{35.data.company_name}}` | P2 | **Open** — both prod and dev (see BUG-18) |
| MAKE-09 | Rafter Form — remove module 8 (duplicate/broken attachment) | P2 | **Closed** — removed from both blueprints |
| MAKE-10 | Rafter Form module 2 — remove hardcoded `tax_rate_uuid` | P2 | **Closed** — module 2 fully replaced (DEBT-04) |

---

---

# SECTION 4 — Decision Log

These are the settled threads from all Rafter conversations. Locked decisions are not reopened
without explicit Will sign-off.

| # | Workstream | Title | Status | Decision |
|---|-----------|-------|--------|---------|
| D1 | Infrastructure | Photo hosting | **Locked** | Cloudflare R2, bucket `rafter-assets`. Zero egress. Path: `clients/{uuid}/photos/{category}/{filename}`. |
| D2 | Infrastructure | PDF generation | **Locked** | Browser Rendering API via Cloudflare Worker. Fonts inlined as base64 data URIs (Google Fonts doesn't load in headless Chromium). |
| D3 | Infrastructure | Client deduplication | **Locked (deferred)** | No dedup logic in Rafter. Operational fallback: SM8 dashboard → Merge Clients. |
| D4 | Infrastructure | Materials sync | **Locked** | KV cache, 24hr TTL (`materials:{uuid}`). Nightly cron 8pm AEST (10:00 UTC). Manual refresh endpoint on form. |
| D5 | Infrastructure | Quote amendments | **Locked (revised)** | Stateless — operator regenerates quote in Rafter and resubmits. SM8 Inbox API not viable (no attachment support). PDF delivers via Attachment endpoint to SM8 job. |
| D6 | Platform | Quote reference format | **Locked** | `Q-YYYYMMDD-HHMM` Melbourne timezone, generated at form load. Amendment suffix: `-v2`. |
| D7 | Platform | Template library | **Locked** | Per-client KV. SM8 `jobtemplate.json` returns name/UUID only — template content extracted manually and stored in KV. |
| D8 | Platform | Onboarding | **Locked** | Manual checklist (Track 1). Automated wizard deferred (Track 2). |
| D9 | Platform | PDF preview | **Locked** | "Preview Quote" button → Browser Rendering Worker → PDF in new tab. Non-destructive, no SM8 writes. |
| D10 | Platform | Supported devices | **Locked** | 768px minimum. Tablet landscape + desktop. Mobile out of scope. Touch-first. |
| D11 | Platform | HTML forms over Tally | **Locked** | Claude builds HTML forms. Fully customisable, hosted on Cloudflare Workers. No Tally dependency. |
| D12 | Platform | SM8 OAuth (Public App) | **Locked** | App ID 781230. Authorization code flow. Tokens stored in KV via `/store-token`. App secret never in browser or GitHub — stored in Make. |
| D13 | Platform | Multi-tenancy model | **Locked** | One Make scenario for all clients. `client_uuid` in webhook payload routes to correct KV config via `/client-config`. No separate scenario per client. |
| D14 | Platform | Agent architecture | **Locked** | Agent lives on Rafter/Will's side. SM8 is a dumb REST recipient of well-formed API calls. No dependency on SM8's MCP server. |
| D15 | Platform | Quote email delivery | **Locked** | SM8 `platform_service_email` API. `x-impersonate-uuid` for staff personalisation. From address: SM8's sending infrastructure. Two Way Email active — customer replies log to job diary. |
| D16 | Andy | Scope text model | **Locked** | Template-fill, not AI generation. SM8 job templates are boilerplate source (confirmed word-for-word in all 11 Andy proposals). AI reserved for site-specific caveats. |
| D17 | Andy | Proposal format | **Locked** | Section-based. Two types: LC (Landscape Construction) and GM (Garden Maintenance/Makeover). Section order fixed. Photos inline within sections. |
| D18 | Andy | Delivery as line items | **Locked** | Multiple delivery SKUs in SM8. Form presents contextually relevant options. Not a calculated field. |
| D19 | Andy | Payment schedule | **Locked** | Auto-calculated from job total. Thresholds from KV `payment_thresholds` field. |
| D20 | Andy | PDF is client document | **Locked** | Rafter-generated PDF is the client-facing quote artefact. SM8 job created at Quote status for backend record. SM8 Proposals feature not used. |
| D21 | Platform | `operator_email` config-driven | **Locked** | Per-client KV field. Returned by `/client-config`. Make Gmail module To field must use this, not hardcoded email. |
| D22 | Platform | SM8 MCP server | **Deferred** | Monitor only. SM8 MCP server at `developer.servicem8.com/mcp` assessed as too early. Not a build dependency. |

---

---

# SECTION 5 — T1-F2 Andy Onboarding Checklist

Switch Andy from trial instance (`448e12a8...`) to live instance (`010895db...`).
**Do not proceed until T1-F1 acceptance test is confirmed complete on trial instance.**

T1-F1 status: **Complete** (confirmed by Will, May 2026).

## Pre-requisites

- [ ] Will confirms explicit sign-off to proceed with live instance — **WILL**
- [ ] Andy's SM8 company UUID confirmed: `0e604a45-84fd-4789-a2cb-662bcba51a8b` — **Will**
- [ ] Andy's branding assets confirmed (colours, fonts, logo file) — **Will**
- [ ] Andy's operator notification email confirmed (for `operator_email` field) — **Will**
- [ ] Andy's ABN confirmed (currently `18 652 417 171` — verify with Andy, one source shows `18 652 417 051`) — **Will**

## Step 1 — Create Andy's KV record

**Owner: Code.** Create `client:0e604a45-84fd-4789-a2cb-662bcba51a8b` in KV namespace `7c7ad02d8136452eb6d03d1af89a684f`.

Leave token fields (`access_token`, `refresh_token`, `expires_at`, `token_updated_at`) as empty strings — populated by OAuth (Step 3).
Leave `staff_uuid` as empty string — populated in Step 5.
Leave `templates` as empty array — populated after materials sync (Step 6).

**Known values for Andy's record:**
```json
{
  "uuid": "0e604a45-84fd-4789-a2cb-662bcba51a8b",
  "company_name": "2 Men and a Shovel",
  "branding": {
    "primary": "#0D2E1C",
    "accent": "#84B741",
    "background": "#ECF1E8",
    "heading_font": "Playfair Display",
    "body_font": "Mulish"
  },
  "r2_photo_path": "clients/0e604a45-84fd-4789-a2cb-662bcba51a8b/photos/",
  "phone": "(03) 9013 6588",
  "business_address": "61 Aileen Avenue\nCaulfield South, VIC 3162",
  "business_email": "hello@2menandashovel.com",
  "abn": "[VERIFY WITH ANDY]",
  "bank_details": { "name": "2 Men and a Shovel", "bsb": "083-231", "account": "958330593" },
  "logo_url": "https://rafter-materials-sync.will-8e8.workers.dev/logo/0e604a45-84fd-4789-a2cb-662bcba51a8b",
  "webhook_url": "https://hook.eu1.make.com/oh8gh9i7cdadlmmcyh3ypeep1x1n9jd4"
}
```

**Logo:** The PDF Worker already reads `clients/{uuid}/logo.png` from R2. Verify Andy's logo is uploaded to `clients/0e604a45-84fd-4789-a2cb-662bcba51a8b/logo.png` in R2.

**Slug:** Write `slug:andy` → `0e604a45-84fd-4789-a2cb-662bcba51a8b` to KV (replaces trial mapping):
```
cd workers/materials-sync
npx wrangler kv key put "slug:andy" "0e604a45-84fd-4789-a2cb-662bcba51a8b" --binding=RAFTER_CLIENTS --remote
```

- [x] KV record created and verified in Cloudflare dashboard — **Code**
- [x] `slug:andy` updated to live UUID — **Code**

## Step 2 — Upload Andy's logo to R2

**Owner: Will.** Upload the 2 Men and a Shovel logo PNG to:
`rafter-assets` R2 bucket → `clients/0e604a45-84fd-4789-a2cb-662bcba51a8b/logo.png`

- [x] Logo uploaded to R2 — **Will**
- [x] Verify: `curl https://rafter-materials-sync.will-8e8.workers.dev/logo/0e604a45-84fd-4789-a2cb-662bcba51a8b` returns image — **Will**

## Step 3 — SM8 OAuth

**Owner: Will.** Andy must complete the OAuth flow, or Will on Andy's behalf using `will@deepgreensea.au`.

1. Navigate to `rafter.deepgreensea.au/setup`
2. Click **Connect ServiceM8**
3. Log in with Andy's SM8 credentials (or `will@deepgreensea.au` if Will has access)
4. SM8 consent screen shows all scopes — click **Allow**
5. `callback.html` shows "Setup complete"

Behind the scenes: callback.html → Make Account Discovery → SM8 token exchange → `/store-token` → KV updated.

- [x] OAuth completed without error — **Will**
- [x] Verify KV record has `access_token` and `expires_at` populated — **Will** (Cloudflare dashboard)

## Step 4 — Make Data Store record

**Owner: Will-Make.** *(Temporary workaround — DEBT-01 code is done but Make UI still reads from Data Store in some modules. Remove once all Make modules use `/client-config`.)*

Open Make → Data Stores → Rafter Tokens → Add record:
- `uuid`: `0e604a45-84fd-4789-a2cb-662bcba51a8b`
- `access_token`, `refresh_token`, `expires_at`: copy from KV record

- [x] Data Store record created with Andy's live UUID and tokens — **Will-Make**

## Step 5 — Staff UUID

**Owner: Code.** Obtain Andrew Little's SM8 staff UUID after OAuth.

```
curl "https://rafter-materials-sync.will-8e8.workers.dev/sm8-staff?uuid=0e604a45-84fd-4789-a2cb-662bcba51a8b"
```

Find the record for Andrew Little (Account Owner). Copy the `uuid` field.
Write `staff_uuid` into Andy's KV record via `--path` method.

Make Module 33 `x-impersonate-uuid` confirmed already set to `{{35.data.staff_uuid}}` — no change needed.

- [x] Andrew Little's staff UUID obtained (`fe62e877-7a15-4a31-aac7-f670c78ef0ab`) — **Code**
- [x] `staff_uuid` written to Andy's KV record — **Code**
- [x] Make SM8 email module `x-impersonate-uuid` confirmed using `{{35.data.staff_uuid}}` — **Will-Make**

## Step 6 — Materials sync

**Owner: Will.**

```
curl "https://rafter-materials-sync.will-8e8.workers.dev/refresh-materials?uuid=0e604a45-84fd-4789-a2cb-662bcba51a8b"
```

Expected: `{"ok": true, "count": N, ...}` where N > 0.

- [x] Materials synced — 453 materials — **Will**

## Step 7 — Verification checklist

Work through each test in order. Do not mark passed until personally confirmed.

**Setup and auth**
- [ ] Form loads at `rafter.deepgreensea.au/andy` with "2 Men and a Shovel" in header — **Will**
- [ ] 2 Men and a Shovel logo appears in form header and browser tab favicon — **Will**
- [ ] Setup page loads at `rafter.deepgreensea.au/setup` — **Will**

**Form functionality**
- [ ] SM8 client search returns real Andy customers (type 3+ chars) — **Will**
- [ ] Google Maps autocomplete works in site address field — **Will**
- [ ] Materials load in line item search — **Will**
- [ ] Payment schedule auto-calculates from total — **Will**

**Submit Job Only** (no customer email)
- [ ] Job created in Andy's live SM8 with correct client, address, job description — **Will**
- [ ] PDF arrives in SM8 job diary as attachment — **Will**
- [ ] Quote reference (Q-YYYYMMDD-HHMM) appears — **Will**

**Submit and Send Quote** (with customer email)
- [ ] Job created in SM8 — **Will**
- [ ] PDF in job diary — **Will**
- [ ] Customer receives email from Andy's SM8 address with PDF attached — **Will**
- [ ] Operator notification email received at Andy's `operator_email` — **Will**

**Two-way email**
- [ ] Customer replies to quote email → reply appears in SM8 job diary — **Will**

## Step 8 — Post go-live

- [ ] Delete any test jobs and clients created during verification from Andy's live SM8 — **Will**
- [ ] Confirm `slug:andy` still resolves to live UUID — **Code**
- [ ] Update `rafter-continuation-prompt.md` with T1-F2 completion — **Will**
- [ ] Rotate `RAFTER_WORKER_SECRET` and `RAFTER_INTERNAL_SECRET` if they were ever in the trial environment chat history — **Code**

---

---

# SECTION 6 — Backlog

Items identified but not yet scheduled. All are post-T1-F2 unless noted.

## Make UI tasks (immediate — pre-T1-F2)

| ID | Task | Owner | Notes |
|----|------|-------|-------|
| MAKE-01 | **CLOSED** | Code | Done. |
| MAKE-02 | **CLOSED** | Code | Done — confirmed in blueprint. |
| MAKE-03 | **CLOSED** | Code | Done — confirmed in blueprint. |
| MAKE-04 | Account Discovery — make `/store-token` UUID dynamic | Code | Open — see issue tracker. |
| MAKE-05 | Account Discovery Module 2 — fix `client_id` and `client_secret` | Code | Open — see issue tracker. |
| MAKE-06 through MAKE-10 | Blueprint fixes from 17 May audit | Code | Open — see issue tracker. |

## Platform backlog

| Item | Description | Priority | Phase |
|------|-------------|---------|-------|
| **Rafter Lite** | Rafter without SM8 — form generates PDF, emails to customer and operator, no SM8 job/client creation. Make scenario skips SM8 modules. Commercial model TBD. Architecturally straightforward. | P3 | Post-Andy demo |
| **Dev/prod Make separation** | Separate Make scenarios or Worker environments for development vs production. Currently one shared scenario, multi-tenant by `client_uuid`. | P3 | Platform |
| **Automated acceptance test suite** | Weekly cron, 7 assertions across SM8/Make/Rafter, emails Will on failure. Post-change regression + continuous monitoring. Claude Code or lightweight Python harness. | P3 | Track 2 |
| **Make log extraction** | Export Make execution logs via API for monitoring/debugging. | P3 | Platform |
| **Onboarding wizard** | Replace manual onboarding checklist with guided wizard in Rafter operator interface. | P3 | Track 2 |
| **Template editor** | Lightweight admin interface for editing KV templates without raw JSON edits. | P3 | Track 2 |
| **SM8 MCP server monitoring** | Monitor `https://developer.servicem8.com/mcp` for maturity. Not a build dependency. | Monitor | Platform |
| **Quote amendment workflow** | Operator regenerates quote and resubmits to SM8. Amendment format: `Q-YYYYMMDD-HHMM-v2`. SM8 Inbox path abandoned (VER-01 closed). | P2 | Post-T1-F2 |
| **Agentic onboarding** | Agent on Will's side structures SM8 REST API payloads for client onboarding. Iterative autonomy expansion — read-only first. | P3 | Long-term |
| **Photo gallery labelling** | Andy has ~80 unlabelled plant photos. Decision needed: comfortable scrolling or want labels. Ask before building. | P2 | Post-T1-F2 |
| **Line item delivery context** | Form presents contextually relevant delivery SKUs based on materials selected. | P2 | Post-T1-F2 |
| **Deduplication handling** | Client search before create. SM8 Merge Clients as operational fallback. | P3 | Track 2 |

## Andy open questions (ask before T1-F1 or T1-F2)

1. Payment schedule milestone descriptions — editable per quote or fixed?
2. Materials not in SM8 inventory — add to SM8 first, or ad-hoc line items?
3. Plants photos (~80, unlabelled) — comfortable scrolling or want labels?
4. Line item details (materials, quantities, prices) — internal only or show in client PDF?
5. ABN: `18 652 417 171` or `18 652 417 051` — confirm correct value.
6. Operator notification email for live instance — which address?

---

---

# SECTION 7 — Make Scenario Reference

**Make scenarios are managed by Claude Code via the Make API.** Blueprint workflow: `GET /api/v2/scenarios/{id}/blueprint` → edit JSON → `PUT /api/v2/scenarios/{id}/blueprint`. API token and scenario IDs in `Rafter/.env` (gitignored — never commit). OAuth connections (Gmail, ServiceM8) must be created once via UI; thereafter referenced by connectionId in blueprints.

**Base URL:** `https://eu1.make.com/api/v2` · **Team ID:** `1602740` · **Org ID:** `7501187`

| Scenario | ID |
|----------|-----|
| ServiceM8 Account Discovery | `5612449` |
| ServiceM8 Data Retrieval | `5612520` |
| Rafter Form (prod) | `5537814` |
| Rafter Form (dev) | `5761732` |

## Scenario 1 — Account Discovery

**Purpose:** OAuth token exchange after SM8 login  
**Webhook URL:** `https://hook.eu1.make.com/38k3vwhijsfun40uu3pmk942gdjnvj32`

| Module | Type | Description |
|--------|------|-------------|
| 1 | Custom Webhook | Trigger. Receives POST `{"code": "..."}` from callback.html |
| 2 | HTTP → Make a request | POST `https://go.servicem8.com/oauth/access_token` (urlencoded). Body: `grant_type=authorization_code`, `client_id=781230`, `client_secret=[stored in Make]`, `code={{1.code}}`, `redirect_uri=https://rafter.deepgreensea.au/callback`. Returns `body.access_token`, `body.refresh_token`, `body.expires_in`. **⚠️ MAKE-05: current blueprint has client_id `782214` (wrong, must be `781230`) and stale client_secret — pending Code fix via API.** |
| 6 | HTTP GET | `https://api.servicem8.com/api_1.0/vendor.json` using new access_token — returns the SM8 account UUID. Used by modules 4 and 5 to identify which client completed OAuth. **MAKE-04:** module 4 still hardcodes trial UUID `448e12a8-...` instead of using `{{6.data[].uuid}}`. |
| 3 | Data Store | Add/Replace record to "Rafter Tokens". Fields: `uuid` (hardcoded `448e12a8-...`), `access_token={{2.body.access_token}}`, `refresh_token={{2.body.refresh_token}}`, `expires_at={{...}}`. **TODO MAKE-04:** Make UUID dynamic. |
| 4 | HTTP → Make a request | POST `https://rafter-materials-sync.will-8e8.workers.dev/store-token`. Header: `Authorization: Bearer [RAFTER_WORKER_SECRET]`. Body: `{"uuid": "448e12a8-...", "access_token": "{{2.body.access_token}}", "refresh_token": "{{2.body.refresh_token}}", "expires_at": "..."}`. |
| 5 | Webhooks → Webhook Response | Status 200. Content-Type: application/json. Body: `{"access_token": "{{2.body.access_token}}", "expires_in": {{2.body.expires_in}}}`. **This returns the token to callback.html.** |

## Scenario 2 — Data Retrieval

**Purpose:** Pull SM8 account data immediately after OAuth (sends email to will@deepgreensea.au)  
**Webhook URL:** `https://hook.eu1.make.com/hao3fhj1n2d1il4bhkkabozjwl892ujt`

| Module | Type | Description |
|--------|------|-------------|
| 1 | Custom Webhook | Receives `{"access_token": "..."}` from callback.html |
| 3 | HTTP GET | `https://api.servicem8.com/api_1.0/vendor.json` (company/vendor info) |
| 4 | HTTP GET | `https://api.servicem8.com/api_1.0/staff.json` |
| 5 | HTTP GET | `https://api.servicem8.com/api_1.0/material.json` |
| 6 | HTTP GET | `https://api.servicem8.com/api_1.0/category.json` |
| 7 | HTTP GET | `https://api.servicem8.com/api_1.0/queue.json` |
| 8 | HTTP GET | `https://api.servicem8.com/api_1.0/documenttemplate.json` |
| 9 | HTTP GET | `https://api.servicem8.com/api_1.0/badge.json` |
| 10 | HTTP GET | `https://api.servicem8.com/api_1.0/taxrate.json` |
| 11 | Gmail → Send Email | To: `will@deepgreensea.au`. Subject: `ServiceM8 Account Discovery — {{3.data.name}}`. Body: labelled JSON blocks for all fetched data. |

All HTTP modules use `Authorization: Bearer {{1.access_token}}`.

## Scenario 3 — Rafter Form

**Purpose:** Process form submission — create SM8 job, attach PDF, send email to customer, notify operator

**Webhook payload fields from index.html:**
`mode`, `client_uuid`, `customer_email`, `send_email`, `quote_ref`, `proposal_type`,
`client_name`, `client_sm8_uuid`, `site_address`, `proposal_date`, `sections`,
`form_sections` (with line_items, photos), `lineItems[]`, `notes`, `subtotal`, `gst`,
`total`, `payment_schedule`, `bank_details`, `include_materials_appendix`, `pdf` (binary)

| Module | Type | Description |
|--------|------|-------------|
| 1 | Custom Webhook | Trigger. Receives form submission payload including binary PDF. |
| [2] | JSON Parse | Parses `1.payload` JSON string to expose `client_uuid` as selectable variable. |
| [new client branch] | Router / If-Else | If `client_sm8_uuid` is empty → Create a Client in SM8. Merge → Create a Job using new or existing UUID. |
| 3 | SM8 → Create a Job | Creates SM8 job. Returns `Job UUID`, `Created by Staff UUID`, `Generated Job ID`. Fields: `job_address={{1.site_address}}`, `job_description={{1.job_description}}`, `status=Quote`, `company_uuid={{resolved client uuid}}`. |
| [4] | SM8 → Create a Job Note | `job_uuid={{3.uuid}}`, `staff_uuid={{3.Created by Staff UUID}}`, `note={{1.job_description}}`. |
| [5] | SM8 → Create Attachment Record | `related_object=job`, `related_object_uuid={{3.uuid}}`, `attachment_name={{1.pdf.name}}`, `file_type=.pdf`. Returns attachment UUID. |
| [6] | Tools → Set Variable | Variable name: `attachment_uuid`. Value: `x-record-uuid` header from module [5] response. (`28.attachment_uuid` confirmed.) |
| [7] | HTTP → Upload PDF binary | POST `https://api.servicem8.com/api_1.0/Attachment/{{attachment_uuid}}.file`. Multipart body: file field with `1.pdf.data`, `fileName={{1.pdf.name}}`. |
| Router | Router | Splits into Route 1 (main chain) and Route 2 (customer email branch). |
| **Route 1** | | |
| [8] | SM8 → Create JobMaterial | Create line items in SM8 billing from `1.lineItems[]`. |
| [9] | Gmail → Send Email | Operator notification. To: `{{35.data.operator_email}}` (**MAKE-01 pending** — currently hardcoded `willthurlow73@gmail.com`). Subject: `Site Visit Quote - {{1.client_name}} - {{1.proposal_date}}`. Attachment: `{{1.pdf.data}}`. |
| **Route 2** | | Filter: `send_email == "true"` AND `customer_email` not empty. |
| 35 | HTTP GET `/client-config` | `https://rafter-materials-sync.will-8e8.workers.dev/client-config?uuid={{client_uuid}}`. Header: `x-rafter-secret: [RAFTER_INTERNAL_SECRET]`. Returns `access_token`, `staff_uuid`, `email_template`, `company_name`, `phone`, `business_email`, `operator_email`, `logo_url`. |
| [36] | HTTP POST `/render-email` | `https://rafter-materials-sync.will-8e8.workers.dev/render-email`. Header: `x-rafter-secret`. Body: `{uuid, client_name, job_address, quote_ref, total}`. Returns `{"html": "..."}`. **MAKE-02 pending — not yet in Make.** |
| [37] | HTTP POST SM8 email | POST `https://api.servicem8.com/platform_service_email`. Headers: `Authorization: Bearer {{35.data.access_token}}`, `x-impersonate-uuid: {{35.data.staff_uuid}}`. Body: `{"to": "{{1.customer_email}}", "subject": "Your quote from 2 Men and a Shovel – {{1.quote_ref}}", "htmlBody": "{{36.html}}", "regardingJobUUID": "{{3.uuid}}", "attachments": ["{{28.attachment_uuid}}"]}`. **MAKE-03 pending** — currently `htmlBody` is inline template, not from `/render-email`. |

---

---

# Appendix — Constraints and Toolchain Notes

## Non-negotiable constraints

1. **Trial instance only** until T1-F2 explicit sign-off. Andy's live UUID (`0e604a45-...`) must not be used in any development or test.
2. **No client UUID, credential, or client-specific value hardcoded** in platform files. All config from KV.
3. **Rafter is stateless** — no quote database. Quotes live in SM8 only.
4. **`job_description` is append-only** with delimiter markers. Never overwrite.
5. **Agent on Rafter side only.** SM8 is a dumb REST recipient.
6. **768px minimum.** Touch-first. Mobile phone out of scope.
7. **No assumptions.** Flag for verification if not confirmed in this file.

## Toolchain notes

- **Wrangler v4 KV list** returns `[]` — use Cloudflare REST API or dashboard for key listing.
- **KV writes from PowerShell** corrupt JSON. Always use `--path <file>` with a UTF-8 JSON file.
- **Workers auto-deploy disabled** (build command = `exit 0`). Deploy manually from `workers/<name>/`.
- **Google Fonts** do not load in headless Chromium (rafter-pdf Worker). All fonts must be inlined as base64 data URIs.
- **SM8 token endpoint:** `https://go.servicem8.com/oauth/access_token` (not `app.servicem8.com` — that URL is wrong).
- **RAFTER_INTERNAL_SECRET value:** `R@ftCleanerTetr15Ren` (stored as Wrangler secret on `rafter-materials-sync`). Rotate before T1-F2 if this has appeared in conversation history.
- **RAFTER_WORKER_SECRET:** Rotated 17 May 2026 — old value exposed in session. New value set via wrangler; Will must update Make Account Discovery Module 5 Bearer token to match.

## Claude Chat / Claude Code split

**Claude Code owns:** File reads/writes, Worker deploys, KV reads/writes, API test calls, any task requiring execution.

**Claude Chat owns:** Architecture decisions, Make configuration (UI-only), bug triage and prioritisation, continuation prompt and issue tracker.

**Handoff format** (Chat → Code):
```
TASK: [one line]
FILE: [exact path or N/A]
ENDPOINT: [if API call]
INPUT: [exact values]
SUCCESS CONDITION: [what done looks like]
CONTEXT: See CLAUDE.md
```

## PDF design spec (locked — T1-D1 complete)

**Cover page:**
1. Header (every page): phone left (lime `#84B741`) · total right (lime) · thin rule
2. Logo from R2 left · business address/ABN right
3. "PREPARED FOR" lime uppercase · client name large bold · full address
4. Meta block right-aligned: Date / Reference / Total — lime label + Mulish 400 value. No proposal number.
5. Horizontal rule
6. Job title Playfair lime: `{type} — {street}, {suburb}` — no state, no country, one line

**Sections:** Playfair 600 ALL CAPS dark green heading · item name Mulish 700 + price right-aligned · rule · scope Mulish 400 · asterisk notes `#999`. Photos inline within section.

**Financial summary** (after all work sections): 1.5px divider · soft-green box with subtotal/GST/total → payment schedule → bank details.

**Appendix page** (forced page break): "You Can Rely On 2 Men and a Shovel" credentials block + T&Cs. Single A4 page.

**Footer:** page number right only, every page. No URL, no timestamp.

**Typography:**
- Playfair Display 600: section headings (ALL CAPS), block headings, job title
- Mulish 700: item names, prices
- Mulish 400: everything else
- All numbers in Mulish — no Playfair numerals
- Fonts: inlined as base64 data URIs (Google Fonts will NOT load in headless Chromium)

## Operator form design — CSS variables (index.html)

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
