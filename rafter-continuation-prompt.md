# Rafter — Continuation Prompt

## Purpose
This prompt provides complete context to pick up Rafter development in a new conversation with zero information loss. Paste the full contents into Claude Chat or Claude Code at the start of each new session. Sections marked [VERIFY BEFORE USE] must be checked against current state before acting.

**Last updated:** 2026-05-10 (end of day, post T1-C2)

> **Note for next session:** This file is a redacted copy committed to a public repo. The live `RAFTER_WORKER_SECRET` value, any future credentials, and any other sensitive material live ONLY in the full version at `G:\My Drive\Rafter\Product & Architecture\rafter-continuation-prompt.md`. When pasting into Claude, paste the Drive version — it has everything. This repo copy is the version-controlled snapshot.

---

## 1. What Rafter is

Rafter is an AI-assisted quoting and operations platform for Australian tradespeople, built by Deep Green Sea Pty Ltd (Will Thurlow). It is not an AI product — it is Will leveraging AI as a capability multiplier to deliver outcomes that improve how tradespeople work.

**First client:** Andy — 2 Men and a Shovel, Melbourne landscaper. Andy's live ServiceM8 instance is not a playground. All development and testing happens on Will's trial instance.

**Trial instance UUID:** `448e12a8-f7d9-4ace-b8c6-242bf678db3b` (Will's trial SM8 — `will@thurlow.net`). Use this UUID for all dev work.
**Andy's live instance UUID:** `010895db-e06c-465d-bce9-2424477be15b` — DO NOT USE until T1-F1 passes.

**Operator:** Will Thurlow. Email: `will@deepgreensea.au` (Will's staff account on Andy's SM8 instance). `will@thurlow.net` is Will's trial instance.

**Platform:** Deep Green Sea Pty Ltd. Domain: deepgreensea.au. Hosting: Cloudflare. GitHub: `shikaishi/Rafter` (auto-deploys on push to main via Cloudflare git-deploy on the `rafter` Worker — see §10 for the critical no-wrangler.toml-at-root rule).

---

## 2. Architecture — confirmed decisions (all locked, do not reopen)

| ID | Decision | Detail |
|----|----------|--------|
| D1 | Photo library: Cloudflare R2 | Zero egress. Per-client path: `clients/{uuid}/photos/`. Andy: ~30MB, 289 files, 27 folders. Free tier: 10GB/month. Workers Paid plan required. |
| D2 | PDF generation: Browser Rendering API via Worker | Headless Chromium. 10hr/month free. Preview mode (new tab, non-destructive) + submit mode (binary to Make). V2 verification ✅. |
| D3 | Client deduplication: deferred | SM8 native Merge Clients function. Operator process note. No Rafter build. |
| D4 | Materials sync: KV cache, 24hr TTL, nightly cron | Cloudflare KV. Nightly cron 8pm AEST (`0 10 * * *` UTC). Manual refresh endpoint from form. No SM8 API call on form load. ✅ |
| D5 | Amendment flow: stateless regeneration + SM8 Inbox | First quote to SM8. Amendments: fresh regeneration → POST `/api_1.0/inboxmessage.json` → Andy reconciles manually. Job record not mutated after first write. V3 verification required. |
| D6 | Quote reference: `Q-YYYYMMDD-HHMM` | Generated at form load. Amendments append `-v2`. Written into PDF and `job_description`. |
| D7 | Template library: per-client extraction to KV | SM8 API returns name/UUID only. Manual extraction permanent. Andy's 26 templates in Drive doc `1OlUbpL-4pcQ2YEtJkPauDlurN-pigl0hHeBpDetedQ0`. |
| D8 | Onboarding: Rafter Onboarding | Manual checklist for Andy (Track 1). Automated wizard Track 2 (T2-2). |
| D9 | PDF preview: new browser tab, non-destructive | Preview button → PDF Worker → blob → new tab. Separate from submit action. |
| D10 | Supported devices: tablet landscape + laptop | 768px minimum. Desktop-first. Mobile out of scope. |

**Agent constraint (settled):** Agent lives on Rafter side. ServiceM8 is a dumb REST recipient. SM8 MCP server: monitor-only, P3, quarterly review.

---

## 3. Current production components [VERIFY BEFORE USE]

| Component | Detail | Status |
|-----------|--------|--------|
| `setup.html` | OAuth initiation — `rafter.deepgreensea.au/setup` | Live |
| `callback.html` | OAuth callback — exchanges code via Make, awaits data webhook (T1-A4 fix) | Live |
| `index.html` | Quoting form — pointed at trial instance | Live (prototype only — T1-D2 will rebuild) |
| Worker `rafter` | Serves static HTML at `rafter.deepgreensea.au`. Auto-deploys from `main` on every push (Cloudflare git-deploy: build `exit 0`, deploy `npx wrangler deploy`). **Currently publishes the entire repo as static files** — see Issue 4 in §4. | Live |
| Worker `rafter-materials-sync` | Token store + materials sync. Full details in §14. | Live (T1-C2) |
| KV namespace `RAFTER_CLIENTS` | id `7c7ad02d8136452eb6d03d1af89a684f`. Holds `client:{uuid}` config + tokens, and `materials:{uuid}` cache (24h TTL). | Live |
| R2 bucket `rafter-assets` | 283 photos under `clients/448e12a8-…/photos/{folder}/{filename}`. | Live (T1-B1) |
| Make Account Discovery | Webhook URL — see Drive copy of this prompt for full URL. | Live (T1-A2 fixed) |
| Make Data Retrieval | Webhook URL — see Drive copy of this prompt for full URL. | Live |
| Make Rafter Form | Quote submission scenario | Live |
| Make Rafter Tokens (Data Store) | Per-client SM8 OAuth tokens. Make's native connections handle refresh. | Live (T1-A3) |
| Make → `/store-token` bridge | After each OAuth/refresh, Make posts the token to `rafter-materials-sync` so it lands in `client:{uuid}` in KV. | Live |
| Email routing | `will@deepgreensea.au` → operator's gmail | Live |
| Cloudflare account ID | `8e87fd293978a1508cb38e414e766058` (`Will@thurlow.net's Account`) | — |

---

## 4. Open issues

**Issue 4 — Cloudflare git-deploy exposes entire repo as public static files (T1-A5, blocker for T1-C1)**
- Problem: the `rafter` Worker's git-deploy is publishing every file in the repo at `rafter.deepgreensea.au`. Verified 2026-05-10: `GET /.gitignore` → 200, `GET /workers/materials-sync/index.js` → 200 (Worker source code publicly readable). This is why this prompt's repo copy is REDACTED.
- Impact: any future credential, config, or sensitive code committed to the repo is publicly retrievable. The current Worker source exposes the auth scheme and KV key conventions but no live secret value.
- Fix: Cloudflare dashboard → Workers & Pages → `rafter` → Settings → Build → restrict served files to `*.html` only via a `_headers`/`_redirects` file, asset manifest, or a "Build output directory" setting. Alternative: move all Worker source out of the repo entirely.
- **TRACK 1 BLOCKER — must be resolved before T1-C1 PDF Worker source is committed.**

(Issues 1–3 from prior versions of this prompt — Maps API key, Make webhook response, OAuth refresh — are all resolved; see §9.)

---

## 5. Verifications required before specific items can commit

| ID | Verification | Required before | Status |
|----|-------------|-----------------|--------|
| V1 | Cloudflare Workers Paid plan active | T1-B1, T1-C1 | ✅ done |
| V2 | Browser Rendering API: Playfair Display, Mulish, R2 image, page breaks, valid PDF | T1-D1 (template design lock) | ✅ done — Playfair Display Semi-Bold and Mulish (variable, weight 400) embedded as font subsets, 1 JPEG image from R2 rendered via DCTDecode, page-break-before honoured (2 pages), 361 KB PDF, %PDF-1.4 magic, %%EOF terminator, content-type `application/pdf`. |
| V3 | SM8 Inbox API PDF attachment support on POST `/api_1.0/inboxmessage.json` | T1-E1 | open |
| V4 | SM8 job creation API response includes job number/UUID | Pre-Track-2 | open |
| V5 | SM8 OAuth scope for Inbox write access | T1-E1 | open |

---

## 6. Andy's ServiceM8 account — confirmed data

| Item | Value |
|------|-------|
| Company UUID | `010895db-e06c-465d-bce9-2424477be15b` |
| App ID | 781230 |
| OAuth scopes | `vendor, vendor_logo, read_staff, read_inventory, read_job_categories, read_job_queues, manage_templates, manage_badges, read_tax_rates, read_forms, read_customers, read_jobs` |
| Job templates | 26 active — extracted to Drive doc `1OlUbpL-4pcQ2YEtJkPauDlurN-pigl0hHeBpDetedQ0` (also in `client:{trial-uuid}` config in KV) |
| Categories | Standard, VIP, Warranty, After-Hours |
| Queues | Workshop, Pending Quotes, Parts on Order |
| Document templates | Invoice, Quote, Work Order |
| Staff | Andy + `will@deepgreensea.au` + others |
| Proposal types | Landscape construction (LC), Garden maintenance (GM) |
| Payment thresholds | <$15K = 50/50 · $15K–$50K = 20/60/20 · >$50K = 5/progress/final |
| SM8 materials shape | Verified 2026-05-10 against trial instance: JSON array, 117 items. Per-object fields: `uuid, name, price, cost, active, barcode, item_number, quantity_in_stock, price_includes_taxes, item_is_inventoried, edit_date, tax_rate_uuid, item_description, use_description_for_invoicing` |

---

## 7. Andy's branding

| Element | Value |
|---------|-------|
| Primary dark green | #0D2E1C |
| Lime accent | #84B741 |
| Light background | #ECF1E8 |
| Heading font | Playfair Display Semi-Bold |
| Body font | Mulish Regular |

---

## 8. Photo library — current state

- **Source:** `G:\My Drive\Rafter\Andy\Standardised Photos\`
- 289 files, 27 category folders (01–27 numbered), ~30MB optimised
- **Catalogue:** `G:\My Drive\Rafter\Andy\photo-library-catalogue.csv`
- **Toolkit:** `G:\My Drive\Rafter\Photo Optimiser\` (`Optimize-Photos.ps1`, `Reorganise-Photos.ps1`, `Cleanup-Originals.ps1`, `Upload-PhotosToR2.ps1`)
- Empty folders: 14 Soil Prep and Planting, 21 Pressure Cleaning — excluded
- **Status (2026-05-10):** ✅ 283 of 289 uploaded to R2 under `clients/448e12a8-f7d9-4ace-b8c6-242bf678db3b/photos/{folder-name}/{filename}`. Brand/type subfolders inside `03 Paving Fixed` and `24 Plants` were flattened (filenames are uniquely standardised so no collisions).
- **Open follow-up:** the 6 files in `Confirm with Andy/` are NOT uploaded — folder name flags they need Andy's call on categorisation. Decide before listing them in the form.
- **Stale artifact:** `G:\My Drive\Rafter\Photo Optimiser\Upload-PhotosToR2.failures.csv` from a buggy first upload run. All 283 files succeeded on the retry; the CSV is 283 fake-failure rows from the bug. Delete manually.

---

## 9. Implementation plan — full item reference

### Track 1 — Andy go-live (dependency order)

**Group A — Fix known issues (prerequisite for everything)**
- T1-A1: Fix Google Maps API key — ✅ done (referrer added in Google Cloud Console)
- T1-A2: Fix Make Webhook Response — ✅ done (Make returns JSON with `access_token` + `expiry`, status 200)
- T1-A3: OAuth token refresh — ✅ done (Make Data Store + Make's native connections handle refresh; `/store-token` bridge syncs into KV)
- T1-A4: callback.html error handling uplift — ✅ done (commit `02015f6` — awaits data webhook, surfaces failures via existing error UI)
- **T1-A5: Restrict rafter Worker file exposure** — **OPEN, blocks T1-C1 commit.** See §4 Issue 4.

**Group B — Infrastructure**
- T1-B1: Upload Andy photos to R2 — ✅ done (283 files; 6 in `Confirm with Andy/` pending)
- T1-B2: Load Andy client config into KV — ✅ done. Namespace `RAFTER_CLIENTS` id `7c7ad02d8136452eb6d03d1af89a684f`. Key `client:448e12a8-f7d9-4ace-b8c6-242bf678db3b` holds branding, payment_thresholds, proposal_types, job_categories, job_queues, 26 templates, r2_photo_path. Token fields are merged in by `/store-token`.

**Group C — Cloudflare Workers**
- **T1-C1: Build PDF generation Worker** — **next, code-unblocked.** V2 ✅. Two modes: preview (blob) + submit (binary to Make). Delimiter markers in `job_description` content. **DO NOT commit Worker source until T1-A5 is resolved.** Build and test locally first; deploy via `wrangler deploy` from a per-Worker subdir (NOT root).
- T1-C2: Build materials Sync Worker — ✅ done. Full details in §14.

**Group D — Quoting form**
- **T1-D0 (NEW): Design research** — empirical evidence on what makes professional B2B forms and field-service UIs feel premium and trustworthy ("these guys know what they're doing" reaction from trade users). Output feeds T1-D1 + T1-D2. Research and reference gathering only, no build. Pre-T1-D1 / pre-T1-D2.
- T1-D1: Design PDF quote template — Andy's 11 real proposals as reference. A4 portrait, page breaks between sections. Depends on T1-D0 + V2 (V2 ✅).
- T1-D2: Rebuild `index.html` quoting form — full feature set: client details, proposal type (LC/GM), template section selector, photo gallery from R2, line items from KV, payment schedule auto-calc, Preview / Submit / Send-to-Inbox buttons, materials refresh button. 768px minimum. Trial instance only until T1-F1. Depends on T1-D0 + T1-B2 + T1-C1.

**Group E — Make scenarios (parallel with D2)**
- T1-E1: Update Make Rafter Form for Inbox delivery path — V3 + V5 required first. Router on `delivery_type` flag: `job` vs `inbox`.

**Group F — Go-live gate**
- T1-F1: End-to-end acceptance test on trial instance — all 8 paths: LC-1, LC-2, GM-1, GM-2, AMD-1, AMD-2, ERR-1, ERR-2. All must pass before switching to Andy's live instance.
- T1-F2: Switch to Andy's live instance + operator handover — KV UUID switch, push to main (post T1-A5 fix), smoke test, deliver process notes to Andy.

### Track 2 — Platform foundation (after Andy go-live)

- T2-1: Formalise client config schema — versioned JSON schema, validation function
- T2-2: Build Rafter Onboarding wizard — 9-step guided flow, depends on T2-1 and T2-3
- T2-3: Build automated acceptance test suite — 7 assertions, cron weekly, email alert to Will
- T2-4: Build operator monitoring dashboard — client status cards, sync timestamps, token expiry, manual refresh
- T2-5: Build template editor — in operator dashboard, authenticated KV write, change log
- T2-6: Agentic onboarding research and scoping — scoping document only, not build. After T2-2.

---

## 10. Architectural & infra constraints — non-negotiable

1. Andy is the first client, not the only client. Every component must be designed for reuse. Andy-specific config lives in KV, never hardcoded.
2. No client UUID, credential, or client-specific value may be hardcoded in platform files.
3. Rafter is stateless — no quote database. First quote writes to SM8. Amendments deliver to SM8 Inbox. No state stored in Rafter.
4. Agent lives on Rafter side. ServiceM8 is a dumb REST recipient.
5. `job_description` is append-only. Rafter wraps all content in delimiter markers: `--- RAFTER QUOTE [ref] --- ... --- END RAFTER QUOTE ---`. Never overwrite content outside markers.
6. All development and testing on Will's trial instance. Andy's live instance UUID (`010895db-e06c-465d-bce9-2424477be15b`) not touched until T1-F1 passes. Trial UUID: `448e12a8-f7d9-4ace-b8c6-242bf678db3b`.
7. Minimum viewport 768px. Desktop-first. Mobile explicitly out of scope.
8. No assumptions about platform capabilities — if not confirmed in this document, flag it as requiring verification before committing.
9. Citations required for external platform capabilities. No guessing.
10. **NO `wrangler.toml` at repo root.** The `rafter` Worker has Cloudflare git-deploy enabled with deploy command `npx wrangler deploy`. Any wrangler.toml at root is picked up post-push and overwrites the `rafter` Worker, taking down `rafter.deepgreensea.au/setup.html` and `/callback.html`. All Worker configs must live in `workers/<name>/wrangler.toml` and be deployed manually via `wrangler deploy` from inside that subdir. Recovery from accidental overwrite: roll the `rafter` Worker back to the previous version via Cloudflare API (POST `/accounts/{id}/workers/scripts/rafter/deployments` with the prior version_id).
11. **Until T1-A5 is fixed:** the `rafter` Worker publishes ALL repo files as public static assets at `rafter.deepgreensea.au/<path>`. Do NOT commit anything sensitive. New Worker source can be developed locally and deployed via `wrangler deploy`, but its source files must NOT be pushed to GitHub until T1-A5 lands.

---

## 11. Key file locations

| Item | Location |
|------|----------|
| Architecture schematics (3 files) | `G:\My Drive\Rafter\Product & Architecture\` |
| Implementation plan / decision log updates | `G:\My Drive\Rafter\Product & Architecture\` |
| **This continuation prompt — full** | `G:\My Drive\Rafter\Product & Architecture\rafter-continuation-prompt.md` |
| **This continuation prompt — redacted (no live secret)** | `shikaishi/Rafter` repo root: `rafter-continuation-prompt.md` |
| Onboarding checklist | `G:\My Drive\Rafter\Product & Architecture\` |
| Andy's job templates / template library (Drive doc) | id `1OlUbpL-4pcQ2YEtJkPauDlurN-pigl0hHeBpDetedQ0` |
| Photo catalogue CSV | `G:\My Drive\Rafter\Andy\photo-library-catalogue.csv` |
| Photo optimiser toolkit | `G:\My Drive\Rafter\Photo Optimiser\` |
| Photo R2 upload script | `G:\My Drive\Rafter\Photo Optimiser\Upload-PhotosToR2.ps1` |
| Rafter decision log (Sheets) | id `1ZFBQSHiZzs-ZGKYaqpw2WfzQr86BBGBSZ9oG-7bQt5Y` |
| GitHub repo | `shikaishi/Rafter` (cloned at `C:\Users\will\Documents\GitHub\Rafter`) |
| materials-sync source | `workers/materials-sync/index.js` + `workers/materials-sync/wrangler.toml` |
| Cloudflare account ID | `8e87fd293978a1508cb38e414e766058` |
| KV namespace `RAFTER_CLIENTS` id | `7c7ad02d8136452eb6d03d1af89a684f` |
| R2 bucket | `rafter-assets` |
| Local toolchain | gh CLI v2.92.0, Node v24.15.0, wrangler v4.90.0 |
| Wrangler OAuth config | `%USERPROFILE%\.wrangler\config\default.toml` (newer location, supersedes `%APPDATA%\xdg.config\.wrangler\config\default.toml`) |

---

## 12. State at session close (2026-05-10)

**Done today:**
- T1-A1 ✅ Google Maps API key referrer added
- T1-A2 ✅ Make Webhook Response now returns JSON
- T1-A3 ✅ OAuth refresh via Make Data Store + native connections
- T1-A4 ✅ callback.html awaits data webhook + surfaces failures (commit `02015f6`)
- V1 ✅ Cloudflare Workers Paid plan confirmed active
- V2 ✅ Browser Rendering API verified end-to-end
- T1-B1 ✅ 283 photos uploaded to R2 (6 `Confirm with Andy` pending)
- T1-B2 ✅ Andy config in KV under `client:448e12a8-…`
- T1-C2 ✅ `rafter-materials-sync` Worker deployed and end-to-end tested (117 materials returned; KV `materials:{uuid}` written with 24h TTL)
- (Incident:) `rafter` Worker briefly overwritten by my T1-C2 deploy via Cloudflare git auto-deploy reading wrangler.toml at repo root. Rolled back via Cloudflare API to the prior version. Wrangler.toml moved to `workers/materials-sync/wrangler.toml`. Constraint added (§10 #10).
- (Discovery:) the `rafter` Worker publishes the entire repo as public static files. New issue T1-A5 added (§4).

**Open Track 1 work for next session:**
- **T1-A5** — restrict `rafter` Worker file exposure (BLOCKS committing T1-C1 source)
- **T1-D0** — design research (independent, can start immediately)
- **T1-C1** — PDF Worker (V2 done; build code locally; do not commit until T1-A5 fixed)
- V3, V4, V5 — verifications still open (need SM8 Inbox testing)
- Operator follow-ups: delete stale `Upload-PhotosToR2.failures.csv` on Drive, decide on the 6 `Confirm with Andy` photos

**Repo state:** clean on main as of 2026-05-10, last commit (will be filled in by the close-out commit). materials-sync Worker source lives at `workers/materials-sync/`. Cron registered in Cloudflare for `rafter-materials-sync` at `0 10 * * *` UTC.

---

## 13. Instruction for Claude in the new conversation

You are working on Rafter — an AI-assisted quoting platform for Australian tradespeople built by Deep Green Sea Pty Ltd. Architecture session is complete. Implementation phase is well underway.

**Read this whole prompt before starting. Do not ask Will what to do unless something is genuinely ambiguous. Lead.**

**Logical next-action priority:**
1. **T1-A5 first** — fix the `rafter` Worker's file-exposure config. Operator task in the Cloudflare dashboard. Claude Code can describe the steps and verify the fix worked by re-running the curl probes from §4.
2. **T1-D0 in parallel** — design research can run alongside while T1-A5 is being addressed. Pure research, no infra needed.
3. **T1-C1** — build the PDF generation Worker locally. V2 is done so the code path is unblocked. Hold the commit/push until T1-A5 is resolved.

If Will opens with "let's get to work", start working on T1-A5 / T1-D0 in parallel as appropriate.

If Will tells you something has changed since session close (a task completed, a verification done, an issue resolved) — update your understanding and adjust accordingly.

**Rules that apply to every response:**
- No assumptions about platform capabilities. If a capability is not confirmed in this prompt, flag it as requiring verification before proceeding.
- Verification before build. No implementation item commits until its dependencies and verifications are complete.
- Trial instance only. All testing on Will's trial instance. Andy's live instance UUID is never used until T1-F1 passes.
- Citations required. Any claim about a platform or API capability must be verified and cited.
- Append-only on `job_description`. Never write code that could overwrite content outside Rafter delimiter markers.
- Complete the whole thing. No partial implementations. No dangling threads. No workarounds when the real fix exists.
- Do not hold back waiting for permission. If the next action is clear and the dependencies are met, do it.
- **Until T1-A5 lands, treat the repo as fully public.** Do not commit Worker source, secrets, tokens, or anything you wouldn't paste to a public GitHub gist.

---

## 14. T1-C2 — Materials Sync Worker (full reference)

**Worker URL:** `https://rafter-materials-sync.will-8e8.workers.dev`
**Repo location:** `workers/materials-sync/index.js` + `workers/materials-sync/wrangler.toml`
**Cron:** `0 10 * * *` UTC (8pm AEST nightly)
**KV binding:** `RAFTER_CLIENTS` → namespace id `7c7ad02d8136452eb6d03d1af89a684f`
**Compatibility date:** `2024-01-01`

**Endpoints:**
- `GET /health` → `{"ok":true}`
- `POST /store-token` (auth required via `Authorization: Bearer <secret>`)
  - Body: `{uuid, access_token, refresh_token?, expires_at?}`
  - Reads `client:{uuid}` from KV → 404 if missing
  - Merges token fields into existing config, also writes `token_updated_at` timestamp
  - Writes back without TTL (config has no expiry)
  - Returns `{ok, uuid, token_updated_at}`
- `GET /refresh-materials?uuid=<uuid>` (no auth — see security note below)
  - Reads `client:{uuid}` → 404 if missing, 412 if no token stored
  - GET `https://api.servicem8.com/api_1.0/material.json` with Bearer
  - 401 from SM8 → returns 401 with `token_expired`
  - 200 → writes `materials:{uuid}` with 86400s TTL
  - Returns `{ok, uuid, shape, count, sample_fields, ttl_seconds}`
- Cron handler — lists all `client:*` keys (cursor-paginated), syncs each in isolated try/catch so one failure doesn't kill the rest. Logs JSON summary `{event: "materials_sync", total, ok, skipped, failed, results}`.

**Auth:**
- Bearer secret on `/store-token` via Worker env var `RAFTER_WORKER_SECRET`.
- **Secret value:** `[REDACTED — see Drive copy of this prompt at G:\My Drive\Rafter\Product & Architecture\rafter-continuation-prompt.md]`
- Set in Cloudflare via `wrangler secret bulk <json-file>` — NOT via PowerShell pipe (pipe adds trailing newline that breaks comparison).
- `/refresh-materials` is currently unauthenticated by design (operator-facing). If exposed to browser-side calls, route via Make for auth.

**SM8 materials shape (verified 2026-05-10):**
- Endpoint: `GET https://api.servicem8.com/api_1.0/material.json`
- Returns: JSON array
- Trial-instance count: 117 items
- Per-object fields: `uuid, name, price, cost, active, barcode, item_number, quantity_in_stock, price_includes_taxes, item_is_inventoried, edit_date, tax_rate_uuid, item_description, use_description_for_invoicing`

**Make wiring (configured 2026-05-10):**
- POST URL: `https://rafter-materials-sync.will-8e8.workers.dev/store-token`
- Header: `Authorization: Bearer [REDACTED — see Drive copy]`
- Header: `Content-Type: application/json`
- Body: `{uuid, access_token, refresh_token?, expires_at?}`
- Triggered after each successful OAuth flow / token refresh in the Rafter Tokens Data Store

**Deployment process:**
1. `cd C:\Users\will\Documents\GitHub\Rafter\workers\materials-sync`
2. `wrangler deploy` (uses local wrangler.toml in this subdir)
3. Never deploy from repo root. Never put a wrangler.toml at repo root.

---

## 15. Local toolchain notes (gotchas to remember next session)

- Wrangler v4 stores OAuth at `%USERPROFILE%\.wrangler\config\default.toml`. The older path `%APPDATA%\xdg.config\.wrangler\config\default.toml` may exist but is stale; always read from `%USERPROFILE%`.
- Wrangler refuses OAuth tokens in non-interactive shells. To call wrangler from a non-interactive PowerShell session, read `oauth_token` from the toml and export as `CLOUDFLARE_API_TOKEN`. Also export `CLOUDFLARE_ACCOUNT_ID = 8e87fd293978a1508cb38e414e766058`.
- Wrangler tries to mkdir `.wrangler\cache` under cwd. Google Drive (`G:\`) refuses dotfile dirs at root. `Set-Location $env:USERPROFILE` (or any local-disk writable dir) before wrangler invocations.
- `$secret | wrangler secret put NAME` adds a trailing newline to the value via PowerShell pipe — wrong secret stored, auth check fails 401. Use `wrangler secret bulk <json-file>` for clean writes.
- Wrangler OAuth expires after 1 hour. If the API errors with `Authentication error code 10000`, the user runs `wrangler whoami` in an interactive PowerShell window (NOT inside Claude Code's non-interactive shell) to refresh — that rewrites `default.toml` with a fresh `oauth_token`.
- PS 5.1's `Get-Date -UFormat %s` returns local time as if it were UTC (timezone bug). Use `[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()` for correct epoch math.
- PS 5.1's `Invoke-WebRequest` defaults to IE-rendering mode in some environments and fails non-interactively. Pass `-UseBasicParsing` always.
- The Drive paths under `G:\My Drive\` have a delete-protection hook. Files can be created/written via the Write tool but cannot be deleted from inside Claude Code — operator must delete manually.

---

## 16. Cloudflare API reference for incident recovery

If the `rafter` Worker is accidentally overwritten again (e.g. by a future commit that puts a wrangler.toml at root before T1-A5 lands):

1. List versions: `GET /accounts/{account_id}/workers/scripts/rafter/versions` — find the version_id from BEFORE the bad deploy (look at `metadata.created_on`).
2. Roll back: `POST /accounts/{account_id}/workers/scripts/rafter/deployments` with body:
   ```json
   {
     "annotations": {"workers/message": "rollback - <reason>"},
     "strategy": "percentage",
     "versions": [{"version_id": "<good-version-id>", "percentage": 100}]
   }
   ```
3. Verify with `curl https://rafter.deepgreensea.au/setup.html` — should return 200 with HTML, not the materials-sync 404 JSON.

---
