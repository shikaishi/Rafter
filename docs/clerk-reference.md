# Clerk reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.
For the onboarding flow that uses Clerk org events, see [onboarding-reference.md](onboarding-reference.md).

## Inject

Prod emits v2 session tokens (`v: 2`, claims nested under `o: { id, rol, slg }`). There is
NO top-level `org_id` / `org_role` / `org_slug` claim on prod. The role value is the SHORT
form (`"admin"`, `"member"`) without the `org:` prefix v1 used. `@clerk/backend@1.34.0`
returns raw decoded claims — no normalisation — so a bare `jwtPayload.org_id` read returns
`undefined` and silently 401s every request (RFT-107 root cause).

Every org-scoped endpoint MUST use the helpers in `workers/admin-api/index.js`:
`extractOrgId(jwtPayload)` and `extractOrgRole(jwtPayload)`. The role helper re-applies the
`org:` prefix so every `=== 'org:admin'` comparison site continues to work unchanged.
Bare `jwtPayload.org_id` / `jwtPayload.org_role` reads are forbidden outside the helper
bodies themselves.

JWT verification is networkless via `verifyToken` from `@clerk/backend` with `jwtKey:
env.CLERK_JWT_KEY` (PEM). Never fetch JWKS at request time.

`CLERK_AUTHORIZED_PARTY` is comma-separated (RFT-122) so both `rafter.deepgreensea.au` and
`ops.deepgreensea.au` can present valid JWTs from the same Clerk instance. Pass it via
`authorizedParties: parties.length ? parties : undefined` to `verifyToken`. Skipping the
authorizedParties check leaves sibling-subdomain session cookies usable cross-surface.

Browser-side Clerk loads from `clerk.deepgreensea.au/npm/@clerk/clerk-js@6.14.0/dist/clerk.browser.js`
(pinned across all six `workers/rafter/*.html` pages). Brave + ad-blockers block jsDelivr —
never substitute a jsDelivr URL. Use `window.Clerk` directly; the data-attribute on the
script tag instantiates it (not `new window.Clerk(KEY)`).

CSS gotcha: include `[hidden]{display:none!important}` in any HTML using Clerk-mounted
elements — Clerk's stylesheet sets `display:flex` which overrides the bare `hidden` attribute.

The `org` is the security boundary. One Clerk org per Rafter client. `clerk_org:{orgId}`
reverse-index in KV maps the org to its tenant UUID — every JWT-gated endpoint resolves
the tenant via this lookup, never via the request body.

Webhooks: `organization.created` only. `verifyWebhook(request, { signingSecret:
env.CLERK_WEBHOOK_SECRET })` is the signature check. Svix retry storms — guard with
`svix:{svix-id}` dedup key plus `clerk_org:` existence check.

## Clerk (NEW v2.0)

**Purpose:** Identity, onboarding gate, billing. Replaces URL-as-password security model.
**Integration:** Cloudflare Workers validate Clerk JWTs at edge before serving any protected page.

### Org model
- One Clerk Organisation per Rafter client
- Clerk org ID stored in KV record: `clerk_org_id` field
- Roles: `admin` (client owner) + `member` (staff) — embedded in JWT, no extra network call
- Subscription state embedded in JWT — Worker checks on every request

### Billing
- Clerk Billing + Stripe. Plans defined in Clerk dashboard.
- `<PricingTable />` component for plan selection
- 0.7% per transaction + Stripe fees. Australia fully supported.
- GST/tax: not yet supported in Clerk. Manual invoice short-term.
- Subscription lapse → Worker gates access, redirects to billing page

**Clerk instance (test):**
- Publishable key: `pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ`
- Clerk domain: `first-kiwi-3.clerk.accounts.dev`
- JWKS: `https://first-kiwi-3.clerk.accounts.dev/.well-known/jwks.json`
- **CLERK_JWT_KEY (PEM public key):** `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuQIvdh+gKaqIqbz/sqKA\nyQnpYtMQ1kf1PM06Ujy82763e2uKi6oJVh2TGqj3gf5FMMVI387U3AMJ+6Ada4Zi\nJmPPQJ8PzXb+rz9Oe4R4feOu7B7wx9bGBndO66KQJc4FCP1/PiB5qkmkRTjAzjPx\nV8tQXG2/dz+U8egyfZbVGkp2HKlWOobOhs1sxT4EXk89JVE5DeY/Yibj5KHvdl2Y\n6EWWkSJWeDn66CQCQ0eMtvYTRHbfM6tFp9YxlStVu3ggb+5iX1s6ceyYrxJDGHM0\nQMWwXZsC0lb+VUgUEzD/5ppNHnNBsg9ArEsANBz6keChFYkI3WecoTm6RwWJ3fcj\n2wIDAQAB\n-----END PUBLIC KEY-----`

**Clerk JS CDN (use this, not jsDelivr):** jsDelivr is blocked by Brave and other ad blockers. Always load from the Clerk-hosted CDN with `data-clerk-publishable-key` attribute:
```html
<script
  data-clerk-publishable-key="pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ"
  src="https://first-kiwi-3.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
  crossorigin="anonymous"
></script>
```
Use `window.Clerk` directly as the instance (NOT `new window.Clerk(KEY)`). Add `[hidden]{display:none!important}` to CSS — `display:flex` on loading states overrides the `hidden` attribute otherwise.

**sign-up.html flow:** Uses `clerk.redirectToSignUp()` and `clerk.redirectToCreateOrganization()` (hosted redirects, no embedded components). After org creation Clerk redirects to `/onboarding.html`. The `organization.created` webhook fires → admin-api creates stub KV record. onboarding.html completes the record via `/onboarding/provision`.

**Clerk Dashboard to-do:** Set Application name to "Rafter" (Configure → Settings) — currently shows "Index of /" as default org name suggestion.

**Clerk environment variables (to be added to all Workers):**
```
CLERK_PUBLISHABLE_KEY=pk_test_Zmlyc3Qta2l3aS0zLmNsZXJrLmFjY291bnRzLmRldiQ
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...
```
