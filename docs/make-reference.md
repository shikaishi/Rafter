# Make.com reference

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Make.com scenarios

| Scenario | Webhook URL | Purpose |
|----------|-------------|---------|
| Account Discovery | `hook.eu1.make.com/38k3vwhijsfun40uu3pmk942gdjnvj32` | OAuth token exchange |
| Data Retrieval | `hook.eu1.make.com/hao3fhj1n2d1il4bhkkabozjwl892ujt` | Pull SM8 data on callback |
| Rafter Form (prod) | (no external webhook — `5537814`) | Quote submission → SM8 job creation |
| Rafter Form - Dev | (no external webhook — `5962197`) | Dev/trial submissions |

**Probe 2 monitoring (RFT-47 — nightly cron):** For each scenario above (5612449, 5537814), Probe 2 checks: `isPaused`, `isActive === false`, `dlqCount > 0` (dead-letter queue — failed executions awaiting retry). Any of these signals an alert. `dlqCount > 0` is the primary early-warning signal for execution failures that did not yet deactivate the scenario.

**Make Data Store:** "Rafter Tokens" — fields: uuid, access_token, refresh_token, expires_at.

**Make is UI-only** — Claude Code cannot modify Make scenarios. Document the required Make
changes and hand them to Will for manual configuration.

**⚠️ Make UI fragility (BUG-25):** Two modules in the Rafter Form prod scenario were fixed by direct API PATCH and will **silently revert** if the scenario is opened and saved through the Make UI: M3 `company_uuid: {{ifempty(1.client_sm8_uuid; 2.headers.\`x-record-uuid\`)}}` and M33/M37 subject expressions. If new-customer jobs start appearing with blank `company_uuid`, or the email subject regresses, re-PATCH from `make-blueprints/rafter-form-prod-2026-05-21-final.json`. **Avoid opening the Rafter Form prod scenario in the Make UI.**

**Make.com replacement** is a deferred future decision. Candidates: Pipedream (has REST API,
programmable scenario provisioning) or Cloudflare Workers + Queues (eliminates iPaaS entirely).
Do not act on this until Will explicitly initiates the workstream.
