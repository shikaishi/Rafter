# Rafter — Client Onboarding Checklist

Use this document for every new Rafter client. Complete every step in order. Do not skip ahead.
Replace `{uuid}` and `{slug}` with the client's values throughout.

Reference implementations:
- Trial/dev: `448e12a8-f7d9-4ace-b8c6-242bf678db3b` / slug `andy` (will@thurlow.net SM8 instance)
- Andy live: `0e604a45-84fd-4789-a2cb-662bcba51a8b` / slug `andy` (Andrew Little — 2 Men and a Shovel)

---

## Section 1 — Prerequisites

- [ ] SM8 developer account access confirmed at developer.servicem8.com (app ID 781230 already registered)
- [ ] Client has an active ServiceM8 account and can log in
- [ ] Client SM8 company UUID obtained
  - Method: ask client to log in to SM8 → Settings → Account → Company UUID field
  - OR: call `GET https://api.servicem8.com/api_1.0/company.json` with a temporary admin token
  - Record: `{uuid}` = ________________________________
- [ ] Slug chosen — short, lowercase, no spaces (e.g. `andy`, `jim-lawns`, `cityroofing`)
  - Record: `{slug}` = ________________________________
- [ ] Client branding collected:
  - Primary colour (dark, hex): ________________________
  - Accent colour (hex): ________________________
  - Background colour (hex): ________________________
  - Heading font name: ________________________
  - Body font name: ________________________
- [ ] Client logo uploaded to R2 at `clients/{uuid}/logo.png` (Cloudflare dashboard → R2 → rafter-assets)
- [ ] Operator notification email address confirmed: ________________________

---

## Section 2 — Cloudflare KV Record Creation

Create key `client:{uuid}` in KV namespace **RAFTER_CLIENTS** (ID: `7c7ad02d8136452eb6d03d1af89a684f`).

**CRITICAL — KV write method:** Never use `wrangler kv key put "key" $value` from PowerShell — it corrupts JSON. Always write to a UTF-8 JSON file first, then:
```
npx wrangler kv key put "client:{uuid}" --path client.json --binding=RAFTER_CLIENTS --remote
```
Run from `workers/materials-sync/`.

### Field reference

Build the JSON record with these fields. Populate what you can before OAuth; token fields are filled in by the OAuth flow (Section 4).

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| `uuid` | string | SM8 / Prerequisites | The SM8 company UUID |
| `company_name` | string | Client | Display name, e.g. `"2 Men and a Shovel"` |
| `branding.primary` | string | Client | Dark colour hex, e.g. `"#0D2E1C"` |
| `branding.accent` | string | Client | Accent colour hex, e.g. `"#84B741"` |
| `branding.background` | string | Client | Light bg hex, e.g. `"#ECF1E8"` |
| `branding.heading_font` | string | Client | e.g. `"Playfair Display"` |
| `branding.body_font` | string | Client | e.g. `"Mulish"` |
| `r2_photo_path` | string | Derived | Always `"clients/{uuid}/photos/"` |
| `payment_thresholds` | object | Client | Keys: `under_15k`, `between_15k_50k`, `over_50k`. Values: e.g. `"50/50"`, `"20/60/20"`, `"5/progress/final"` |
| `proposal_types` | array | Client | e.g. `["LC", "GM"]` — abbreviations used in PDF cover title |
| `job_categories` | array | SM8 | Copy from SM8 → Settings → Job Categories |
| `job_queues` | array | SM8 | Copy from SM8 → Settings → Job Queues |
| `templates` | array | SM8 | Array of `{"name": "TEMPLATE NAME"}` — sync via materials refresh after OAuth (Section 7) |
| `phone` | string | Client | e.g. `"(03) 9013 6588"` |
| `business_address` | string | Client | Full address, newline between street and suburb/state/postcode |
| `business_email` | string | Client | Public contact email |
| `operator_email` | string | Client | Email for quote-submitted notifications. Goes to Make Gmail module To field. |
| `abn` | string | Client | e.g. `"18 652 417 171"` |
| `bank_details` | object | Client | Keys: `name`, `bsb`, `account` |
| `credentials` | array | Client | Array of `{"name": "...", "detail": "..."}` — printed on PDF |
| `terms_and_conditions` | array | Client | Array of strings — printed on PDF |
| `staff_uuid` | string | SM8 (post-OAuth) | Account owner UUID — populated in Section 6 |
| `email_template` | string | Client | HTML email body. Merge fields: `{client_name}`, `{job_address}`, `{quote_ref}`, `{total}`. Make substitutes before sending. |
| `access_token` | string | OAuth flow | Populated automatically by Section 4 |
| `refresh_token` | string | OAuth flow | Populated automatically by Section 4 |
| `expires_at` | string | OAuth flow | ISO 8601 — populated automatically by Section 4 |
| `token_updated_at` | string | OAuth flow | ISO 8601 — populated automatically by Section 4 |

