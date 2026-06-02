# Claude Code tuning — desktop setup notes

> Drafted from a phone session (2026-06-02). Intent: cut superfluous approval
> prompts and use model-by-task routing — **without** weakening any deliberate
> safety gate (UUID / prod-KV / secret protections from CLAUDE.md).
>
> **This file is not auto-read.** To make Claude load it automatically on the
> desktop, do the one-time step in "Activating on desktop" below.

---

## 1. Fewer approval prompts

### How approvals work
Every tool call is checked against three lists in `.claude/settings.json`:
`allow` (runs silently) · `ask` (prompts) · `deny` (blocked). Anything not
matched falls through to a default prompt. The "noise" is read-only calls that
simply aren't in `allow` yet. Patterns are granular: `Bash(git diff:*)` covers
`git diff` and variants only.

### Recommended: run the built-in skill *on the desktop*
```
/fewer-permission-prompts
```
It scans the session transcript for the safe, read-only calls you keep
approving and writes a prioritised allowlist into the **project**
`.claude/settings.json`. Run it on the desktop (not the phone) so the MCP
server names match that environment — Linear/Cloudflare connections can appear
under different identifiers per environment; GitHub is stably named
(`mcp__github__*`).

### Safe to add to `permissions.allow` (read-only — paste-ready)
```jsonc
"Bash(git branch:*)",
"Bash(git show:*)",
"Bash(git remote:*)",
"Bash(git rev-list:*)",
"Bash(npx wrangler whoami)",
"mcp__github__get_file_contents",
"mcp__github__pull_request_read",
"mcp__github__issue_read",
"mcp__github__list_pull_requests",
"mcp__github__list_issues",
"mcp__github__list_commits"
```
Cloudflare/Linear read tools (`kv_get`, `kv_list`, Linear `list_issues`,
`get_issue`) are best added by `/fewer-permission-prompts` in the desktop
environment so the server names resolve correctly.

### Do NOT auto-allow (keep these gated — they are deliberate)
- `wrangler kv / secret / d1` **writes** — prod-data / UUID safety rules
- `git push` — already in `ask`
- Any MCP **write**: `kv_put`, `kv_delete`, `save_issue`,
  `create_pull_request`, etc.
- `d1_query` — one tool name covers both `SELECT` and `DELETE`; permissions
  can't tell them apart, so it must keep prompting.

The existing `ask` / `deny` lists in `.claude/settings.json` stay as-is.

---

## 2. Model switching by task

There is no automatic router — switching is deliberate, two ways.

### A. Main session
- `/model` to set the session model · `/fast` to toggle faster Opus output.
- **Opus** — architecture, ambiguous or safety-critical work (most real Rafter
  decisions, given the UUID hazards).
- **Sonnet** — routine coding, edits, straightforward implementation.
- **Haiku** — mechanical/throwaway: searches, file listings, log scans.

### B. The real token win — per-subagent models
When dispatching a subagent (the `Agent` tool), pin **its** model independently
of the main session. Stay on Opus for judgment, but hand codebase sweeps to a
**Haiku/Sonnet `Explore` subagent** that fans out, reads excerpts, and returns
only the *conclusion* — the file dumps never enter the main context. Cheap model
**and** isolated context for the grep-heavy 80%; Opus reserved for the 20% that
needs it.

**Guardrail:** never push safety-critical reasoning down to a small model.
Anything touching UUIDs, KV writes, or prod stays on Opus.

---

## Activating on desktop (one-time)

Pick one:
1. **Reference on demand:** tell Claude *"read docs/claude-code-tuning.md"* at
   the start of a tuning session.
2. **Auto-load (recommended):** add this file to your **personal, machine-local**
   memory so it loads every desktop session without touching the shared
   `CLAUDE.md` or the build. In `~/.claude/CLAUDE.md` add an import line:
   ```
   @<absolute-path-to-repo>/docs/claude-code-tuning.md
   ```
   or just paste the relevant sections in. This stays local to the desktop and
   never affects teammates, the phone, or the Rafter build.

> Do not add an `@import` to the repo's `CLAUDE.md` — that file is locked during
> the current build.
