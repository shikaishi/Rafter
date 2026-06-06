# Make patch: add /store-quote-link callback to Rafter Form prod (5537814)

Scenario: `5537814` (Rafter Form prod).
Goal: insert one new HTTP module that POSTs to `/store-quote-link` after
M3 (Create Job) completes — propagates the SM8 job UUID + payload to the
rafter-quotes D1 store so the finder + amend op work.

**Apply via API-PATCH, not Make UI** (BUG-25: M3 `company_uuid`, M33 / M37
subject expressions revert when the scenario is opened in UI).

## Procedure

1. **GET** current blueprint:
   ```
   curl -sH "Authorization: Token <YOUR_MAKE_API_TOKEN>" \
     "https://eu1.make.com/api/v2/scenarios/5537814/blueprint" \
     > rafter-form-prod-pre-store-quote-link.json
   ```

2. **Edit** the downloaded JSON in-place. Two changes only:

   **a.** Insert the new module object (see below) into `response.blueprint.flow`
   at array index `6` (i.e., immediately after the M3 Create Job module at
   index 5, immediately before the M13 Job Note module which becomes index 7).

   **b.** Bump `response.idSequence` from `110` to `111` to reserve module id 110
   for the new module.

3. **PATCH** the modified blueprint back:
   ```
   curl -sX PATCH -H "Authorization: Token <YOUR_MAKE_API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data @rafter-form-prod-post-store-quote-link.json \
     "https://eu1.make.com/api/v2/scenarios/5537814"
   ```

4. **Verify** M3 / M33 / M37 expressions did NOT revert: re-export the
   blueprint and diff against the pre-patch file. Only differences expected:
   the new M110 module, and `idSequence: 111`.

## The new module — paste verbatim, replace the placeholder

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
    "jsonStringBodyContent": "{\n  \"quote_ref\": \"{{34.quote_ref}}\",\n  \"client_uuid\": \"{{34.client_uuid}}\",\n  \"sm8_job_uuid\": \"{{3.headers[`x-record-uuid`]}}\",\n  \"payload\": {{34}}\n}",
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
| `quote_ref` | `{{34.quote_ref}}` | M34 (ParseJSON of M1's `payload` form field). Same field name as `payload.quote_ref` from the form. |
| `client_uuid` | `{{34.client_uuid}}` | M34 parsed object's `client_uuid` field. M1's flat form fields do NOT include client_uuid directly — must come from the parsed payload. |
| `sm8_job_uuid` | `` {{3.headers[`x-record-uuid`]}} `` | M3 (Create Job) response header. Exact same syntax M14 (Create Attachment Record) already uses for `related_object_uuid` — verified in production. |
| `payload` | `{{34}}` | M34's full parsed object embedded as inline JSON (no surrounding quotes). The worker re-stores this verbatim into rafter-quotes. |

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
        "a": "{{3.headers[`x-record-uuid`]}}",
        "o": "text:notequal",
        "b": ""
      }
    ]
  ]
}
```

Replace the `"filter": null` field in the module above with this. Without
the filter, missing-UUID submits still produce a 400 from the worker but
also surface as a Make scenario error.

## Verification — what to look for after the PATCH

1. **Re-export blueprint**, diff against `rafter-form-prod-pre-store-quote-link.json`:
   - Only differences: the new M110 module added at flow index 6, and
     `idSequence` 110 → 111.
   - M3 `company_uuid`, M33 subject, M37 subject expressions **must be
     unchanged**. If any reverted, re-PATCH from
     `make-blueprints/rafter-form-prod-2026-05-21-final.json` first, then
     re-apply this patch.

2. **Run one trial submission** (slug `dev`). Expected:
   - PDF worker `/generate?mode=submit` → 200 (Make accepted).
   - Make M3 creates SM8 job (visible in trial SM8).
   - **M110 (new)** POSTs to `/store-quote-link` → 200.
   - Make continues M13 → M14 → M15 → router.
   - Worker log shows `store_quote_link_ok` with the new quote_ref + sm8_job_uuid.
   - Fetch from materials-sync confirms the row exists:
     ```
     curl -H "x-rafter-secret: $RAFTER_INTERNAL_SECRET" \
       "https://rafter-materials-sync.will-8e8.workers.dev/draft/<quote_ref>"
     ```
   - Finder at `https://rafter.deepgreensea.au/dev?find=1` shows the row.

3. **If M110 returns 400** `payload_not_json`: Make didn't serialise `{{34}}`
   as inline JSON; instead it interpolated as a stringified-with-quotes
   string. The worker handles this case (parses the string), so a `400`
   indicates the string was malformed. Fallback: change the body's payload
   line from `"payload": {{34}}` (no quotes) to `"payload": "{{1.payload}}"`
   (quoted, with `{{1.payload}}` being the raw form-field stringified JSON).
   The worker accepts either shape.

4. **If M110 returns 400** `missing_or_invalid_sm8_job_uuid`: M3 did not
   return `x-record-uuid`. Most likely SM8 returned an error. Inspect M3's
   response status. Do not "fix" by sending a placeholder — the worker is
   right to reject. Real problem upstream.
