# D1 schema

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

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
