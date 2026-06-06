# Onboarding flow reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

### Onboarding flow (Flow E — connect-first, built 2026-06-05)

**Step sequence (onboarding.html):** Step 1 → Step 2 → Step 3 (provision) → Step 4 (photos) → Done

1. Client signs up at rafter.deepgreensea.au/sign-up — magic link, no password
2. Clerk session task flow prompts org creation → `org.created` webhook fires → admin-api creates stub KV record; clerk_org reverse index written
3. **Step 1 — Connect ServiceM8 (OAuth-first):** onboarding.html immediately prompts SM8 OAuth at `/setup.html`. This is the first thing the client does — without it, prefill cannot run. After OAuth, callback redirects to `onboarding.html?oauth_complete=1`.
4. **Step 2 — Review SM8 prefill:** onboarding.html calls `GET /onboarding/sm8-prefill` → admin-api fetches `vendor.json` (company_name + abn_number + billing_address), `jobtemplate.json` (sections), and `staff.json` (active staff) from SM8 in one `Promise.all`. Fields are populated and labelled SM8 ✓ or Manual. Business email and phone are always manual — SM8's `v.email` is a relay address, not a contact. Staff picker is required if SM8 returns staff.
5. **Step 3 — Configure Rafter:** operator enters payment thresholds, credentials, T&Cs, logo, webhook environment, operator email. POSTs to `/onboarding/provision` → KV record written, logo uploaded to R2, materials sync triggered, smoketest run.
6. **Step 4 — Photos (optional):** Category dropdown sourced from Step 2 sections + "General". File picker → Canvas resize (400px/JPEG q0.78, `createImageBitmap({imageOrientation:'from-image'})` for EXIF) → XHR upload with byte-level progress → POST `/onboarding/photos` → R2 `clients/{uuid}/photos/{category}/{filename}`. 10-concurrent, 30s watchdog per file, animated state chips, live status sentence. Skip-and-return supported.
7. Verification pass → Clerk public metadata marks onboarding complete → client lands on quoting form

**SM8 prefill field reliability (`workers/admin-api/index.js:handleSm8Prefill`):**
- `vendor.name` → `company_name` ✓ (reliable)
- `vendor.abn_number` → `abn` ✓ (reliable — bug was reading `v.abn` which is undefined; correct field is `v.abn_number`)
- `vendor.billing_address` → `business_address` (best-effort — may be empty)
- `business_email`: must-enter manually — `v.email` is a ServiceM8 relay address, not a business contact
- `phone`: must-enter manually — no usable phone field in vendor.json
- `logo`: must-upload manually — not available from SM8
- Tax rates: schema-confirmed only (not ingested)

**Onboarding gaps (RFT-53 analysis, 2026-06-05):**
- `staff_uuid`: SM8-fetched from `staff.json`, operator selects from picker — required if list non-empty ✓ (deployed d5a093c)
- `job_categories` / `job_queues`: confirmed dead — nothing in Make blueprint or live platform reads them from KV. **Do not add to onboarding.** Add only when a real consumer exists.
- `bank_details`: open gap — needs adding to Step 3 (deferred, not yet built)
- Photos: addressed by Step 4 (commit 7f41186)

**CORS requirement (bit us once — RFT-53):** Every `/onboarding/*` route requires CORS headers. The OPTIONS preflight handler (`admin-api/index.js:43`) and `withCors()` wrapper must cover any new `/onboarding/*` route. Omitting them produces a silent network error in the browser with no server-side log. Added after `cc221407` incident.

**Onboarding — client-facing surfaces that require KV fields to be correct before go-live:**
- `logo_url` + `company_name`: shown on the **PDF preview loading screen** (the branded interstitial the operator sees while the PDF renders). If `logo_url` is missing the loading screen falls back to `company_name` as text; if both are missing it falls back to "Rafter". Must be provisioned in step 5 before the operator uses the form.
- `logo_url` is also embedded in the PDF cover page and in the quote email template (`email_template` field). All three surfaces pull from the same KV field — one logo upload covers all.
