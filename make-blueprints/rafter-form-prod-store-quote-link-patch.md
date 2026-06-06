# Make patch: add /store-quote-link callback to Rafter Form scenarios

> **VERIFIED 2026-06-06** — recipe below is the one proven against trial dev
> scenario via full end-to-end (Phase A submit → Phase B amend → SM8 verify).
> Two earlier drafts of this doc had incorrect Make-template syntax and an
> unworkable `{{34}}` payload pattern; both corrected here.

Scenarios: **`5537814` Rafter Form prod** (module id `M110`) and
**`5962197` Rafter Form dev** (module id `M112`). Same patch, different
module ids — dev got a higher id because the patch was applied after a
later `idSequence` bump.

Goal: insert one new HTTP module that POSTs to `/store-quote-link` after
M3 (Create Job) completes — propagates the SM8 job UUID + payload to the
rafter-quotes D1 store so the finder + amend op work.

**Apply via API-PATCH, not Make UI** (BUG-25: M3 `company_uuid` expression
reverts when the scenario is opened in UI).

## Procedure (prod example — swap `5537814` for `5962197` for dev)

1. **GET** current blueprint:
   ```
   curl -sH "Authorization: Token <YOUR_MAKE_API_TOKEN>" \
     "https://eu1.make.com/api/v2/scenarios/5537814/blueprint" \
     > rafter-form-prod-pre-store-quote-link.json
   ```

2. **Edit** the downloaded JSON in-place. Two changes:

   **a.** Insert the new module object (see below) into `response.blueprint.flow`
   at array index `6` (immediately after M3 Create Job at index 5, immediately
   before M13 Job Note which becomes index 7).

   **b.** Bump `response.idSequence` to reserve the new id. Use the value the
   blueprint currently shows as `idSequence` for the new module's `"id"` field,
   then increment `idSequence` by one in the same edit.

3. **PATCH** the modified blueprint back:
   ```
   curl -sX PATCH -H "Authorization: Token <YOUR_MAKE_API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data @rafter-form-prod-post-store-quote-link.json \
     "https://eu1.make.com/api/v2/scenarios/5537814"
   ```

4. **Verify** M3's `company_uuid` ifempty expression did NOT revert: re-export
   the blueprint and diff against the pre-patch file. Only differences expected:
   the new module, and `idSequence` bumped by one.

## The new module — paste verbatim, replace the placeholder

