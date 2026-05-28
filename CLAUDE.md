# CLAUDE.md — Rafter Platform

> Read this file at the start of every Claude Code session. It contains everything needed to work
> on Rafter without a context dump. Do not make assumptions about endpoints, UUIDs, or
> configuration values — they are all here or flagged as requiring verification.
>
> **Version 2.0 — Updated May 2026.** Major changes: Clerk auth + billing, Admin API Worker,
> D1 event logging, central dashboard, Linear issue tracking. See change summary below.

---

## ⚠️ CRITICAL SAFETY RULE

**NEVER use Andy's live ServiceM8 instance UUID during development or testing.**

| Instance | UUID | Use |
|----------|------|-----|
| **Trial (DEV/TEST)** | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` | All development and testing |
| **Andy's live (PRODUCTION)** | `010895db-e06c-465d-bce9-2424477be15b` | T1-F2 only — explicit sign-off required |

If you are about to write code that references the live UUID, stop and confirm with Will first.

---

## What Rafter is

Rafter is an AI-assisted quoting and operations platform for Australian tradespeople, built by
Deep Green Sea Pty Ltd (Will Thurlow). It generates branded PDF quotes from a web form,
creates jobs in ServiceM8, and delivers the PDF via the SM8 Inbox.

**First client:** Andy — 2 Men and a Shovel, Melbourne landscaper.
**Operator email (Andy's SM8):** will@deepgreensea.au
**Trial email:** will@thurlow.net
**GitHub:** shikaishi/Rafter
**Hosting:** Cloudflare Pages at rafter.deepgreensea.au (auto-deploys from main branch push)
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
├── index.html            # Quoting form — Clerk session required
├── onboarding.html       # Client intake form — post-Clerk sign-up (NEW v2.0)
├── setup.html            # SM8 OAuth initiation
├── callback.html         # OAuth callback
├── workers/
│   ├── materials-sync/   # rafter-materials-sync Worker
│   │   ├── wrangler.toml
│   │   └── index.js
│   ├── pdf/              # rafter-pdf Worker
│   │   ├── wrangler.toml
│   │   └── index.js
│   └── admin-api/        # rafter-admin-api Worker (NEW v2.0 — not yet built)
│       ├── wrangler.toml
│       └── index.js
```

**CRITICAL:** Never put wrangler.toml at repo root. Cloudflare Pages auto-deploys static files
from root on push to main. Workers deploy manually via `wrangler deploy` from their subdirectory.
Workers auto-deploy is disabled (build command = `exit 0`).

---

## Cloudflare infrastructure

| Resource | Name / ID |
|----------|-----------|
| Pages project | rafter (rafter.deepgreensea.au) |
| R2 bucket | `rafter-assets` |
| KV namespace | `RAFTER_CLIENTS` |
| KV namespace ID | `7c7ad02d8136452eb6d03d1af89a684f` |
| wrangler.toml binding | `binding = "RAFTER_CLIENTS", id = "7c7ad02d8136452eb6d03d1af89a684f"` |
| D1 database | `rafter-events` (NEW v2.0 — not yet created) |

**KV tooling note:** Wrangler v4 `kv key list` returns `[]` — use Cloudflare REST API directly
for KV reads during development. Cloudflare MCP `kv_list` / `kv_get` tools also work.

**KV key format:** `client:{uuid}` — e.g. `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b`

### KV record contents (trial UUID)

The KV record for the trial UUID contains:
- `uuid`, `company_name` ("2 Men and a Shovel"), branding, `r2_photo_path`
- `payment_thresholds`: `{under_15k: "50/50", between_15k_50k: "20/60/20", over_50k: "5/progress/final"}`
- `proposal_types`: `["LC", "GM"]`
- `job_categories`, `job_queues`, `templates` (26 items)
- `phone`, `business_address`, `abn`, `business_email`, `credentials[]`, `terms_and_conditions[]`
- `access_token`, `refresh_token`, `expires_at`, `token_updated_at`
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

### Billing
- Clerk Billing + Stripe. Plans defined in Clerk dashboard.
- `<PricingTable />` component for plan selection
- 0.7% per transaction + Stripe fees. Australia fully supported.
- GST/tax: not yet supported in Clerk. Manual invoice short-term.
- Subscription lapse → Worker gates access, redirects to billing page

