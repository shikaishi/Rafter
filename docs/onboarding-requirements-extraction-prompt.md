# Prompt for Claude Chat — Onboarding Field Requirements Extraction

Paste the following into Claude Chat (ideally a session with the GitHub connector active so it can read the current CLAUDE.md):

---

I need you to produce a **comprehensive, definitive table of every piece of information required to onboard a new Rafter client**. This will drive the build of the onboarding intake form.

Draw on ALL of the following sources — do not leave anything out:
1. Every conversation we have had about Rafter onboarding, client configuration, Andy's setup, and the KV record
2. The current CLAUDE.md in the shikaishi/Rafter repo (read it via the GitHub connector) — particularly the KV record contents section for `client:0e604a45-…` which is Andy's audited live record
3. Linear issue **RFT-53** (read it via the Linear connector) — contains the current field inventory and what's missing
4. Linear issue **RFT-23** and its attached document "Rafter Onboarding Requirements Spec — Flow E (v2.0)" — REQ-On-17 lists minimum required fields; read the full document
5. Any decisions made about what a second client (beyond Andy) would need configured differently
6. Any fields mentioned in chat that were deferred, noted as "TBD", or flagged as needing a UI

For **each field**, produce a row in a markdown table with these columns:

| Field | KV key | Type | Required? | Who sets it | Client label (UI) | Notes / validation |
|-------|--------|------|-----------|-------------|-------------------|--------------------|

Where:
- **Field** — the internal field name (snake_case as stored in KV)
- **KV key** — the exact key in the KV record (usually same as field name)
- **Type** — string / string[] / object / image / boolean / number
- **Required?** — Required (form blocks without it) / Optional / Admin-only (not shown to client) / Auto (set by system, never client-entered)
- **Who sets it** — Client (via onboarding form) / Admin (via Admin API / internal) / System (auto from Clerk/SM8/OAuth)
- **Client label** — the human-readable label shown in the onboarding form UI (leave blank if Admin-only or System)
- **Notes / validation** — any constraints, format, examples, or known decisions (e.g. "16 items in Andy's record", "must sum to 100% per tier", "from SM8 staff list after OAuth")

**Categories to cover (do not skip any):**

1. Business identity — name, ABN, contact details, address
2. Branding — logo, colours
3. SM8 configuration — staff UUID, OAuth tokens, scopes
4. Job/quote configuration — proposal types, job categories, job queues, payment thresholds
5. Content/legal — credentials (licences, insurances), terms and conditions, templates
6. Email — email template (HTML with merge fields), operator email
7. Rafter internal — slug, webhook URL, Clerk org ID
8. OAuth / tokens — access_token, refresh_token, expires_at (these are system fields, still need a row)

**After the table, add a separate section:**

## Decisions needed before building

List any fields where the right UX approach is unclear — e.g.:
- Should `templates` be entered during onboarding or added later?
- Should `credentials[]` and `terms_and_conditions[]` be pre-populated with Andy's values as defaults for new clients?
- Should `slug` be auto-generated from company_name (e.g. "2 Men and a Shovel" → "2-men-and-a-shovel") or manually set by admin?
- Should `webhook_url` be selected from a dropdown of known Make scenario URLs rather than free-text?
- Should `email_template` have a default and only be customised if needed?
- Any fields that differ between Andy (first client) and a generic new client

Be exhaustive. If you find a field mentioned anywhere in our conversations that is not obviously covered, include it. The goal is a single source of truth that Claude Code can use to build a complete onboarding form without further research.