### Minimal pre-OAuth record

Create this before the OAuth flow. Token fields can be left as empty strings — they will be overwritten:

```json
{
  "uuid": "{uuid}",
  "company_name": "{Company Name}",
  "branding": {
    "primary": "#000000",
    "accent": "#000000",
    "background": "#FFFFFF",
    "heading_font": "Playfair Display",
    "body_font": "Mulish"
  },
  "r2_photo_path": "clients/{uuid}/photos/",
  "payment_thresholds": {
    "under_15k": "50/50",
    "between_15k_50k": "20/60/20",
    "over_50k": "5/progress/final"
  },
  "proposal_types": ["LC", "GM"],
  "job_categories": [],
  "job_queues": [],
  "templates": [],
  "phone": "",
  "business_address": "",
  "business_email": "",
  "operator_email": "",
  "abn": "",
  "bank_details": { "name": "", "bsb": "", "account": "" },
  "credentials": [],
  "terms_and_conditions": [],
  "staff_uuid": "",
  "email_template": "<p>Hi {client_name},</p>\n\n<p>Please find attached your quote from [COMPANY NAME] for the work at {job_address}.</p>\n\n<p><strong>Quote reference:</strong> {quote_ref}<br>\n<strong>Total (inc. GST):</strong> ${total}</p>\n\n<p>To accept this quote, simply reply to this email or call us on [PHONE] and we'll confirm the schedule and get started.</p>\n\n<p>If you have any questions about the quote, we're happy to talk it through.</p>\n\n<p>Thanks,<br>\n[SIGNATORY NAME]<br>\n[COMPANY NAME]<br>\n[PHONE]<br>\n[EMAIL]</p>",
  "access_token": "",
  "refresh_token": "",
  "expires_at": "",
  "token_updated_at": ""
}
```

- [ ] KV record written and verified — check via Cloudflare dashboard → KV → RAFTER_CLIENTS → key `client:{uuid}`

---

## Section 3 — Slug Setup

The quoting form at `rafter.deepgreensea.au/{slug}` reads the first URL path segment and calls `/resolve-slug/{slug}` on the rafter-materials-sync Worker. That endpoint looks up `slug:{slug}` in KV and returns the UUID.

Write the slug mapping to KV:

```
cd workers/materials-sync
npx wrangler kv key put "slug:{slug}" "{uuid}" --binding=RAFTER_CLIENTS --remote
```

Example:
```
npx wrangler kv key put "slug:andy" "448e12a8-f7d9-4ace-b8c6-242bf678db3b" --binding=RAFTER_CLIENTS --remote
```

No code changes needed — slug routing is fully data-driven.

- [ ] Slug KV record written: `slug:{slug}` → `{uuid}`
- [ ] Verify: `curl https://rafter-materials-sync.will-8e8.workers.dev/resolve-slug/{slug}` returns `{"ok":true,"slug":"{slug}","uuid":"{uuid}"}`

---

## Section 4 — SM8 OAuth

The client must complete this step themselves, or you must do it on their behalf while logged into their SM8 account.

1. Navigate to `rafter.deepgreensea.au/setup`
2. Click **Connect ServiceM8**
3. Log in to the client's SM8 account if not already logged in
4. Review the permissions screen — all listed scopes should appear
5. Click **Allow**
6. The callback page shows a spinner then "Setup complete"

Behind the scenes:
- `callback.html` sends the auth code to the Make Account Discovery webhook
- Make calls SM8's token endpoint to exchange the code
- Make calls `/store-token` on rafter-materials-sync, which writes `access_token`, `refresh_token`, `expires_at`, `token_updated_at` to the KV record

