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

**Clerk instance (test) — DECOMMISSIONED 2026-06-29.** The dev Clerk instance (`first-kiwi-3.clerk.accounts.dev`, `pk_test_Zmly…`) was decommissioned when the dev Rafter tenant was rebound to a prod-Clerk org ("Rafter Dev", `org_3Fo4VG9mt320TAO9Tbi4L1ixjAp`). The original dev-Clerk org `org_3ER2eDTmyc31XYw6QiJkbT3gDmx` "DeepGreenSea" was deleted in the same session. Final dashboard-side instance delete done by Will after this commit.

For the live prod Clerk configuration — publishable key, JWKS, secrets, custom domains, webhook subscription, helper functions for v2 token claims — see the **Prod auth state — cutover 2026-06-11** section in CLAUDE.md (single source of truth).

**Clerk JS CDN — general guidance:** Always load from the Clerk-hosted CDN, never jsDelivr (jsDelivr is blocked by Brave and other ad blockers). Use `window.Clerk` directly as the instance (NOT `new window.Clerk(KEY)`). Add `[hidden]{display:none!important}` to CSS — `display:flex` on loading states overrides the `hidden` attribute otherwise.

**sign-up.html flow:** Uses `clerk.redirectToSignUp()` and `clerk.redirectToCreateOrganization()` (hosted redirects, no embedded components). After org creation Clerk redirects to `/onboarding.html`. The `organization.created` webhook fires → admin-api creates stub KV record. onboarding.html completes the record via `/onboarding/provision`.
