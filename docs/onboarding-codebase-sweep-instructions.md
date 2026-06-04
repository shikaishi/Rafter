# Code sweep — onboarding field requirements (run at start of RFT-53 session)

This is Claude Code's half of RFT-53. Chat does the conversation/Linear sweep in parallel.
Both outputs are merged before the form is built. Do NOT start building until both are done.

## Objective

Produce a comprehensive inventory of every field, value, and configuration item that is:
- Read from the client KV record by any Worker
- Written to the client KV record by any code path
- Used in PDF generation
- Used in Make (via /client-config or /render-email)
- Referenced in the smoketest assertions
- Present in the current onboarding form
- Present in Andy's live KV record (the canonical complete example)

The output must be detailed enough that a complete onboarding form can be built from it alone,
with no further research required.

---

## Sweep checklist — read every file listed, extract every field reference

### 1. Admin API — provisioning and smoketest
**File:** `workers/admin-api/index.js`

Extract:
- Every field in `REQUIRED_FIELDS` (line ~12) — these are the minimum for a "complete" record
- Every field read/written in `provisionClient()` — both `defaults` object and `OPTIONAL_FIELDS` array
- Every field checked in `runSmoketest()` — these are the fields the system actually depends on
- Every field in `runProvisioningGate()` — pre-OAuth checks
- The exact merge logic: which fields are overwritten by form submission vs preserved from the webhook stub

### 2. Materials sync — KV record consumer (the most important consumer)
**File:** `workers/materials-sync/index.js`

Extract:
- Every field returned by `/client-config` — this is what Make uses on every form submission
- Every field returned by `/client/{uuid}` — sanitised public record
- Every field read in `refreshTokenIfNeeded()` — token fields
- Every field read in `handleRenderEmail()` — email template fields and merge variables
- Every field written in `handleStoreToken()` — OAuth token fields
- Every field read in the nightly cron / materials sync
- The `readClient()` and `writeClient()` helpers — what they assume about the record shape

### 3. PDF Worker — client fields used in PDF rendering
**File:** `workers/pdf/index.js`

Extract:
- Every `client.*` field referenced in `buildHtml()` and `renderSections()`
- The full client object shape that the PDF worker expects
- Font, colour, and branding fields used
- Payment schedule rendering — what fields drive it
- Bank details — is `bank_details` a KV field or form-payload field?

### 4. Site Worker — quoting form
**File:** `workers/rafter/index.html`

Extract:
- Every client field fetched from `/client/{uuid}` or `/client-config` on page load
- Every field displayed to the operator (company name, logo, etc.)
- Every field sent in the PDF payload that originates from the KV record vs the form

### 5. Current onboarding form — what's already there
**File:** `workers/rafter/onboarding.html`

Extract:
- Every `<input>`, `<textarea>`, `<select>` with its `name`/`id` — the current form fields
- Every field in the payload built in `handleSubmit()` — what actually gets sent to the Admin API
- What's visibly missing compared to the REQUIRED_FIELDS and provisionClient() OPTIONAL_FIELDS lists

### 6. Setup / OAuth
**File:** `workers/rafter/setup.html`

Extract:
- The full SM8 OAuth scope string — every scope listed
- Which scopes are currently missing for RFT-32 (manage_jobs, publish_job_attachments, read_attachments)
- The `staff_uuid` selection flow — is it captured at OAuth time or separately?

### 7. Wrangler configs — all workers
**Files:** `workers/*/wrangler.toml`

Extract:
- All bindings (KV, R2, D1, service bindings) across all workers
- All `[vars]` — any non-secret config values
- Confirm PDF_WORKER binding is in admin-api (added 2026-06-04)

### 8. Live KV record — Andy's complete record (the canonical example)
Use the Cloudflare MCP `kv_get` tool to read `client:0e604a45-84fd-4789-a2cb-662bcba51a8b` from
KV namespace `RAFTER_CLIENTS` (ID: `7c7ad02d8136452eb6d03d1af89a684f`).

**⚠️ READ ONLY. This is the production record. Do not write.**

Extract:
- Every top-level key in the JSON — this is the ground truth for what a complete record looks like
- The exact structure of `payment_thresholds` (6-tier object)
- The exact structure of `credentials[]` — how many items, what each item looks like
- The exact structure of `terms_and_conditions[]` — how many items, format
- The exact structure of `templates[]` — how many items, what fields each has (name + text?)
- The `email_template` value — what merge fields are in it
- The `bank_details` field — does it exist? What shape?
- Any fields present in Andy's record that are NOT in REQUIRED_FIELDS or OPTIONAL_FIELDS in the code

### 9. Make blueprint — fields consumed by Make
**File:** `make-blueprints/rafter-form-prod-2026-05-21-final.json` (if it exists)

Or use the Make API (token in `.env`):
```
GET https://eu1.make.com/api/v2/scenarios/5537814/blueprint
Authorization: Token {MAKE_API_TOKEN}
```

Extract:
- Every field Make reads from `/client-config` response
- Every field Make reads from the PDF payload (the form submission)
- The M3 `company_uuid` expression — what fields it uses
- The email render step — what merge fields are referenced
- Any field referenced in Make that isn't clearly provided by the KV record or form payload

---

## Output format

Produce two outputs:

### Output 1: Field inventory table

| Field | Source | Read by | Written by | Type | In Andy's record? | In current form? | Notes |
|-------|--------|---------|------------|------|-------------------|------------------|-------|

Where:
- **Source** — KV record / OAuth / Form payload / SM8 API / Clerk / System-generated
- **Read by** — which workers read this field (pdf, materials-sync, admin-api, index.html, Make)
- **Written by** — which code path writes this (provisionClient, storeToken, materialsSync, etc.)
- **In Andy's record?** — Yes / No / Unknown
- **In current form?** — Yes / No / Admin-only

### Output 2: Gaps and anomalies

List every field that is:
- Read by a worker but not collected in the form and not set by any other code path (silent failure risk)
- In Andy's record but not in any code's REQUIRED_FIELDS or OPTIONAL_FIELDS (orphaned field)
- In the form but not read by any worker (dead field)
- Referenced in Make but not clearly sourced from KV or form payload
- Any shape mismatch between what a worker expects and what the form currently sends

---

## After the sweep

Merge this output with Chat's conversation/Linear output into a single definitive requirements table.
Then present the merged table to Will for review before writing any form code.
The merged table becomes the source of truth for the complete onboarding form.