- [ ] OAuth completed without error on the callback page
- [ ] Verify KV record: `access_token` and `expires_at` are populated
  ```
  cd workers/materials-sync
  npx wrangler kv key get "client:{uuid}" --binding=RAFTER_CLIENTS --remote | python -c "import json,sys; d=json.load(sys.stdin); print('token:', d.get('access_token','')[:20], '...', '| expires:', d.get('expires_at',''))"
  ```

**If OAuth fails:** check Make Account Discovery scenario logs. The most common failure is the Webhook Response module returning plain text instead of JSON — the response must include `access_token`.

---

## Section 5 — Make Data Store Record

> **Note:** This step is a temporary workaround per DEBT-01. Once Make reads the token directly from `/client-config`, this step is eliminated. Until then, it is required for the Rafter Form scenario to have a valid token.

1. Open Make → Data Stores → Rafter Tokens
2. Add a new record with:
   - `uuid`: `{uuid}`
   - `access_token`: copy from KV record
   - `refresh_token`: copy from KV record
   - `expires_at`: copy from KV record

- [ ] Data Store record created with correct UUID and token values

---

## Section 6 — Staff UUID

The `staff_uuid` field identifies the SM8 account owner. It is sent as `x-impersonate-uuid` in email API calls.

1. Get the access token from KV (from Section 4)
2. Call the SM8 staff endpoint:
   ```
   curl -H "Authorization: Bearer {access_token}" \
     https://api.servicem8.com/api_1.0/staff.json
   ```
   Or via the Worker:
   ```
   curl "https://rafter-materials-sync.will-8e8.workers.dev/sm8-staff?uuid={uuid}"
   ```
3. Find the record where `type` is `"business_owner"` or the account owner's name
4. Copy the `uuid` field from that staff record
5. Update the KV record with `staff_uuid`:
   - Read the full KV record to a file
   - Edit the `staff_uuid` field
   - Write back with `--path`

- [ ] `staff_uuid` populated in KV record
- [ ] Verified by reading back: `staff_uuid` is a non-empty UUID string

---

## Section 6b — Email Template

Write the client's email template to the `email_template` field in their KV record. This is the HTML body sent to customers when a quote is emailed. It must contain all four merge fields — `/render-email` substitutes them server-side before the email is sent.

**Required merge fields:** `{client_name}`, `{job_address}`, `{quote_ref}`, `{total}`

Read the current KV record, update `email_template`, and write back using `--path`:

```
cd workers/materials-sync
npx wrangler kv key get "client:{uuid}" --binding=RAFTER_CLIENTS --remote > client.json
# edit email_template in client.json
npx wrangler kv key put "client:{uuid}" --path client.json --binding=RAFTER_CLIENTS --remote
rm client.json
```

**Verify with `/render-email`:**
```
curl -X POST https://rafter-materials-sync.will-8e8.workers.dev/render-email \
  -H "x-rafter-secret: [RAFTER_INTERNAL_SECRET]" \
  -H "Content-Type: application/json" \
  -d '{"uuid":"{uuid}","client_name":"Test Client","job_address":"1 Test St","quote_ref":"Q-TEST","total":"1234.56"}'
```
Expected: `{"html":"..."}` with all four merge fields replaced. No literal `{...}` placeholders in the output.

**Reference template (2 Men and a Shovel — confirmed working):**
```html
<img src="https://rafter-materials-sync.will-8e8.workers.dev/logo/{uuid}" alt="" style="height:60px;width:auto;display:block;margin-bottom:20px;">
<p>Hi {client_name},</p>

<p>Please find attached your quote from [COMPANY NAME] for the work at {job_address}.</p>

<p><strong>Quote reference:</strong> {quote_ref}<br>
<strong>Total (inc. GST):</strong> ${total}</p>

<p>To accept this quote, simply reply to this email or call us on [PHONE] and we'll confirm the schedule and get started.</p>

<p>If you have any questions about the quote, we're happy to talk it through.</p>

<p>Thanks,<br>
[SIGNATORY NAME]<br>
[COMPANY NAME]<br>
[PHONE]<br>
[EMAIL]</p>
```

- [ ] `email_template` written to KV record — **Code**
- [ ] `/render-email` verified — all merge fields substituted, no placeholders remaining — **Code**

