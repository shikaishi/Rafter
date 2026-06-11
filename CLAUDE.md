# CLAUDE.md — Rafter Platform

@docs/claude-code-tuning.md
@docs/code-behaviour.md

> **⚠️ SESSION-START PROTOCOL — do this before reading anything else, every session, every machine.**
>
> This file is canonical **only on `origin/main`**. The copy on your disk is a *reader*, never a master.
> A working tree that is behind origin, or has uncommitted edits to this file, is NOT to be trusted or written from.
>
> **At the start of every Claude Code session, before reading the rest of this file or touching any resource:**
> 1. `git fetch && git status` — confirm you are on `main` and **0 commits behind**. If behind, `git pull --ff-only` to current.
> 2. If the working tree is dirty (`git status` shows modified/deleted files), STOP and resolve before working — do not build on or around uncommitted changes. Report the dirty state to Will.
> 3. Re-read this file *after* syncing. The UUID table below is safety-critical; a stale copy has caused live-data risk before (the 2026-05-28 incident). Confirm the three-UUID table is present before any KV/SM8/Cloudflare operation.
>
> **One writer, many readers.** This file is edited only by commit-and-push to `origin/main`. Never as an uncommitted local-only change, never by hand-editing a Drive/laptop copy. Every machine (desktop, laptop) and both surfaces (Claude Code reads it from the repo; Claude Chat reads it via the GitHub connector or a current paste) read the *same* origin copy. If you find yourself with a second editable copy, that copy is the bug — delete it or make it a read-only mirror.
>
> **Why this protocol exists:** on 2026-05-30 a Code session was found 69 commits behind origin, working from a pre-2026-05-28 CLAUDE.md whose UUID table was stale — it labelled `448e12a8-…` as the dev/trial instance when that UUID is not a Rafter client UUID at all (see safety table below for current understanding). Building from that stale copy would have caused dev writes to land at the wrong KV key. The cause was a working tree allowed to drift and be edited. This protocol removes the ability for that to happen silently.
>
> Read this file at the start of every Claude Code session — it contains everything needed to work on Rafter without a context dump. Do not make assumptions about endpoints, UUIDs, or configuration values — they are all here or flagged as requiring verification.
>
> **Version 2.1 — Updated June 2026.** Added: connect-first onboarding (OAuth-first, SM8 prefill, editable review), staff_uuid SM8 prefill, photo ingest Step 4 (Canvas resize + XHR progress + watchdog), ABN live validation, CORS requirement documented, KV reverse-index requirement documented, chat↔code channel (RFT-53 thread). Multi-tenant standing rule added.
>
> **Version 2.2 — Updated 2026-06-08 (RFT-63 closure).** Settings surface live: per-tenant photo + section management at `/settings` (admin-only, Clerk-org-bound). Section sync rewritten to MIRROR SM8 (D11) — rename + delete now handled, photos migrate on rename, EMPTY_SM8_REFUSE_WIPE safeguard. Section ordering (D12) is admin-set via drag-reorder; `record.templates` array order is THE order across settings list + form photo picker + PDF. Templates rows now carry `sm8_template_uuid` (one-time backfill on first sync). Copy-to-section added alongside Move/Delete. "Quote Builder" Title Cased everywhere as the surface name.
>
> **Version 2.3 — Updated 2026-06-09 (RFT-102 + RFT-105 closure).** Settings surface gained a second zone, "Business Configuration", below the Phase-2 Sections & Photos zone — seven config panes per tenant (business details, bank details, payment thresholds, T&Cs, credentials, email template, branding). 8 endpoints added under `/settings/config/*` + `/settings/branding-presets` on admin-api, all admin-gated, all using the **FORBIDDEN_CONFIG_KEYS → allowlist-pick → slice-only mutator** pattern (D13). `mutateClientRecord(uuid, env, fn)` is the underlying primitive — nested objects deep-merge, partial saves never null adjacent keys. Per-card render isolation in settings.html via `rerenderCard(pane)` + `PANE_RENDERERS`/`PANE_WIRERS` maps — toggling/saving one card never blows away unsaved DOM state in others. Email-template pane uses a contenteditable editor with minimal toolbar (Bold · Italic · Lists · Link · merge-tag pills); zero bundle add; `defaultParagraphSeparator='p'` fixes the Step 1(b) plain-text-collapse bug. Branding palette is now 8 presets (RFT-105) served from `rafter-pdf` `GET /presets` via the `PDF_WORKER` service binding (D14) — single source, never inline-mirrored. Bottom-right Back-to-Quote-Builder button on `/settings`.
>
> **Version 2.4 — Updated 2026-06-11 (RFT-87 scope b + RFT-94 + RFT-107 prod cutover).** Prod Clerk instance live (`pk_live_`, custom Frontend API at `clerk.deepgreensea.au`, Account Portal at `accounts.deepgreensea.au`, Pro plan). Passkey-on-invite enrolment flow deployed end-to-end and validated with first real prod admin. Cold-start path: `/sign-up` → hosted sign-up → create-org → webhook provisions KV stub → `/onboarding.html` (assumes session) → SM8 OAuth → `/callback.html` (first-device passkey enrol on the correct rafter.deepgreensea.au origin). admin-api now uses `extractOrgId` / `extractOrgRole` helpers because prod emits v2 session tokens (`o.id`, `o.rol` nested; role short-form without `org:` prefix) and `@clerk/backend@1.34.0` returns raw claims with no normalisation — bare `jwtPayload.org_id` reads 401 on prod (RFT-107 root cause). RFT-94: pdf worker now tenant-prefix-checks every photo R2 key before reading, rejecting cross-tenant keys with 400 `invalid_photo_keys`. Two known gaps documented (see **Prod auth state** section): `/settings` + `/onboarding.html` no-session fallback still bounces to hosted UI (wrong RP ID for a rafter.deepgreensea.au-scoped passkey); team-pane role badge may mislabel v2 admins as "Member".
>
> **Companion doc: `TRADIE.md` (repo root)** — target-user persona and design/appraisal lens. Consult for any user-facing product decision.
>
> **Chat↔Code channel:** RFT-53 Linear thread is the bidirectional handoff channel between Claude Chat and Claude Code. Read state via `mcp__linear__list_comments` with `issueId: "RFT-53"` (result overflows — extract body via `node -e` from the saved file, NOT python3 which hits the Windows Store alias). Linear docs/documents don't resolve reliably via MCP — use issue comments for state.
>
> **Standing rule — multi-tenant framing:** Rafter is a multi-tenant platform. The production environment serves all clients. The first client is the operator at `slug:andy`. Never frame production artefacts (webhook URLs, Make scenarios, KV records, data) as "Andy's" — that framing caused real errors in prior sessions.

