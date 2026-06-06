# Clerk reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.
For the onboarding flow that uses Clerk org events, see [onboarding-reference.md](onboarding-reference.md).

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