> Module `id` in the JSON below is `110` (prod's actual id). For dev, set
> `"id": 112` (dev's actual id). For any other scenario, set it to whatever
> `idSequence` currently shows and bump idSequence accordingly.

```json
{
  "id": 110,
  "module": "http:MakeRequest",
  "version": 4,
  "parameters": {
    "tlsType": "",
    "authenticationType": "noAuth"
  },
  "filter": null,
  "mapper": {
    "url": "https://rafter-materials-sync.will-8e8.workers.dev/store-quote-link",
    "method": "post",
    "headers": [
      {
        "name": "Authorization",
        "value": "Bearer <<PASTE-MAKE_STORE_TOKEN_SECRET-VALUE-HERE>>"
      },
      {
        "name": "Content-Type",
        "value": "application/json"
      }
    ],
    "contentType": "json",
    "inputMethod": "jsonString",
    "shareCookies": false,
    "parseResponse": true,
    "allowRedirects": true,
    "stopOnHttpError": true,
    "jsonStringBodyContent": "{\n  \"quote_ref\": \"{{1.quote_ref}}\",\n  \"client_uuid\": \"{{34.client_uuid}}\",\n  \"sm8_job_uuid\": \"{{3.headers.`x-record-uuid`}}\",\n  \"payload\": {{1.payload}}\n}",
    "requestCompressedContent": true
  },
  "metadata": {
    "designer": {
      "x": 1590,
      "y": -118,
      "name": "Store quote link (rafter-quotes)"
    },
    "restore": {
      "expect": {
        "method": { "mode": "chose", "label": "POST" },
        "headers": { "mode": "chose", "items": [null, null] },
        "contentType": { "label": "application/jsonEnter data in the JSON format, as a string or using a data structure." },
        "inputMethod": { "label": "JSON stringEnter the JSON body as a raw text string. If values contain JSON reserved characters, you must escape them manually." },
        "shareCookies": { "mode": "chose" },
        "parseResponse": { "mode": "chose" },
        "allowRedirects": { "mode": "chose" },
        "paginationType": { "label": "Empty" },
        "queryParameters": { "mode": "chose" },
        "stopOnHttpError": { "mode": "chose" },
        "requestCompressedContent": { "mode": "chose" }
      },
      "parameters": {
        "tlsType": { "label": "Empty" },
        "authenticationType": { "label": "No authenticationUse when no credentials are required for the request." }
      }
    },
    "parameters": [
      { "name": "authenticationType", "type": "select", "label": "Authentication type", "required": true, "validate": { "enum": ["noAuth", "apiKey", "basicAuth", "oAuth"] } },
      { "name": "tlsType", "type": "select", "label": "Transport layer security (TLS)", "validate": { "enum": ["mTls", "tls"] } },
      { "name": "proxyKeychain", "type": "keychain:proxy", "label": "Proxy" }
    ],
    "expect": [
      { "name": "url", "type": "url", "label": "URL", "required": true },
      { "name": "method", "type": "select", "label": "Method", "required": true, "validate": { "enum": ["get", "head", "post", "put", "patch", "delete", "options"] } },
      { "name": "headers", "spec": { "name": "value", "spec": [ { "name": "name", "type": "text", "label": "Name", "required": true, "validate": { "pattern": "^[-!#$%&'*+.^_`|~0-9A-Za-z]+$" } }, { "name": "value", "type": "text", "label": "Value" } ], "type": "collection", "label": "Header" }, "type": "array", "label": "Headers" },
      { "name": "queryParameters", "spec": { "name": "value", "spec": [ { "name": "name", "type": "text", "label": "Name", "required": true }, { "name": "value", "type": "text", "label": "Value" } ], "type": "collection", "label": "Parameter" }, "type": "array", "label": "Query parameters" },
      { "name": "contentType", "type": "select", "label": "Body content type", "validate": { "enum": ["json", "multipart", "urlEncoded", "custom"] } },
      { "name": "parseResponse", "type": "boolean", "label": "Parse response", "required": true },
      { "name": "stopOnHttpError", "type": "boolean", "label": "Return error if HTTP request fails", "required": true },
      { "name": "timeout", "type": "uinteger", "label": "Timeout", "validate": { "max": 300, "min": 1 } },
      { "name": "allowRedirects", "type": "boolean", "label": "Allow redirects", "required": true },
      { "name": "shareCookies", "type": "boolean", "label": "Share cookies with other HTTP modules", "required": true },
      { "name": "requestCompressedContent", "type": "boolean", "label": "Request compressed content", "required": true },
      { "name": "inputMethod", "type": "select", "label": "Body input method", "required": true, "validate": { "enum": ["dataStructure", "jsonString"] } },
      { "name": "jsonStringBodyContent", "type": "text", "label": "Body content", "required": true },
      { "name": "paginationType", "type": "select", "label": "Pagination type", "validate": { "enum": ["offsetBased", "pageBased", "urlBased", "tokenBased"] } }
    ],
    "interface": [
      { "name": "data", "type": "any", "label": "Data" },
      { "name": "statusCode", "type": "number", "label": "Status Code" },
      { "name": "headers", "spec": [ { "name": "content-length", "type": "text", "label": "Content-Length" }, { "name": "content-encoding", "type": "text", "label": "Content-Encoding" }, { "name": "content-type", "type": "text", "label": "Content-Type" }, { "name": "server", "type": "text", "label": "Server" }, { "name": "cache-control", "type": "text", "label": "Cache-Control" }, { "name": "set-cookie", "spec": { "type": "text" }, "type": "array", "label": "Set-Cookie" } ], "type": "collection", "label": "Headers" }
    ]
  }
}
```

## Variable references — what each maps to

| JSON field | Make ref | Source |
|------------|----------|--------|
| `quote_ref` | `{{1.quote_ref}}` | M1 webhook flat field — set by PDF worker as a form field directly. (M34 also exposes it; either works, M1 is the simpler upstream.) |
| `client_uuid` | `{{34.client_uuid}}` | **M34 parsed payload — NOT a flat M1 field.** The form's slug-resolved operator UUID (e.g., `010895db-…` for trial). DO NOT map this from `{{1.client_sm8_uuid}}` — that's the *SM8 customer company* UUID (a different identifier with the same format), which would silently break multi-tenant scoping. |
| `sm8_job_uuid` | `` {{3.headers.`x-record-uuid`}} `` | M3 (Create Job) response header. Use Make's **picker** in the UI (dot + backtick form) — the bracket-quote variant `{{3.headers["x-record-uuid"]}}` works in M14's body but Make's `text:notequal` filter evaluator treats it as a literal string, not a variable. Stick with the picker output. |
| `payload` | `{{1.payload}}` | **Raw M1 webhook field, unquoted (no surrounding `"…"`).** The form sends `payload` as a stringified JSON form-field; Make substitutes it inline. Worker accepts this as a string and JSON.parses it. |

### Three patterns that DON'T work (learned the hard way 2026-06-06)

| Tried | Result |
|-------|--------|
| `"payload": {{34}}` | Make substitutes to the literal number `34`, not M34's bundle. Worker rejects: payload type number. |
| `"payload": "{{1.payload}}"` (quoted) | Make doesn't escape inner `"` characters of the substituted JSON string. Body becomes invalid JSON, Make errors before sending. |
| `"payload": {"some": "static"}` | Inner `{` may be interpreted as a variable delimiter. Scenario stalls without sending. |

The verified-working `"payload": {{1.payload}}` (unquoted, raw M1 field) is the
only shape proven against trial. The worker also has tolerance for `payload`
sent as an object or for a `payload_b64` alternative, but those code paths are
unexercised so far.

## The Authorization header

