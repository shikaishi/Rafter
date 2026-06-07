# Rafter — historical notes & closed items

This file captures the *why* behind rules in CLAUDE.md — incident detail, closed verifications,
and changelog material. Operational rules live in CLAUDE.md and the other docs/*.md files;
this file is read on demand when an incident reference matters.

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

### Incident note — 2026-05-28: UUIDs were documented swapped

> **2026-06-07 update (RFT-80 trace):** The 2026-05-28 conclusion that `448e12a8-…` represents Andy's live SM8 vendor identity was subsequently shown to be inconsistent with empirical evidence. On 2026-06-07 a job was cloned in the BVT tenant via the Rafter OAuth app; the resulting job carried `created_by_staff_uuid=448e12a8-…` while BVT's own `/vendor.json` returned `4cf818e5-…`. Per-vendor SM8 UUIDs cannot be shared across distinct tenants, so `448e12a8-…` is not a per-tenant vendor identity. Whatever it represents server-side, the practical safety rule is unchanged: the KV record at `client:448e12a8-…` is an orphan and must not be used. See current CLAUDE.md safety table for the corrected label. The narrative below preserves the 2026-05-28 understanding as it stood at the time.

CLAUDE.md v2.0 (and the rafter-continuation-prompt before it) had these two UUIDs reversed. The UUID labelled "Trial" (`448e12a8-…`) is actually **Andy's live**, and the UUID labelled "Andy's live" (`010895db-…`) is actually the trial. Discovered via SM8 OAuth `/vendor.json` traces from Make scenario `5612449` runs on 2026-05-28.

Consequence: every prior "dev/test" call against `448e12a8-…` — every KV write, every materials sync, every PDF preview, every Worker deploy verified against that UUID — has been hitting Andy's live SM8 instance. The KV record at `448e12a8-…` contains Andy's real branding, real materials (117 items), real customer list. The "trial KV record" referenced throughout this document up to v2.0 *is* Andy's live record.

**Dev environment provisioned 2026-05-30.** `slug:dev` → `010895db-…` KV record, OAuth complete (will@thurlow.net), 114 materials synced, dev Make scenario 5962197 active. Use `rafter.deepgreensea.au/dev` for all development and testing. Treat `448e12a8-…` as production for any write operation.

**KV audit — completed 2026-05-30:** The active record (`client:0e604a45-…`) was audited and is clean — correct prod webhook, Andrew Little staff_uuid, Andy's logo, 6-tier payment thresholds, 24 templates, correct credentials/T&Cs. The orphaned record (`client:448e12a8-…`) has stale dev values but is not used by the form.

## v2.0 changes — session May 2026

| Area | Change |
|------|--------|
| Auth | Clerk organisations replace URL-as-password. One Clerk org per client. JWT validated at Worker edge. |
| Billing | Clerk Billing + Stripe. Plans in Clerk dashboard. Subscription state gates Worker access. |
| Onboarding | Clerk session task flow → onboarding.html intake → Admin API provisions KV. Replaces manual checklist. |
| Admin API | New Worker: privileged surface for provisioning, verification, sync, secret rotation. Claude Code operates against this. |
| D1 | rafter-events database: submissions + events tables. 90-day retention. Feeds dashboard. |
| Dashboard | New: rafter.deepgreensea.au/dashboard. Business view + tech/ops view. |
| Build agent | Claude Code + Cloudflare MCP (89 tools) + GitHub MCP (42 tools) + Linear MCP (35 tools). |
| Issue tracking | Linear replaces Google Sheets issue tracker. |
| Make.com | Retained as-is. Replacement deferred — separate future decision. |
| Security model | Per-client Clerk org replaces "know the URL". |

## Open issues — tracked in Linear

**Issue tracker:** https://linear.app/deepgreensea · Team: Rafter · Prefix: RFT

Google Sheets issue tracker is retired. All issues now in Linear. Current open items:

| Linear ID | Title | Priority | Status |
|-----------|-------|----------|--------|
| RFT — VER-01 | SM8 Inbox API PDF attachment support | — | Closed (answered negative 2026-05-14) — Inbox has no file attachment field; re-examine D5 before T1-E1 |
| RFT — VER-02 | SM8 OAuth scope includes Inbox write access | — | Closed (moot — VER-01 answered negative) |
| RFT — DEBT-01 | Make email delivery template not served from KV | High | In Progress |
| RFT — DEBT-03 | Make dev/prod scenario separation | Medium | **Done** — slug:dev → trial → dev scenario 5962197; slug:andy → prod 5537814 (2026-05-30) |
| RFT — (open) | Quote title hardcoded — needs configurable per-client title | Medium | Open — deferred |
| RFT — (open) | bank_details onboarding gap — not yet in Step 3 | Low | Open — deferred |

**VER-01 (closed negative 2026-05-14):** SM8 Inbox API has no file attachment field — `createInboxMessage` OpenAPI schema has no file/attachment property. Account also returns `Inbox functionality is not available on this account`. Inbox delivery is not viable. D5 must be re-examined before T1-E1 to determine the PDF delivery path.

**VER-02 (closed — moot):** `publish_inbox` scope is irrelevant given VER-01 negative result.

**VER-03 (closed):** New job UUID returned in `x-record-uuid` response header, not body.
Any consumer of `POST /job.json` must read headers.

**Quote title hardcoded (open — design TBD):** `pdf/index.js:24-27` defines `PROPOSAL_TYPE_LABEL = { LC: "Landscape Construction", GM: "Garden Maintenance" }`. `index.html:944` hardcodes `proposalType: "LC"` with no UI selector. `client.proposal_types` is a dead KV field — the form never reads it. Title shown on PDF is always "Landscape Construction". Fix requires a configurable per-client title mechanism. Do not change without a design decision from Will.

**Bot/scanner webhook exploitation (RFT-58 — open):** Make webhook URLs are exposed in client-side JS. Bots POST malformed payloads that trigger Make `BundleValidationError`. Mitigation options being assessed. Seen on both dev (5962197) and prod (5537814) scenarios.

## Things that require verification before building

**SM8 verifications — answered 2026-05-14:**
- **Inbox-attach delivery not supported** (VER-01 closed negative). No file field on `createInboxMessage`. D5 delivery path is unresolved — must be re-examined before T1-E1.
- **`publish_inbox`** scope is moot (VER-02 closed).
- **`create_jobs`** present and working (RFT-26). Edit-quote (RFT-32) scopes (`manage_jobs`, `publish_job_attachments`, `manage_attachments`) are **already in setup.html scope string** (added 2026-06-04) — new clients get them automatically. **Andy needs to re-auth** via setup.html to gain these scopes.
- **New job UUID** in `x-record-uuid` response header, not body.

**v2.0 items requiring verification before building:**
- Clerk JWT validation in Cloudflare Workers — verify `@clerk/backend` works with Workers runtime before Admin API build
- Clerk webhook signature verification in Workers context
- D1 binding setup in rafter-materials-sync wrangler.toml
- Admin API Worker authentication pattern against Clerk webhook format

Check SM8 developer docs at https://developer.servicem8.com for new endpoints / changes,
and prefer test calls against the trial instance for new verification work.
