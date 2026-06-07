# ServiceM8 API reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

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

### OAuth scopes (current — updated 2026-06-05)
```
vendor, vendor_logo, read_staff, read_inventory, read_job_categories, read_job_queues,
manage_templates, manage_badges, read_tax_rates, read_forms, read_customers, read_jobs,
publish_email, create_jobs, manage_customers, manage_schedule, publish_job_attachments,
manage_job_materials, manage_jobs, manage_attachments
```

**`create_jobs`:** present on trial, working (RFT-26). **RFT-32 scopes (`manage_jobs`, `publish_job_attachments`, `manage_attachments`) are already in the scope string in `workers/rafter/setup.html` (added 2026-06-04).** New clients who complete OAuth via setup.html will receive the full scope set automatically. **Andy specifically needs to re-auth** via setup.html to gain these scopes — Flow D (~1 min). Note: the runtime-confirmed scope name is `manage_attachments`, not `read_attachments`.
**Inbox scope:** `publish_inbox` — undocumented on public scopes page, defined in OpenAPI only. Moot until VER-01 resolved.

**Materials filter:** Always use `?$filter=active eq 1` on `/api_1.0/material.json` fetches — without it inactive (archived) materials are returned alongside active ones.

### OData filter constraints

SM8's OData implementation is a limited subset. What works and what doesn't:

| Filter | Result |
|---|---|
| `?$filter=active eq 1` | ✅ supported (materials sync, finder liveness against `/job.json`) |
| `?$filter=uuid eq '<uuid>'` | ✅ single-predicate equality |
| `?$filter=(uuid eq 'a' or uuid eq 'b')` | ❌ HTTP 400 `"Advanced Record Filter Queries Not Supported"` (verified RFT-85 BVT trace, 2026-06-07) |
| `?$filter=uuid in (...)` | ❌ untested; assume unsupported until proven otherwise |

**Implication for batched lookups:** to check N records by UUID, fire N parallel single GETs against `/<object>/{uuid}.json` — never one batched `or`-joined query. Bounded by SM8's 180 req/min throttle; fine for finder-scale (≤50). Canonical implementation: `sm8FetchActiveSet` in `workers/materials-sync/index.js` (RFT-85).

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