---

## ⚠️ CRITICAL SAFETY RULE

**NEVER use Andy's live ServiceM8 instance UUID during development or testing.**

| Instance | UUID | Role | Use |
|----------|------|------|-----|
| **Trial (DEV/TEST)** | `010895db-e06c-465d-bce9-2424477be15b` | Will's thurlow.net SM8 vendor UUID | All development — `slug:dev` resolves here. **Provisioned 2026-05-30: KV record created, OAuth done, 114 materials synced.** |
| **Andy's KV record** | `0e604a45-84fd-4789-a2cb-662bcba51a8b` | Active KV key — `slug:andy` resolves here. Clerk-org-bound (`org_3EnbpxAJBMUgMQSzhfBn7OIs5j0`) 2026-06-07; OAuth via admin-api Path 2 (RFT-69/70 Option C). | The record the form reads. Production — explicit sign-off required for any write. |
| **Orphaned KV key — seen as `created_by_staff_uuid` on Rafter-OAuth-created records** | `448e12a8-f7d9-4ace-b8c6-242bf678db3b` | Observed 2026-06-07 as the value of `created_by_staff_uuid` on a job cloned via the Rafter OAuth app in BVT (where the tenant's `/vendor.json` identity is `4cf818e5-31e5-40cb-89e7-24480116af2b`). SM8 accepts this UUID as a staff identity in BVT's namespace, but it is not the BVT tenant's per-tenant vendor UUID — so it is not a per-tenant SM8 vendor identity at all. The KV record at `client:448e12a8-…` **was deleted 2026-06-07 (RFT-83)** after the orphan-record clarification confirmed no readers or writers remained. | Never write at this KV key — UUID retains safety meaning even though no record exists. Never use as a client lookup UUID. *(Prior CLAUDE.md label "Andy's SM8 vendor UUID" was inconsistent with the BVT evidence — retired 2026-06-07. RFT-80 trace.)* |
| **BVT Testing** | `df902850-7e48-4e7a-8f2c-b3a65b6881da` | BVT test tenant, registered willthurlow73@gmail.com | Build-verification only — never dev, never prod. `slug:bvt` resolves here. Onboarded 2026-06-07 via admin-api Path 2 (`/onboarding/sm8-callback`, RFT-69). Domestic-electrician profile, 13 templates, 35 materials synced. |

**UUID values appear only in the safety table above. Reference docs point back here — they never redefine UUIDs.**

If you are about to write code that references the live UUID, stop and confirm with Will first.

For 2026-05-28 incident detail (UUID-swap consequence + KV audit), see [docs/rafter-history.md](docs/rafter-history.md).

---

## What Rafter is

Rafter is an AI-built quoting and operations platform for Australian tradespeople, built by
Deep Green Sea Pty Ltd (Will Thurlow). It generates branded PDF quotes from a web form,
creates jobs in ServiceM8, and attaches the PDF to the SM8 job via the two-step SM8 Attachment API.
The product itself contains no AI/ML — see constraint #12.

**First client:** Andy — 2 Men and a Shovel, Melbourne landscaper.
**Operator email (Andy's SM8):** will@deepgreensea.au
**Trial email:** will@thurlow.net
**GitHub:** shikaishi/Rafter
**Hosting:** `workers/rafter` Worker with Assets at rafter.deepgreensea.au (custom domain binding — deploy manually from `workers/rafter/`)
**Issue tracking:** Linear — https://linear.app/deepgreensea · Team: Rafter · Issue prefix: RFT

---

## Repository structure

```
/ (repo root)
└── workers/
    ├── rafter/              # Site Worker — Worker with Assets, rafter.deepgreensea.au
    │   ├── wrangler.toml    # custom_domain = rafter.deepgreensea.au
    │   ├── index.html       # Quoting form (operator-facing)
    │   ├── setup.html       # SM8 OAuth initiation
    │   ├── callback.html    # OAuth callback
    │   ├── sign-up.html     # NEW 2026-06-04 — Clerk sign-up entry point (redirectToSignUp → redirectToCreateOrganization → onboarding.html)
    │   └── onboarding.html    # NEW v2.0 — browser intake form, posts to /onboarding/provision
    ├── materials-sync/      # rafter-materials-sync Worker
    │   ├── wrangler.toml
    │   └── index.js
    ├── pdf/                 # rafter-pdf Worker
    │   ├── wrangler.toml
    │   └── index.js
    └── admin-api/           # rafter-admin-api Worker (NEW v2.0 — stub deployed, provisioning TBD)
        ├── wrangler.toml
        ├── package.json
        └── index.js
```

**CRITICAL:** Never put wrangler.toml at repo root. All Workers deploy manually:
`cd workers/<name> && npx wrangler deploy`. The site is served by `workers/rafter/` (Worker with
Assets, custom domain binding in wrangler.toml). No git auto-deploy is active — the Pages project
build command is `exit 0`.

---

## Where to find things

| Working on... | Read first |
|---|---|
| Any Worker (deploy, secrets, endpoints, KV operational notes) | [docs/workers-reference.md](docs/workers-reference.md) |
| ServiceM8 API calls (endpoints, scopes, store-token contract) | [docs/sm8-api.md](docs/sm8-api.md) |
| Make.com scenarios (IDs, monitoring, BUG-25 fragility) | [docs/make-reference.md](docs/make-reference.md) |
| PDF generation (workers/pdf, fonts, photo compression, preview screen) | [docs/pdf-spec.md](docs/pdf-spec.md) |
| Operator form (CSS variables) | [docs/form-design.md](docs/form-design.md) |
| D1 queries (`rafter-events`, `rafter-quotes`) | [docs/d1-schema.md](docs/d1-schema.md) |
| Onboarding flow Step 1–4 (CORS, SM8 prefill, gaps) | [docs/onboarding-reference.md](docs/onboarding-reference.md) |
| Clerk integration (org model, billing, JWT key, CDN gotcha) | [docs/clerk-reference.md](docs/clerk-reference.md) |
| Branding values (Andy) | [docs/branding.md](docs/branding.md) |
| Why a rule exists / past incident / closed VER items | [docs/rafter-history.md](docs/rafter-history.md) |

---

## Cloudflare infrastructure

| Resource | Name / ID |
|----------|-----------|
| Site Worker | `rafter` — rafter.deepgreensea.au (custom domain, Worker with Assets) |
| R2 bucket | `rafter-assets` |
| KV namespace | `RAFTER_CLIENTS` |
| KV namespace ID | `7c7ad02d8136452eb6d03d1af89a684f` |
| wrangler.toml binding | `binding = "RAFTER_CLIENTS", id = "7c7ad02d8136452eb6d03d1af89a684f"` |
| D1 database | `rafter-events` — ID `39f38376-d163-439b-984d-2f0889e88d56` (built 2026-05-31) |
| D1 database | `rafter-quotes` — quote payload persistence for edit/versioning (RFT-32). ID: TBD on creation (RFT-36). Durable retention — NOT on the `rafter-events` 90-day prune. |

Operational notes (KV tooling, W2W service bindings, KV key format, KV records table, KV record contents) → [docs/workers-reference.md](docs/workers-reference.md).

---

## Prod auth state — cutover 2026-06-11

The prod Clerk instance is live. RFT-87 scope (b) passkey-on-invite enrolment is deployed and validated with the first real prod admin (SM8 OAuth → callback.html → first-device passkey enrolled on `rafter.deepgreensea.au`). RFT-94 (cross-tenant photo embed) and RFT-107 (v2 token claim shape) shipped in the same bundle.

### Instance config

| Field | Value |
|---|---|
| Plan | Pro |
| Publishable key (all 6 rafter pages) | `pk_live_Y2xlcmsuZGVlcGdyZWVuc2VhLmF1JA` (base64 decode: `clerk.deepgreensea.au$`) |
| Frontend API CDN host (script src) | `https://clerk.deepgreensea.au/npm/@clerk/clerk-js@6.14.0/dist/clerk.browser.js` — pinned across `index.html`, `callback.html`, `onboarding.html`, `sign-up.html`, `settings.html`, `accept-invite.html` |
| Account Portal (hosted UI) | `accounts.deepgreensea.au` — used for sign-up + create-org + no-session fallback only |
| Membership model | Org-as-unit-of-auth. **Personal Accounts: OFF (Membership required).** The `choose-organization` task fires post-ticket; `accept-invite.html` Path B seam handler covers it (`Clerk.setActive({ organization })`). |
| Sign-up collection | **Name + Password collection: DISABLED.** Zero-field ticket accept succeeds (RFT-87 V1). |
| Passkeys | Enabled. **RP ID is root `deepgreensea.au` with allowed subdomain `rafter.deepgreensea.au`.** A passkey enrolled on rafter.deepgreensea.au works on subdomains of the same root; will NOT surface on sibling `accounts.deepgreensea.au` (Account Portal). |
| Webhook | `organization.created` only — `https://rafter-admin-api.will-8e8.workers.dev/webhooks/clerk`. No other event types subscribed. |

### admin-api prod worker secrets (set 2026-06-11)

| Secret | Source | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` | `sk_live_…` from Clerk dashboard → API Keys | Backend API calls (org invitations, memberships listing, metadata patch) |
| `CLERK_JWT_KEY` | Prod JWKS PEM from Clerk dashboard | Networkless `verifyToken` — every JWT-gated endpoint |
| `CLERK_WEBHOOK_SECRET` | Svix signing secret from the prod webhook subscription | `/webhooks/clerk` signature verification |
| `CLERK_AUTHORIZED_PARTY` | `https://rafter.deepgreensea.au` | Passed to `verifyToken` as the only allowed `azp`. Defence-in-depth against sibling-subdomain session-cookie misuse. |

**Rotate these together** if the Clerk instance is ever swapped — partial rotation can brick admin-api silently (e.g. new JWT key + old webhook secret = no new orgs provision, no obvious error).

### Token version — admin-api MUST use the helpers

Prod emits **v2** session tokens (Clerk API version 2025-11-10):

```
"o": { "id": "org_…", "rol": "admin"|"member", "slg": "…" }, "v": 2
```

There is NO top-level `org_id` / `org_role` / `org_slug` claim. The role value is the SHORT form (`"admin"`, `"member"`) without the `"org:"` prefix that v1 used.

`@clerk/backend@1.34.0` (pinned in `workers/admin-api/package.json`) returns raw decoded claims — verified against [clerk/javascript verify.ts](https://github.com/clerk/javascript/blob/main/packages/backend/src/tokens/verify.ts). No normalisation. Bare `jwtPayload.org_id` reads return `undefined` on prod and 401 every request (RFT-107).

**Every new org-scoped endpoint MUST use:**

```js
extractOrgId(jwtPayload)   // v2-first (o.id), v1 fallback (org_id), undefined if neither
extractOrgRole(jwtPayload) // v2-first with `org:` prefix re-applied → 'org:admin'/'org:member',
                           // v1 fallback (org_role as-is), null if neither
```

Defined in `workers/admin-api/index.js` near the `requireClerkJWT` block. The role helper's `org:` re-prefix means every `=== 'org:admin'` comparison site (settingsAdminGate, SM8 connect/disconnect gates, index.html `state.orgRole` check) keeps working unchanged. **Never read `jwtPayload.org_id` / `jwtPayload.org_role` directly outside the helpers.**

### New-tenant cold-start flow (supported entry path)

```
/sign-up                                  rafter.deepgreensea.au
  → clerk.redirectToSignUp                accounts.deepgreensea.au (hosted; identity only, NO passkey)
  → clerk.redirectToCreateOrganization    accounts.deepgreensea.au (hosted; webhook → KV stub)
  → afterCreateOrganizationUrl: /onboarding.html
/onboarding.html                          rafter.deepgreensea.au
  → form submit → admin-api /onboarding/provision
  → "Connect ServiceM8" → SM8 OAuth
/callback.html                            rafter.deepgreensea.au
  → admin-api /onboarding/sm8-callback
  → FIRST-DEVICE PASSKEY ENROL (correct origin = rafter.deepgreensea.au)
/<slug>                                   rafter.deepgreensea.au
  → silent passkey re-auth on return visits (index.html Surface-4 same-origin authenticateWithPasskey)
```

**Admins MUST enter via `/sign-up`.** Hitting `/onboarding.html` cold (no session) falls through to `clerk.redirectToSignIn` (hosted UI). That works for first-time identity establishment but is also the wrong-origin trap for return-visit passkey auth on that page (see KNOWN GAPS). The hosted UI portion ONLY creates the Clerk identity + session — no passkey is enrolled there. First passkey enrol happens on `/callback.html` after SM8 OAuth completes, on the correct origin.

For migrated tenants (Andy): the KV record predates the Clerk-org binding. Onboarded via admin-api Path 2 / RFT-69/70 Option C with manual admin assignment. Not the canonical cold-start path — preserved by Andy's explicit `gate_enforced: false` until RFT-101 clears.

### KNOWN GAPS — flagged 2026-06-11, not fixed today

1. **Return-visit admin sign-in on `/settings` + `/onboarding.html` bounces to hosted UI.** Both pages still call `Clerk.redirectToSignIn` on no-session, which lands on `accounts.deepgreensea.au` (Account Portal). A passkey enrolled on `rafter.deepgreensea.au` has RP ID `rafter.deepgreensea.au` and will NOT surface on the sibling subdomain — the hosted UI offers Google/email only. Only `index.html` got the Surface-4 same-origin `Clerk.client.signIn.authenticateWithPasskey({ flow: 'discoverable' })` treatment. **Workaround today:** if an admin's session expires mid-day, they re-establish via `/<slug>` (passkey works there), then navigate to `/settings`. Proper fix: replicate the Surface-4 pattern on settings.html and onboarding.html's no-session branches.

2. **Team-pane role badge may mislabel v2 admins as "Member".** `workers/rafter/settings.html` line ~2493 reads `m.role` from the Clerk Backend API `/v1/organizations/{org_id}/memberships` response and compares `=== 'org:admin'`. On v2 instances the Backend API likely returns the short form (`"admin"`), so the badge falls through to "Member" for actual admins. RFT-107 explicitly scoped this out (token-claim normalisation vs Backend API response normalisation are separate concerns). Needs verification against a real prod `/memberships` response before patching — the actual response shape is the source of truth, not the v2 token shape.

---

## Architecture decisions (locked — do not reopen without explicit instruction)

| ID | Decision |
|----|----------|
| D1 | Photos: Cloudflare R2, bucket `rafter-assets`, zero egress |
| D2 | PDF: Browser Rendering API via Cloudflare Worker |
| D3 | Client deduplication: deferred — SM8 native Merge Clients |
| D4 | Materials: KV cache 24hr TTL, nightly cron sync |
| D5 | Amendments: **RESOLVED 2026-06-02 → edit-quote feature (Linear RFT-32).** Versioned amend onto the existing SM8 job: new PDF attachment (Attachment API — multiple-attachments-per-job confirmed, RFT-33) + appended job_description version block. Rafter persists structured payload in `rafter-quotes` D1 for rehydration; `sm8_job_uuid` stored at submit time is the SOLE job-linkage (no SM8 job-search fallback exists — RFT-35). SM8 Inbox path abandoned (VER-01/02 negative). Customer artifact stays PDF-as-object; living-link delivery shelved. Requires SM8 scopes `manage_jobs` + `publish_job_attachments` + `read_attachments` (re-auth). **Live in prod 2026-06-07** — first real Andy amend confirmed. **RFT-85 liveness guard active:** finder (`/drafts`) excludes rows whose SM8 job is `active=0`; amend (`/amend-quote`) blocks with HTTP 410 `sm8_job_deleted` rather than writing into a tombstone. |
| D6 | Quote ref: Q-YYYYMMDD-HHMM (Melbourne timezone) |
| D7 | Template library: per-client KV |
| D8 | Onboarding: **v2.0 — Clerk-driven self-service. Manual checklist retired.** |
| D9 | PDF preview: new browser tab, non-destructive |
| D10 | Devices: 768px min, tablet landscape, touch-first |
| D-NEW-1 | Auth: Clerk organisations replace URL-as-password. One org per client. JWT validated at Worker edge. |
| D-NEW-2 | Billing: Clerk Billing + Stripe. Plans in Clerk dashboard. Subscription state gates Worker access. |
| D-NEW-3 | Admin API: privileged Worker surface for onboarding, verification, sync, secret rotation. Claude Code operates against this. |
| D-NEW-4 | Onboarding: Clerk session task flow → onboarding.html → Admin API provisions KV, triggers sync, verifies. |
| D-NEW-5 | Dashboard: single ops surface, business + tech view. Feeds from D1, Clerk API, Cloudflare Analytics, KV. |
| D-NEW-6 | **SM8 OAuth — org-owned single connection (RFT-70 Option C).** One SM8 grant per Clerk org. Same admin-api `/onboarding/sm8-callback` (Path 2 / RFT-69) handles both initial connect and reconnect (establish-or-refresh). Race-lock around the establish critical section — concurrent connects return 409, never silent drop. Admin-role-only (org members cannot replace the org's grant). Make removed from the OAuth path entirely. Andy migrated 2026-06-07. |
| D11 | **Section sync = mirror SM8 (RFT-63 Bundle 2, 2026-06-08).** Add / update on `edit_date` change / rename (in-place row update + R2 photo migration old slug → new slug + `photo_order` key rewrite) / remove (drop row + R2 photos under slug + `photo_order` entry). Templates keyed by `sm8_template_uuid` with first-run name-match backfill (existing rows pre-Bundle-2 stamp themselves on next sync). Safeguard: `EMPTY_SM8_REFUSE_WIPE` aborts the call (HTTP 502) if SM8 returns 0 active templates while Rafter has rows — protects against token blips silently wiping a tenant. The earlier "never removes templates that disappeared from SM8 (protects quote history)" rule was retired — quote history is the PDF on the SM8 job, nothing local depends on the old row. |
| D12 | **Section order is admin-set (RFT-63 Bundle 3, 2026-06-08).** `record.templates` array order IS the canonical order, applied across: settings sections list, form photo picker section pills, PDF section render. One lever. Settings UI: collapsed-by-default cards; drag-reorder enabled only when all sections are closed (clean modes — no collision with per-photo drag inside an open section). New sync-added rows prepend to the top (per Will: noticeable beats buried). `POST /settings/sections/reorder { order: [sm8_template_uuid, ...] }` is the writer. materials-sync `/photos/{uuid}` mirrors the same sort so the form picker follows. |
| D13 | **Per-pane config write-back pattern (RFT-102, 2026-06-09).** Every `/settings/config/<pane>` endpoint follows the same three-layer guarantee: (1) `rejectForbiddenConfigKeys(body)` → 400 if body carries `slug`, `webhook_env`, `webhook_url`, `access_token`, `refresh_token`, `expires_at`, `sm8_uuid`, `clerk_org_id`, `gate_enforced`, `uuid`, `logo_url`, `templates`, `photo_order`, or `staff_uuid`; (2) **allowlist-pick** — `pickStringFields(body, KNOWN_KEYS)` produces a `fields` map containing only the pane's own slice, body keys outside the allowlist are silently dropped; (3) **slice-only mutator** — `mutateClientRecord(uuid, env, fn)` does the atomic read-JSON-mutate-write, and the mutator only touches its slice (scalar `Object.assign`, nested objects deep-merge so partial saves never null adjacent keys). uuid is resolved from JWT org claim, never trusted from input. Admin-gated via `settingsAdminGate` (Clerk JWT + `org:admin`). The three layers compose to a structural guarantee that no pane can ever corrupt another pane's data — even with a malicious or buggy client. `/onboarding/provision` left untouched for the onboarding flow; per-pane endpoints sit alongside it. |
| D14 | **Branding presets single-source (RFT-102 + RFT-105, 2026-06-09).** `workers/pdf/index.js` lines 13-35 is the canonical home of `PRESETS` (currently 8 palettes — `deep-green-sea`, `slate-copper`, `ink-amber`, `oxblood`, `harbour-blue`, `plum-stone`, `teal-rust`, `graphite`) + `PLATFORM_DEFAULTS` + `resolveBranding`. `rafter-pdf` exposes `GET /presets` returning `{platform_default, presets, preset_names}`. `rafter-admin-api` `GET /settings/branding-presets` proxies it via the `PDF_WORKER` service binding (constraint #11 — no workers.dev). The settings + onboarding picker UIs lazy-fetch this on first card expand and cache in browser memory. **Never inline-mirror the preset list anywhere** — swatch-vs-rendered-PDF drift is the worst branding failure mode. `resolveBranding` falls through cleanly on unknown preset keys (b.preset → PRESETS lookup → undefined → null → OR-chain falls to PLATFORM_DEFAULTS) so removing or renaming a preset never crashes, just causes orphaned tenants to render in the platform palette until they re-pick. |
| D-MAKE | Make.com retained as-is. Replacement deferred — separate future decision. |
| — | Agent lives on Rafter side. SM8 is a dumb REST recipient. |
| — | job_description is append-only with delimiter markers. Never overwrite. |
| — | Rafter is bounded-stateful — `rafter-quotes` D1 persists payloads for rehydration/versioning (RFT-32); `rafter-events` D1 is event-logging only; SM8 is system-of-record for issued quotes. |
| — | No client UUID or credential hardcoded in platform files. All config from KV. |

---

## Build agent — MCP tools available (NEW v2.0)

Claude Code operates with the following MCP servers connected. Use these before reaching for
wrangler CLI or manual steps.

| MCP Server | Tools | Key capabilities |
|------------|-------|-----------------|
| Cloudflare | 89 | `kv_get` `kv_put` `kv_list` `kv_delete` · `r2_put_object` `r2_get_object` · `worker_deploy` · `d1_query` · `secret_put` |
| GitHub | 42 | Commits · PRs · issues · file reads/writes on shikaishi/Rafter |
| Linear | 35 | Issue create/update/search on Deep Green Sea workspace · RFT prefix |

**Claude Code can directly:**
- Read and write KV records without wrangler
- Upload files to R2 without wrangler
- Deploy Workers
- Query D1 (`rafter-events` — ID `39f38376-d163-439b-984d-2f0889e88d56`)
- Create and update Linear issues
- Commit code and open PRs on shikaishi/Rafter

**Make.com remains UI-only.** Document required Make changes and hand to Will.

### Tool discipline (token and approval efficiency)

**For file operations — always use the built-in tools, never Bash/PowerShell:**
- File search → `Glob` · Content search → `Grep` · File read → `Read`
- Never substitute `Bash(find ...)`, `Bash(grep ...)`, `PowerShell(Get-ChildItem ...)` for these

**For Cloudflare data — MCP first, wrangler CLI second:**
- KV reads → `mcp__cloudflare__kv_get` before `npx wrangler kv key get`
- Note: wrangler v4 `kv key list` and `kv key get` are broken (return empty/not-found). MCP is the reliable path.
- If `kv_get` returns `[object Object]` (MCP serialisation bug), fall back to wrangler; if that also fails, **stop and ask Will to retrieve the value from the Cloudflare dashboard** — do not explore workarounds iteratively.

**Dead-end rule:** If a data source is inaccessible after one attempt with each available tool, stop and ask Will one targeted question. State exactly what value is needed and why. Do not iterate through system directories or try multiple alternative approaches unilaterally.

---

## Claude Chat / Claude Code split

**Claude Code owns:**
- File reads and writes (index.html, Workers, scripts)
- API verification calls (GET /staff.json, test POSTs, etc.)
- Bulk operations and SM8 cleanup scripts
- KV reads/writes via Cloudflare MCP
- R2 uploads via Cloudflare MCP
- Linear issue management via Linear MCP
- GitHub commits and PRs via GitHub MCP
- Admin API calls for provisioning and verification
- Anything requiring execution and real output

**Claude Chat owns:**
- Architecture decisions and sequencing
- Make.com configuration (UI-based — Code cannot touch it)
- Bug triage and prioritisation
- Continuation prompts and session handoff

**Handoff format** (Chat → Code):
```
TASK: [one line]
FILE: [exact path or N/A]
ENDPOINT: [if API call]
INPUT: [exact values]
SUCCESS CONDITION: [what done looks like]
CONTEXT: See CLAUDE.md
```

---

## Open design blocks

- D5 PDF delivery path unresolved — blocks T1-E1. Detail in [docs/rafter-history.md](docs/rafter-history.md).
- Quote title hardcoded — needs design decision from Will before change.

All other issues tracked in Linear, team Rafter, prefix RFT — canonical.

---

## Non-negotiable constraints

1. **Trial instance only** for development. Andy's active KV record (`0e604a45-…`) is production — explicit sign-off required for any write. T1-F2 is complete; Andy is live (Clerk-org-bound since 2026-06-07; OAuth via Path 2 / RFT-70 Option C).
2. **No client UUID, credential, or client-specific value hardcoded** in platform files.
3. **Rafter is bounded-stateful.** SM8 remains system-of-record for the issued quote. Rafter persists the structured submission payload in the `rafter-quotes` D1 database solely to enable quote rehydration and versioned editing (RFT-32). `rafter-events` D1 remains event-logging only. No other quote state is held; Rafter does not become the quote system-of-record.
4. **job_description is append-only** with delimiter markers, by Rafter convention. NB: SM8 itself permits overwrite via `POST /job/{uuid}.json` (verified RFT-34) — append is Rafter's deliberate choice, not an SM8 limitation. Revisitable pending Andy's input (RFT-41 Q1); changing to overwrite is a one-line change. Never overwrite while this convention stands.
5. **Agent on Rafter side only.** SM8 is a dumb REST recipient.
6. **768px minimum.** Touch-first. Mobile out of scope.
7. **No assumptions.** Flag for verification if not confirmed in this file.
8. **Citations required** for any external platform claim (API behaviour, endpoint shape, etc.).
9. **Admin API is the only privileged surface.** Claude Code operates against it — never directly against production KV with client data outside of the Admin API contract.
10. **Clerk org = security boundary.** No request reaches protected resources without a valid Clerk JWT with active subscription.
11. **Worker-to-Worker calls MUST use Service Bindings, never workers.dev URLs.** Cloudflare silently drops same-account W2W subrequests routed via workers.dev — zero events in wrangler tail, no error returned. Declare the target worker in wrangler.toml `[[services]]` and call via the binding. The `MATERIALS_SYNC_WORKER` binding on admin-api is the canonical example; every future W2W call must follow this pattern.
12. **No AI/ML in the product.** The quoting path is deterministic software — no models, no inference, no LLM calls in any user-facing flow. This is deliberate and load-bearing: tradies need simple, reliable tech, not AI. Do not introduce AI/ML features, model calls, or "smart"/inference-based behaviour without explicit decision to reverse this principle. AI is the BUILD method (Will + Claude Chat + Code) — not a product feature. Don't confuse the two. Full thesis: Linear RFT-99.
