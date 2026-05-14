# Rafter — Continuation Prompt

## Purpose

This prompt provides complete context to pick up Rafter development in a new conversation with zero information loss. Paste the full contents into Claude Chat or Claude Code at the start of each new session.

---

## 1. What Rafter is

Rafter is an AI-assisted quoting and operations platform for Australian tradespeople, built by Deep Green Sea Pty Ltd (Will Thurlow). First client: Andy — 2 Men and a Shovel, Melbourne landscaper.

Operator: Will Thurlow. will@deepgreensea.au (Andy's SM8 instance). will@thurlow.net (trial instance).

Platform: Deep Green Sea Pty Ltd. deepgreensea.au. Cloudflare Pages at rafter.deepgreensea.au. GitHub: shikaishi/Rafter.

---

## 2. Architecture decisions (locked)

| ID | Decision |
|----|----------|
| D1 | Photos: Cloudflare R2, bucket `rafter-assets`, zero egress |
| D2 | PDF: Browser Rendering API via Worker |
| D3 | Client deduplication: deferred, SM8 native Merge Clients |
| D4 | Materials: KV cache 24hr TTL, nightly cron |
| D5 | Amendments: stateless regeneration + SM8 Inbox |
| D6 | Quote ref: `Q-YYYYMMDD-HHMM` |
| D7 | Template library: per-client KV |
| D8 | Onboarding: manual checklist Track 1, wizard Track 2 |
| D9 | PDF preview: new browser tab, non-destructive |
| D10 | Devices: 768px min, tablet landscape, touch-first |

Agent constraint: Agent lives on Rafter side. SM8 is a dumb REST recipient.

---

## 3. Current production components

| Component | Detail | Status |
|-----------|--------|--------|
| `setup.html` | OAuth initiation | Live |
| `callback.html` | OAuth callback — fires data retrieval, error handling on both steps | Live |
| `index.html` | Quoting form — trial instance | Live (prototype) |
| Make Account Discovery | Webhook: `hook.eu1.make.com/38k3vwhijsfun40uu3pmk942gdjnvj32` | Live |
| Make Data Retrieval | Webhook: `hook.eu1.make.com/hao3fhj1n2d1il4bhkkabozjwl892ujt` | Live |
| Make Rafter Form | Quote submission scenario | Live |
| `rafter-materials-sync` Worker | `https://rafter-materials-sync.will-8e8.workers.dev` | Live |
| `rafter-pdf` Worker | `https://rafter-pdf.will-8e8.workers.dev` | Live — pending visual sign-off |

---

## 4. Known issues — open

**Issue 3 — OAuth token refresh (T1-A3 partial)**

- Make scenarios use native SM8 connections — Make handles refresh automatically
- Data Retrieval scenario uses manual Bearer token from webhook payload — low risk, fires immediately after fresh OAuth
- Token storage in Make Data Store (Rafter Tokens) and KV both working

---

## 5. Verifications

| ID | Status |
|----|--------|
| V1 | ✅ Cloudflare Workers Paid plan active |
| V2 | ✅ Browser Rendering API — Playfair Display, Mulish, R2 images, page breaks all confirmed |
| V3 | Open — SM8 Inbox API PDF attachment support |
| V4 | Open — SM8 job creation API response includes job number/UUID |
| V5 | Open — SM8 OAuth scope for Inbox write access |

---

## 6. Andy's ServiceM8 account

| Item | Value |
|------|-------|
| Company UUID (live) | `010895db-e06c-465d-bce9-2424477be15b` |
| Trial UUID | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` |
| App ID | `781230` |

Trial UUID never used for Andy's live instance. Live UUID never touched until T1-F1 passes.

---

## 7. Andy's branding

| Element | Value |
|---------|-------|
| Primary dark green | `#0D2E1C` |
| Lime accent | `#84B741` |
| Light background | `#ECF1E8` |
| Heading font | Playfair Display Semi-Bold |
| Body font | Mulish Regular |
| Logo | Uploaded to R2: `clients/448e12a8-f7d9-4ace-b8c6-242bf678db3b/logo.png` |

---

## 8. Cloudflare infrastructure

| Item | Value |
|------|-------|
| R2 bucket | `rafter-assets` |
| KV namespace | `RAFTER_CLIENTS` |
| KV namespace ID | `7c7ad02d8136452eb6d03d1af89a684f` |
| wrangler.toml binding | `binding = "RAFTER_CLIENTS", id = "7c7ad02d8136452eb6d03d1af89a684f"` |
| Andy config source | `C:\Users\will\rafter-andy-config.json` |

**CRITICAL:** Never put `wrangler.toml` at repo root. All Workers live in `workers/<name>/` with their own `wrangler.toml`, deployed manually via `wrangler deploy` from that subdirectory.

---

## 9. Make scenarios

| Scenario | Purpose | Status |
|----------|---------|--------|
| Account Discovery | OAuth token exchange | Live — 5 modules: Webhook → HTTP SM8 token → Data Store write → HTTP `/store-token` → Webhook Response |
| Data Retrieval | Pulls SM8 data on callback | Live |
| Rafter Form | Quote submission | Live |

**Make Data Store:** "Rafter Tokens" — fields: `uuid`, `access_token`, `refresh_token`, `expires_at`. Key = trial UUID.

**`rafter-materials-sync` `/store-token` endpoint:**

- URL: `https://rafter-materials-sync.will-8e8.workers.dev/store-token`
- Auth: `Authorization: Bearer [RAFTER_WORKER_SECRET — see Drive copy for value]`
- Body: `{uuid, access_token, refresh_token, expires_at}`
- Called by Make Account Discovery after every OAuth flow

---

## 10. KV record for trial UUID

`client:448e12a8-f7d9-4ace-b8c6-242bf678db3b` contains:

- `uuid`, `company_name`, `branding`, `r2_photo_path`, `payment_thresholds`, `proposal_types`
- `job_categories`, `job_queues`, `templates` (26)
- `phone`: "(03) 9013 6588"
- `business_address`, `business_email`, `abn`
- `credentials[]` (15 items)
- `terms_and_conditions[]` (9 paragraphs)
- `access_token`, `refresh_token`, `expires_at`, `token_updated_at` (live — OAuth intact)

---

## 11. PDF Worker (T1-C1) — current state

**Worker:** `rafter-pdf` at `https://rafter-pdf.will-8e8.workers.dev`
**Location:** `workers/pdf/` in repo
**Status:** Preview mode working, visual sign-off PENDING — do not commit until approved

**Approved PDF design spec (locked):**

Typography:

- Playfair Display 600 — section headings (ALL CAPS), block headings, job title
- Mulish 700 — item names and prices only
- Mulish 400 — everything else
- All numbers in Mulish — no Playfair numerals

Colours: `#84B741` lime (phone, total, job title, "Prepared for" label, meta labels) · `#0D2E1C` dark green (section headings, block headings, payment percentages) · `#1a1a1a` item names · `#444` scope lines · `#999` asterisk notes

Cover page structure:

- Logo from R2 left · Business address/email/ABN right
- "PREPARED FOR" lime uppercase · Client name large · Full address including state and postcode
- Meta block right-aligned: Proposal / Date / Reference / Total — lime label + Mulish 400 value (NOT bold)
- Horizontal rule
- Job title Playfair lime — format: `{type} — {street}, {suburb}` — no state, no country, fits one line

Sections:

- Heading: Playfair 600 ALL CAPS dark green, border-bottom rule
- Item: name Mulish 700 mixed case left + price Mulish 700 right, border-bottom rule below name/price line, scope notes Mulish 400 below
- Asterisk notes `#999` 11px

Per-page header: page 1 only — phone left lime · total right lime. Pages 2+ have NO header.

Footer: page number right only, every page.

**Outstanding fixes required before commit (from last review of `york-output.pdf`):**

1. Logo — fetch from R2, render as `<img>` tag
2. Address — strip ", Australia"
3. Job title — one line, reduce size if needed
4. Meta block — Mulish 400 values (not bold), fix alignment
5. Item names — Mulish 700 mixed case, NOT all caps
6. Per-page header — remove from pages 2+, page 1 only
7. Totals block — missing, must appear after Lawn section before credentials
8. White space — remove forced page breaks, content flows naturally
9. Credentials spacing — too large, tighten to half-page or less
10. Credentials — remove first item ("2 Men and a Shovel are a reliable team...")
11. Credentials — item text Mulish 400 not bold

---

## 12. Materials sync Worker (T1-C2) — complete

**Worker:** `rafter-materials-sync` at `https://rafter-materials-sync.will-8e8.workers.dev`

**Endpoints:** `GET /health` · `GET /refresh-materials?uuid={uuid}` · `POST /store-token` (auth required) · Cron `0 10 * * *` UTC (8pm AEST)

**SM8 materials:** 117 items confirmed, field names: `uuid`, `name`, `price`, `active`, `barcode`, `item_number`, `cost`, `quantity_in_stock`, `price_includes_taxes`, `item_is_inventoried`, `edit_date`, `tax_rate_uuid`, `item_description`, `use_description_for_invoicing`

---

## 13. Photo library

- Source: `G:\My Drive\Rafter\Andy\Standardised Photos\`
- 289 files, 27 category folders, ~30MB, `Cleanup-Originals.ps1` already run
- Uploaded to R2: `clients/448e12a8-f7d9-4ace-b8c6-242bf678db3b/photos/[category]/[filename].jpg`
- Empty folders excluded: `14 Soil Prep and Planting`, `21 Pressure Cleaning`

---

## 14. PDF design research (T1-D0) — complete

Locked design decisions:

- Rafter's own neutral design language for operator form — not client brand colours
- Client logo + company name in header only
- Touch-first — 44px tap targets, high contrast, outdoor/tablet use
- PDF replicates Andy's current SM8 quote structure with specific improvements:
  - Item name/price on same line with rule below
  - Scope notes with breathing room
  - Trust credentials with green check bullets
  - Payment schedule as structured milestones with dollar amounts
  - No browser artifacts (no URL, no timestamp)
  - Materials list removed from client PDF (Andy confirmed comfortable with this)
  - Optional materials appendix toggle on form (`include_materials_appendix` flag)

---

## 15. Implementation plan — current status

### Track 1 — Andy go-live

**Group A — Complete ✅**

- T1-A1 ✅ Google Maps API key fixed
- T1-A2 ✅ Make Webhook Response — was already working
- T1-A3 ✅ Token refresh — Data Store built, Make native connections self-managing
- T1-A4 ✅ callback.html error handling uplift
- T1-A5 ✅ Cloudflare repo exposure fixed — no longer serving entire repo as public static files

**Group B — Complete ✅**

- T1-B1 ✅ 289 photos uploaded to R2
- T1-B2 ✅ KV client config loaded — namespace ID `7c7ad02d8136452eb6d03d1af89a684f`

**Group C — In progress**

- T1-C1 🔶 PDF Worker — preview mode working, visual sign-off pending, 11 fixes outstanding
- T1-C2 ✅ Materials sync Worker — live and verified end-to-end

**Group D — In progress**

- T1-D0 ✅ Design research complete — see §14
- T1-D1 ✅ PDF template design — approved in Chat, pending implementation sign-off via T1-C1
- T1-D2 ⬜ Quoting form rebuild — blocked on T1-C1 and T1-C2 (C2 done)

**Group E — Blocked**

- T1-E1 ⬜ Make Rafter Form Inbox delivery — blocked on V3 and V5

**Group F — Not started**

- T1-F1 ⬜ End-to-end acceptance test
- T1-F2 ⬜ Switch to Andy's live instance

### Track 2 — Not started

---

## 16. Toolchain notes

- Wrangler v4 KV CLI returns `[]` for `kv key list` even when namespace has keys. Use Cloudflare REST API directly for KV operations.
- Workers auto-deploy on git push is disabled (build command = `exit 0`). Workers deployed manually via `wrangler deploy` from `workers/<name>/` subdirectory only.
- `nodejs_compat` flag required for `rafter-pdf` Worker — `@cloudflare/puppeteer` imports `node:buffer`. `compat_date = 2024-09-23` minimum.

---

## 17. Session close state (May 11 2026)

- T1-C1 revised PDF (`york-output-v2`) generated but NOT yet reviewed — review is first task tomorrow
- Logo extracted from branding guide and uploaded to R2
- PDF design sign-off pending — do not commit `workers/pdf/` until review complete
- All other Workers committed and live
- RAFTER_WORKER_SECRET rotated — full value in Drive copy of this prompt only

---

## 18. First task tomorrow

1. Will uploads revised `york-output-v2.pdf` to Claude Chat for visual review
2. If approved — tell Claude Code to commit `workers/pdf/`
3. If changes needed — another round of fixes
4. Once T1-C1 committed — proceed to T1-D2 (quoting form rebuild)

---

Full secret values (RAFTER_WORKER_SECRET, OAuth credentials) are in the Drive copy only. Repo copy has placeholders.