**Clerk environment variables (to be added to all Workers):**
```
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
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
| `/refresh-materials?uuid={uuid}` | GET | None | Sync materials from SM8 to KV |
| `/store-token` | POST | Bearer `RAFTER_WORKER_SECRET` | Write OAuth tokens to KV |
| Cron `0 10 * * * UTC` | — | — | Nightly materials sync |

**SM8 materials:** 117 items. Fields: uuid, name, price, active, cost, quantity_in_stock,
item_description, unit.

**store-token body:**
```json
{
  "uuid": "448e12a8-f7d9-4ace-b8c6-242bf678db3b",
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
| `/generate?mode=submit` | POST | Generate PDF + write to SM8 (501 — NOT YET BUILT) |

**Required wrangler flags:**
```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"
```

**Font loading:** Google Fonts does NOT load in headless Chromium. All fonts (Mulish 400/700,
Playfair Display 600) must be inlined as base64 data URIs. Do not reference Google Fonts CDN.

### rafter-admin-api (NEW v2.0 — NOT YET BUILT)

**URL:** https://rafter-admin-api.will-8e8.workers.dev (proposed)
**Location:** `workers/admin-api/`
**Auth:** Bearer `RAFTER_ADMIN_SECRET` (Worker secret — never hardcode)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/clients` | POST | Provision new client KV record |
| `/admin/clients/{uuid}/verify` | POST | Run end-to-end health check |
| `/admin/clients/{uuid}/sync` | POST | Trigger materials sync |
| `/admin/clients/{uuid}/rotate-secret` | POST | Rotate client auth token |
| `/admin/clients` | GET | List all clients and status |

**Called by:** Clerk webhook (org.created), Claude Code via Cloudflare MCP, onboarding.html.
**Not called by:** index.html, any client-facing surface.

---

## D1 — rafter-events (NEW v2.0 — NOT YET BUILT)

**Database name:** `rafter-events`
**Write ownership:** `rafter-materials-sync` Worker
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
| `/job.json` | POST | Create job |
| `/jobactivity.json` | POST | Create job note |
| `/staff.json` | GET | List staff (for UUID lookup) |
| `/api_1.0/inboxmessage.json` | POST | Deliver PDF to SM8 Inbox (VER-01 open — see below) |

**ALWAYS use trial UUID** for any API test call. Never the live UUID.

**Trial instance token:** Retrieve from Make Data Store "Rafter Tokens" → key
`448e12a8-f7d9-4ace-b8c6-242bf678db3b` → `access_token` field.
Alternatively: Cloudflare KV → `RAFTER_CLIENTS` → `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b`.

### OAuth scopes (current)
```
vendor, vendor_logo, read_staff, read_inventory, read_job_categories, read_job_queues,
manage_templates, manage_badges, read_tax_rates, read_forms, read_customers, read_jobs
```

**Missing:** `create_jobs` — required for runtime job creation testing. New grant + re-auth needed.
**Inbox scope:** `publish_inbox` — undocumented on public scopes page, defined in OpenAPI only. Moot until VER-01 resolved.

---

## Make.com scenarios

| Scenario | Webhook URL | Purpose |
|----------|-------------|---------|
| Account Discovery | `hook.eu1.make.com/38k3vwhijsfun40uu3pmk942gdjnvj32` | OAuth token exchange |
| Data Retrieval | `hook.eu1.make.com/hao3fhj1n2d1il4bhkkabozjwl892ujt` | Pull SM8 data on callback |
| Rafter Form | (no external webhook) | Quote submission → SM8 job creation |

**Make Data Store:** "Rafter Tokens" — fields: uuid, access_token, refresh_token, expires_at.

**Make is UI-only** — Claude Code cannot modify Make scenarios. Document the required Make
changes and hand them to Will for manual configuration.

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
| Logo (R2) | `clients/448e12a8-f7d9-4ace-b8c6-242bf678db3b/logo.png` |

---

## Open issues — tracked in Linear

**Issue tracker:** https://linear.app/deepgreensea · Team: Rafter · Prefix: RFT

Google Sheets issue tracker is retired. All issues now in Linear. Current open items:

| Linear ID | Title | Priority | Status |
|-----------|-------|----------|--------|
| RFT — VER-01 | SM8 Inbox API PDF attachment support | High | Backlog — blocks T1-E1 |
| RFT — VER-02 | SM8 OAuth scope includes Inbox write access | High | Backlog — blocked on VER-01 |
| RFT — DEBT-01 | Make email delivery template not served from KV | High | In Progress |
| RFT — DEBT-03 | Make dev/prod scenario separation | Medium | Backlog — before second client |

**VER-01 detail:** Trial SM8 returns `Inbox functionality is not available on this account`
(account-gated, not scope). OpenAPI `createInboxMessage` schema has no file/attachment field.
D5 (amendments via Inbox) must be re-examined before T1-E1 starts.

**VER-02 detail:** Required scope `publish_inbox` — moot until VER-01 resolved.

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
| D5 | Amendments: stateless regeneration + SM8 Inbox — **PATH TBD, VER-01 answered negative, revisit before T1-E1** |
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
| — | Rafter is stateless — no quote database. D1 is event logging only. |
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
- Query D1 once rafter-events is created
- Create and update Linear issues
- Commit code and open PRs on shikaishi/Rafter

**Make.com remains UI-only.** Document required Make changes and hand to Will.

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
- **Inbox-attach delivery not supported** by public SM8 API. No file field on `createInboxMessage`. D5 must be re-examined before T1-E1.
- **`publish_inbox`** is the scope for Inbox write — undocumented on public page, defined in OpenAPI only. Moot until VER-01/D5 resolved.
- **`create_jobs` missing** from current OAuth grant. New grant + re-auth needed before runtime job creation testing.
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

1. **Trial instance only** until T1-F2. Andy's live UUID must not be used.
2. **No client UUID, credential, or client-specific value hardcoded** in platform files.
3. **Rafter is stateless** — no quote database. Quotes live in SM8 only. D1 is event logging only.
4. **job_description is append-only** with delimiter markers. Never overwrite.
5. **Agent on Rafter side only.** SM8 is a dumb REST recipient.
6. **768px minimum.** Touch-first. Mobile out of scope.
7. **No assumptions.** Flag for verification if not confirmed in this file.
8. **Citations required** for any external platform claim (API behaviour, endpoint shape, etc.).
9. **Admin API is the only privileged surface.** Claude Code operates against it — never directly against production KV with client data outside of the Admin API contract.
10. **Clerk org = security boundary.** No request reaches protected resources without a valid Clerk JWT with active subscription.