Replace `<<PASTE-MAKE_STORE_TOKEN_SECRET-VALUE-HERE>>` with the same secret
value already used in the Account Discovery scenario's M5 (/store-token call).
Both endpoints share `MAKE_STORE_TOKEN_SECRET` — same trust boundary, same
value. If you need to look it up, the easiest path is to GET the Account
Discovery blueprint and copy M5's `Authorization` header value verbatim.

(Cloudflare Worker secrets are write-only via wrangler/dashboard, so the
"canonical" value lives in Make's existing M5 module config + the worker's
secret store. Make's blueprint export REDACTS the value as
`<<REDACTED: MAKE_STORE_TOKEN_SECRET>>` — but in the live Make scenario M5
holds the real value.)

## Why the new module slots between M3 and M13

- **After M3 (Create Job)**: M3 is where SM8 returns the `x-record-uuid`
  header. Anything earlier doesn't have the value.
- **Before M13 (Job Note), M14 (Attachment), M15 (Upload PDF), etc.**:
  placing it first in the post-create chain means a failure downstream
  (M13 / M14 / M15) still leaves a finder-visible rafter-quotes row that the
  operator can recover via the finder. Also keeps the new module a single,
  independent line that's safe to disable for debugging.

## Filter (optional but recommended)

The current scenario fires M3 for every submit. For the very first deploy you
may want a filter on the new module so it only fires for non-zero `x-record-uuid`
responses (defensive — if M3 fails, x-record-uuid is absent and the worker
returns 400 with `missing_or_invalid_sm8_job_uuid`, which is the correct
behaviour but produces an alert-worthy error). To filter:

```json
"filter": {
  "name": "x-record-uuid present",
  "conditions": [
    [
      {
        "a": "{{3.headers.`x-record-uuid`}}",
        "o": "text:notequal",
        "b": ""
      }
    ]
  ]
}
```

**Header reference syntax — picker form (dot + backticks), not bracket form.**
Make's filter expression evaluator treats `{{3.headers["x-record-uuid"]}}`
(bracket form) as a literal string, never matching the real header value, so
the filter always evaluates "literal != """ → true and the filter passes
trivially (effectively a no-op) — OR, more confusingly, the filter never
matches when you want it to. The picker output (` `…` ` with dot) is the
form that actually resolves.

Replace the `"filter": null` field in the module above with this. Without
the filter, missing-UUID submits still produce a 400 from the worker but
also surface as a Make scenario error.

## Verification — what to look for after the PATCH

1. **Re-export blueprint**, diff against the pre-patch file:
   - Only differences: the new module added at flow index 6, and `idSequence`
     bumped by one.
   - M3 `company_uuid` ifempty expression **must be unchanged**. If reverted,
     re-PATCH from `make-blueprints/rafter-form-prod-2026-05-21-final.json`
     first, then re-apply this patch.

2. **Run one trial submission** (slug `dev`). Expected:
   - PDF worker `/generate?mode=submit` → 200 (Make accepted).
   - Make M3 creates SM8 job (visible in trial SM8).
   - **The new module** POSTs to `/store-quote-link` → 200.
   - Make continues M13 → M14 → M15 → router.
   - Fetch from materials-sync confirms the row exists:
     ```
     curl -H "x-rafter-secret: $RAFTER_INTERNAL_SECRET" \
       "https://rafter-materials-sync.will-8e8.workers.dev/draft/<quote_ref>"
     ```
   - The row's `client_uuid` MUST be the operator's KV record key
     (e.g., `010895db-…` for trial). If it shows the SM8 customer's UUID
     instead, `client_uuid` was mapped from `{{1.client_sm8_uuid}}` —
     re-map to `{{34.client_uuid}}` (see the variable table above).
   - Finder at `https://rafter.deepgreensea.au/dev?find=1` shows the row.

3. **If returns 400 `invalid_client_uuid`**: `{{34.client_uuid}}` resolved
   empty (M1's payload field is missing client_uuid, OR M34 ParseJSON didn't
   parse the payload, OR client_uuid was mapped from the wrong source). Check
   the variable picker output in the Make UI — it should resolve to a UUID
   shape `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

4. **If returns 400 `missing_or_invalid_sm8_job_uuid`**: M3 did not return
   `x-record-uuid`. Most likely SM8 returned an error. Inspect M3's response
   status in Make's execution log. Do not "fix" by sending a placeholder —
   the worker is right to reject; the real problem is upstream.

5. **If the new module silently doesn't fire**: the filter expression uses
   bracket-form `{{3.headers["x-record-uuid"]}}` instead of picker dot-form
   `` {{3.headers.`x-record-uuid`}} ``. The bracket form evaluates as a
   literal string in Make filter contexts, never matching the real header.
   Fix the filter to use the picker form.

## Status as of 2026-06-06

- **Dev `5962197`**: M112 live, full E2E verified (Phase A submit → row stored,
  Phase B amend → v1 superseded / v2 submitted, SM8 job_description appended
  with both `RAFTER:Q-…:START/END` blocks, two SM8 attachments coexist).
- **Prod `5537814`**: M110 present from earlier patch with broken syntax. The
  filter uses bracket-form which never matches, so M110 is dormant. Andy's
  submits unaffected (fail-closed). Re-patch with the corrected recipe above
  to activate.
