# D1 schema

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Inject

Two D1 databases, distinct lifecycles. Don't mix them.

`rafter-events` (ID `39f38376-d163-439b-984d-2f0889e88d56`) is **event logging only** with
a **90-day rolling retention**. It does NOT persist quotes. Reading it as quote storage
loses data at 90 days. Binding `RAFTER_EVENTS` is present on admin-api, materials-sync,
and pdf (multi-writer reality — earlier docs said materials-sync only).

`rafter-quotes` (ID `71594968-73c4-490a-b4bc-a425b0400402`) holds the structured submission
payload for rehydration / amend (RFT-32). **Durable — NOT on the prune.** Binding
`RAFTER_QUOTES` on admin-api and materials-sync.

`sm8_job_uuid` written at submit time on `rafter-quotes` is the SOLE link from a Rafter
quote to its SM8 job (RFT-35). No job-search fallback exists. The amend handler
(`/amend-quote`) blocks with HTTP 410 `sm8_job_deleted` rather than writing into a tombstone
(RFT-85 liveness guard) — never bypass.

Rafter is **bounded-stateful**: SM8 remains system-of-record for the issued quote (the
PDF on the SM8 job is the customer artifact). Rafter persists structured payload to
enable rehydration / versioned editing only. Don't make Rafter the quote system-of-record.

Event-row shape: `events (id, client_uuid, event_type, occurred_at, payload)`. Helper:
`writeEvent(env, event_type, client_uuid, payload)` at `workers/admin-api/index.js:4547`
and an equivalent in materials-sync. Always JSON-stringify the payload; never write a
literal object — D1 binds via `.bind(...).run()`.

## D1 — rafter-events (NEW v2.0 — built 2026-05-31, RFT-27)

**Database name:** `rafter-events`
**Database ID:** `39f38376-d163-439b-984d-2f0889e88d56`
**Write ownership:** `rafter-materials-sync` Worker — binding `RAFTER_EVENTS` in wrangler.toml
**Retention:** 90-day rolling window
**Purpose:** Event logging for dashboard. Not quote persistence — Rafter remains stateless.

### Schema

```sql
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  client_uuid TEXT NOT NULL,
  quote_ref TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  total_value REAL,
  proposal_type TEXT,
  status TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  client_uuid TEXT,
  event_type TEXT NOT NULL,  -- quote_submitted, sync_completed, onboarding_completed, sync_failed, etc.
  occurred_at TEXT NOT NULL,
  payload TEXT                -- JSON blob, optional
);
```

### Make.com integration points
- Quote submission → POST event to `/store-event` endpoint on rafter-materials-sync
- Sync completion → write event directly from Sync Worker
