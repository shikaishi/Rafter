# Safety rules

The mechanically-enforceable subset of CLAUDE.md's non-negotiable constraints. The full
list and the *why* live in CLAUDE.md and `docs/rafter-history.md`; this doc captures the
rules in inject-shaped form so the runtime hooks have a single readable source.

## Inject

The forbidden-UUID list. These three UUIDs MUST NOT appear as string literals in
worker code (`workers/*/index.js`, `workers/*/wrangler.toml`, `workers/rafter/*.html`,
`workers/ops-console/*.html`). They come from KV records or env vars at runtime only.

- `0e604a45-84fd-4789-a2cb-662bcba51a8b` — Andy's KV record. Production. Every write
  to this key reaches a live customer instance. Hardcoding it bypasses the
  multi-tenant resolution path and re-introduces the class of bug that caused the
  2026-05-28 incident.
- `448e12a8-f7d9-4ace-b8c6-242bf678db3b` — Orphaned key. The KV record was deleted
  2026-06-07 (RFT-83). The UUID retains safety-flagged status because SM8 still
  accepts it as a staff identity in some namespaces; creating a Rafter record at
  this key would re-create the orphan.
- `010895db-e06c-465d-bce9-2424477be15b` — Will's trial SM8 vendor UUID (slug:dev).
  Used for development. Hardcoding it in production code routes live customer
  flows to Will's trial instance.

Permitted appearances of these UUIDs:
- `CLAUDE.md` and `docs/*.md` — documentation lives here.
- `docs/rafter-history.md` — incident detail.
- `workers/admin-api/index.js:3151` — `BACKFILL_TARGETS` array, with the inline
  comment block at 3146-3149 explaining the one-shot `/console/backfill-environment`
  use. Andy's UUID is deliberately excluded from this array.

No other client UUID, credential, or client-specific value is hardcoded in platform
files. All config flows from KV at runtime.

Admin API is the only privileged write surface (constraint #9). Direct KV writes from
worker code outside `workers/admin-api/index.js` are forbidden, with these documented
exceptions in `workers/materials-sync/index.js`:
- `handleStoreToken` writes the SM8 token slice onto `client:{uuid}`.
- `refreshTokenIfNeeded` rewrites the same slice on token rotation.
- Materials cache write under `materials:{uuid}`.
- `clerk_org:{orgId}` reverse-index safety fallback.

`workers/pdf/index.js` is read-only on KV. Any `RAFTER_CLIENTS.put(` there is a bug.

`job_description` is append-only with delimiter markers — never overwrite. SM8 itself
permits overwrite via `POST /job/{uuid}.json` (verified RFT-34); append is Rafter's
deliberate convention so amendments preserve quote history on the SM8 job.

No AI/ML in the product (constraint #12). The quoting path is deterministic. AI is the
BUILD method, not a feature.

## Reference — discoverability

The above rules exist because they have already failed in production. They are enforced
in two places:

1. **Runtime grep checks** — `scripts/arch-validate.sh` (PostToolUse) fails on a hardcoded
   forbidden UUID literal, on a `RAFTER_CLIENTS.put(` in a worker that has no documented
   write contract, and on `fetch('https://*.workers.dev')` calls outside the bindings
   pattern.
2. **Context injection** — `scripts/inject-context.mjs` (PreToolUse) loads this doc's
   `## Inject` section when worker code or wrangler.toml is edited.

For the past-incident detail, see `docs/rafter-history.md` (2026-05-28 entry — UUID-swap
consequence) and the CLAUDE.md safety table.
