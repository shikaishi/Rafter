# Make UI changeover — /store-quote-link callback (RFT-37)

**Scenario:** Rafter Form prod (`5537814`).
**What to add:** one new HTTP MakeRequest module that POSTs the SM8 job UUID
back to materials-sync after job-create. Without this, the rafter-quotes draft
is never written, the finder shows nothing, and the amend op (RFT-39) has no
SM8 linkage to target — amendment becomes impossible (RFT-35 SOLE-linkage).

⚠️ **BUG-25 reminder:** opening this scenario in the Make UI can silently revert
the M3 `company_uuid` expression and M33/M37 subject expressions. Verify those
three expressions intact via blueprint GET after any UI save.

---

## Placement

Insert immediately **after M3 (Create Job)** and **before M13 (Job Note)**.

Rationale: M3 is where SM8 returns the job UUID in its `x-record-uuid` header.
Anything downstream of M3 has that value available; placing the callback first
means a failure later in the flow (attach, line items, email) still results in
a stored draft that the operator can recover via the finder.

Current flow at the insertion point:

```
M1 (Webhook) → M34 (ParseJSON) → M35 (HTTP) → M21 (IfElse) → M25 (Merge)
→ M3 (Create Job)
→ [NEW: store-quote-link callback]   ← insert here
→ M13 (Job Note) → M14 (Create Attachment) → M28 (Set Variable) → M15 (Upload PDF) → M29 (Router) → …
```

---

## New module spec

| Field | Value |
|-------|-------|
| Module type | HTTP → Make a request |
| URL | `https://rafter-materials-sync.will-8e8.workers.dev/store-quote-link` |
| Method | POST |
| Header | `Authorization: Bearer {{MAKE_STORE_TOKEN_SECRET}}` |
| Header | `Content-Type: application/json` |
| Body type | Raw → JSON (application/json) |
| Parse response | No (worker returns small JSON; not used downstream) |

Reuses `MAKE_STORE_TOKEN_SECRET` (the same connection / variable already used
by /store-token in the Account Discovery scenario — single Make→materials-sync
trust boundary). No new secret needs provisioning.

## Body template

```json
{
  "quote_ref":     "{{1.quote_ref}}",
  "client_uuid":   "{{1.client_uuid}}",
  "sm8_job_uuid":  "{{3.headers.`x-record-uuid`}}",
  "payload":       {{34.value}}
}
```

Field sources:

| JSON field | Make variable | Comes from |
|------------|---------------|-----------|
| `quote_ref` | `{{1.quote_ref}}` | M1 webhook receives this field directly from the PDF worker's form-data POST |
| `client_uuid` | `{{1.client_uuid}}` | Same — original payload's `client_uuid` |
| `sm8_job_uuid` | `` {{3.headers.`x-record-uuid`}} `` | M3 (Create Job) response header — same value used in M3's own `company_uuid` expression for new-client routing |
| `payload` | `{{34.value}}` | M34 (ParseJSON) — the parsed JSON object of the full `payload` form field. Insert as a raw value (no surrounding quotes) so it serialises as an object, not a string |

If field names in M1's bundle don't exactly match (`{{1.quote_ref}}` etc.),
inspect M1's last run output to find the actual key names. The names listed
here match the form-field names the PDF worker writes (see
`workers/pdf/index.js` line ~188+).

## Expected response

`200 OK` with body:

```json
{ "ok": true, "quote_ref": "Q-…", "version": 1, "status": "submitted", "updated_at": "…" }
```

On `400` — likely cause: `sm8_job_uuid` missing or malformed. That means M3
didn't return `x-record-uuid` (upstream SM8 problem) — the rafter-quotes
endpoint is doing the right thing by rejecting. Investigate M3, do not "fix"
the callback by sending a dummy UUID.

On `401` — `MAKE_STORE_TOKEN_SECRET` rotated and the Make connection has a
stale value. Resync.

## How to roll out without UI fragility

**Safest path (recommended):** API PATCH.
1. `GET https://eu1.make.com/api/v2/scenarios/5537814/blueprint` (Token auth).
2. Edit the JSON: insert a new flow entry between M3 and M13 with the shape
   above. Pick a fresh module id (current sequence is in `blueprint.idSequence`).
3. `PATCH https://eu1.make.com/api/v2/scenarios/5537814` with the new
   blueprint. Verify M3 `company_uuid`, M33 subject, M37 subject still match
   `make-blueprints/rafter-form-prod-2026-05-21-final.json`.

**UI path (only if API not viable):**
1. Open scenario 5537814.
2. Drag a new HTTP module onto the canvas after M3, before M13. Wire it.
3. Configure per the spec above.
4. Save once, immediately re-export blueprint, diff against
   `make-blueprints/rafter-form-prod-2026-05-21-final.json` for M3 / M33 / M37
   expressions. Re-PATCH if any reverted.

## Verification

Once deployed, submit a test quote on trial. Expected timeline:
1. PDF worker `/generate?mode=submit` → 200 (Make accepted).
2. Make M3 creates SM8 job, returns x-record-uuid.
3. **New module** POSTs to `/store-quote-link` → 200.
4. Make continues to M13, M14, M15.

Check the draft is stored:

```
curl -H "x-rafter-secret: $RAFTER_INTERNAL_SECRET" \
  "https://rafter-materials-sync.will-8e8.workers.dev/draft/Q-…"
```

Should return the full payload with `sm8_job_uuid` populated and matching the
job UUID visible in the SM8 UI.