---

## Section 6c — Credentials and T&Cs

Copy `credentials` and `terms_and_conditions` into the client's KV record. Without these the PDF appendix page ("You Can Rely On..." + T&Cs) is silently absent from every quote.

Use the `--path` method as usual. Also populate `job_categories` and `job_queues` at this step — fetch these directly from the client's SM8 account rather than copying from another instance.

```
# Fetch real job categories and queues from SM8
curl -H "Authorization: Bearer {access_token}" \
  https://api.servicem8.com/api_1.0/category.json
curl -H "Authorization: Bearer {access_token}" \
  https://api.servicem8.com/api_1.0/queue.json
```

Then read the KV record, populate all four fields, and write back with `--path`.

**Verify:** Generate a PDF preview from the form and confirm:
- Appendix page is present
- Credentials block ("You Can Rely On...") lists all entries
- T&Cs text appears below

- [ ] `credentials` written to KV — **Code**
- [ ] `terms_and_conditions` written to KV — **Code**
- [ ] `job_categories` written from live SM8 (not copied from trial) — **Code**
- [ ] `job_queues` written from live SM8 (not copied from trial) — **Code**
- [ ] PDF appendix page verified in preview — **Will**

---

## Section 6d — Slug

Confirm `slug:{slug}` in KV points to the client's live UUID. This should have been written in Section 3, but verify it is still pointing to the correct live UUID (not trial) after OAuth completes.

```
curl https://rafter-materials-sync.will-8e8.workers.dev/resolve-slug/{slug}
```

Expected: `{"ok":true,"slug":"{slug}","uuid":"{live-uuid}"}`

- [ ] Slug verified pointing to live UUID — **Code**

---

## Section 7 — Materials Sync

This populates `materials:{uuid}` in KV (used by the form line-item search) and also validates that the token is working.

```
curl "https://rafter-materials-sync.will-8e8.workers.dev/refresh-materials?uuid={uuid}"
```

Expected response:
```json
{ "ok": true, "uuid": "...", "shape": "array", "count": 100, "ttl_seconds": 86400 }
```

- [ ] Materials sync returns `ok: true` with `count > 0`
- [ ] Templates array in KV updated if templates were blank — if SM8 templates exist, sync the `templates` array manually from SM8 → Documents → Templates

---

## Section 8 — Verification Checklist

Work through each item in order. Do not mark as passed until you have personally confirmed the behaviour.

**Setup & auth**
- [ ] Setup page loads at `rafter.deepgreensea.au/setup` without errors
- [ ] OAuth completes without error (Section 4)
- [ ] KV record has valid `access_token` and `expires_at` (within ~1 hour of completion)

**Form load**
- [ ] Quoting form loads at `rafter.deepgreensea.au/{slug}` — no JS errors in console
- [ ] Client name and section chips load from KV correctly
- [ ] SM8 client search returns results when typing 3+ characters
- [ ] Google Maps autocomplete works in the site address field

**Line items & materials**
- [ ] Materials load in line item search (type to search, results appear)
- [ ] Prices populate from SM8 materials data

**Submit Job Only** (no email, no customer)
- [ ] Submit a test quote with `send_email = false`
- [ ] Job created in SM8 with correct client, address, and job description
- [ ] PDF arrives in SM8 job diary as an attachment
- [ ] Quote reference (Q-YYYYMMDD-HHMM) appears in the job

**Submit & Send Quote** (email enabled)
- [ ] Submit a test quote with a real customer email address
- [ ] Job created in SM8 (same as above)
- [ ] PDF arrives in SM8 job diary
- [ ] Customer receives email with PDF attached, correct merge fields resolved
- [ ] Operator receives notification email at `operator_email`

**Two-way email** *(pending VER-01 verification)*
- [ ] Reply to the customer quote email appears in the SM8 job diary

---

## Section 9 — Post-Go-Live

- [ ] Delete all test jobs created in SM8 during verification
- [ ] Delete any test clients/companies created in SM8 during verification
- [ ] Confirm client is using their live SM8 instance UUID (not trial `448e12a8...`)
- [ ] Update `rafter-continuation-prompt.md` with the new client's UUID, slug, and KV field values
- [ ] Update the issue tracker with T1-F1 and T1-F2 status if this was Andy's go-live
