# CLAUDE.md — Rafter Platform

> Read this file at the start of every Claude Code session. It contains everything needed to work
> on Rafter without a context dump. Do not make assumptions about endpoints, UUIDs, or
> configuration values — they are all here or flagged as requiring verification.

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

---

## Repository structure

```
/ (repo root)
├── index.html          # Quoting form — operator-facing
├── setup.html          # OAuth initiation
├── callback.html       # OAuth callback
├── workers/
│   ├── materials-sync/ # rafter-materials-sync Worker
│   │   ├── wrangler.toml
│   │   └── index.js
│   └── pdf/            # rafter-pdf Worker
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

**KV tooling note:** Wrangler v4 `kv key list` returns `[]` — use Cloudflare REST API directly
for KV reads during development. Dashboard also works.

**KV key format:** `client:{uuid}` — e.g. `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b`

### KV record contents (trial UUID)

The KV record for the trial UUID contains:
- `uuid`, `company_name` ("2 Men and a Shovel"), branding, `r2_photo_path`
- `payment_thresholds`: `{under_15k: "50/50", between_15k_50k: "20/60/20", over_50k: "5/progress/final"}`
- `proposal_types`: `["LC", "GM"]`
- `job_categories`, `job_queues`, `templates` (26 items)
- `phone`, `business_address`, `abn`, `business_email`, `credentials[]`, `terms_and_conditions[]`
- `access_token`, `refresh_token`, `expires_at`, `token_updated_at`

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
| `/api_1.0/inboxmessage.json` | POST | Deliver PDF to SM8 Inbox (V3 not yet verified) |

**ALWAYS use trial UUID** for any API test call. Never the live UUID.

**Trial instance token:** Retrieve from Make Data Store "Rafter Tokens" → key
`448e12a8-f7d9-4ace-b8c6-242bf678db3b` → `access_token` field.  
Alternatively: Cloudflare KV → `RAFTER_CLIENTS` → `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b`.

### OAuth scopes (current)
`vendor, vendor_logo, read_staff, read_inventory, read_job_categories, read_job_queues,
manage_templates, manage_badges, read_tax_rates, read_forms, read_customers, read_jobs,
manage_job_materials`

Note: Inbox write scope status unverified (VER-02). May need additional scope + re-authorise.

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

## Open issues — RESOLVE BEFORE TOUCHING AFFECTED CODE

See **Rafter — Issue Tracker** (Google Sheets) for full detail.

| ID | Title | Priority | Status |
|----|-------|----------|--------|
| BUG-01 | Google Maps API key domain restriction | P1 | Open — 5 min operator fix |
| BUG-02 | Account Discovery Webhook Response returning "Accepted" not JSON | P1 | Open — Make config |
| BUG-03 | OAuth token refresh logic not built | P1 | Closed — implemented in `rafter-materials-sync` |
| BUG-04 | Job Note module — staff_uuid empty | P1 | Open — hardcode UUID |
| BUG-05 | Job Note module — note field not populating | P1 | Open — mapping fix |
| BUG-06 | PDF not arriving in SM8 on submit | P1 | Open — triage rafter-pdf logs first |
| BUG-07 | SM8 client search too fuzzy | P2 | Deferred |
| BUG-08 | Make Rafter Form — filter + ifempty routing unconfirmed | P1 | In Progress |
| VER-01 | V3 — SM8 Inbox PDF attachment support | P1 | Open — blocks T1-E1 |
| VER-02 | V5 — SM8 OAuth scope for Inbox write | P1 | Open — blocks T1-E1 |
| VER-03 | V4 — SM8 job creation returns UUID | P2 | Open |

---

## Architecture decisions (locked — do not reopen without explicit instruction)

| ID | Decision |
|----|----------|
| D1 | Photos: Cloudflare R2, bucket `rafter-assets`, zero egress |
| D2 | PDF: Browser Rendering API via Cloudflare Worker |
| D3 | Client deduplication: deferred — SM8 native Merge Clients |
| D4 | Materials: KV cache 24hr TTL, nightly cron sync |
| D5 | Amendments: stateless regeneration + SM8 Inbox |
| D6 | Quote ref: Q-YYYYMMDD-HHMM (Melbourne timezone) |
| D7 | Template library: per-client KV |
| D8 | Onboarding: manual checklist Track 1, wizard Track 2 |
| D9 | PDF preview: new browser tab, non-destructive |
| D10 | Devices: 768px min, tablet landscape, touch-first |
| — | Agent lives on Rafter side. SM8 is a dumb REST recipient. |
| — | job_description is append-only with delimiter markers. Never overwrite. |
| — | Rafter is stateless — no quote database. |
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

## Claude Chat / Claude Code split

**Claude Code owns:**
- File reads and writes (index.html, Workers, scripts)
- API verification calls (GET /staff.json, test POSTs, etc.)
- Bulk operations and SM8 cleanup scripts
- Anything requiring execution and real output

**Claude Chat owns:**
- Architecture decisions and sequencing
- Make.com configuration (UI-based — Code cannot touch it)
- Bug triage and prioritisation
- The issue tracker and continuation prompt

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

1. SM8 Inbox API binary PDF attachment support (VER-01)
2. SM8 OAuth scope for Inbox write access (VER-02)
3. SM8 job creation response body includes UUID (VER-03)

Do not build against any of these without verifying first. Check SM8 developer docs at
https://developer.servicem8.com or test against trial instance.

---

## Non-negotiable constraints

1. **Trial instance only** until T1-F2. Andy's live UUID must not be used.
2. **No client UUID, credential, or client-specific value hardcoded** in platform files.
3. **Rafter is stateless** — no quote database. Quotes live in SM8 only.
4. **job_description is append-only** with delimiter markers. Never overwrite.
5. **Agent on Rafter side only.** SM8 is a dumb REST recipient.
6. **768px minimum.** Touch-first. Mobile out of scope.
7. **No assumptions.** Flag for verification if not confirmed in this file.
8. **Citations required** for any external platform claim (API behaviour, endpoint shape, etc.).
