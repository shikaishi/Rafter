# Branding

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Inject

Andy's brand values are tenant data, not platform constants. They live in
`client:0e604a45-…` KV record's `branding` slice and are surfaced via the
`deep-green-sea` preset in `workers/pdf/index.js` (`PRESETS` table, RFT-105).
Never hardcode `#0D2E1C`, `#84B741`, or `#ECF1E8` outside that preset entry.

Logos are R2-keyed by tenant UUID — `clients/{uuid}/logo.png` — and served via
materials-sync `/logo/{uuid}`. The `logo_url` field on the KV record is the
public reachable URL form; do NOT fetch it Worker-to-Worker (the URL is
`workers.dev`-hosted and exists for browser + PDF consumption only).

Per-tenant branding pane is admin-set in `/settings`. Edits go through
`POST /settings/config/branding` and write only the branding slice via
`mutateClientRecord` — never bypass.

## Andy's branding

| Element | Value |
|---------|-------|
| Primary dark green | `#0D2E1C` |
| Lime accent | `#84B741` |
| Light background | `#ECF1E8` |
| Heading font | Playfair Display Semi-Bold (600) |
| Body font | Mulish Regular (400) / Bold (700) |
| Logo (R2) | `clients/0e604a45-84fd-4789-a2cb-662bcba51a8b/logo.png` |
