#!/usr/bin/env bash
# PostToolUse hook — Rafter convention enforcement (grep validation)
#
# Runs after Edit / Write completes. Greps the modified file for known
# anti-patterns. exit 2 + stderr message = blocking violation (agent must
# self-correct). exit 0 = clean.
#
# IMPORTANT: every check below was verified against the codebase at the time
# the hook was added — pre-existing violation counts were 0 (or were allowlisted
# explicitly by file:line). Adding a check that fires on existing lines would
# block every edit. If a new check would fire on >2 pre-existing lines, defer
# it and clean up the lines first.

set -u

# stdin is the PostToolUse hook payload
INPUT=$(cat)

# Pull the file path out via node — works on Windows Git Bash and macOS/Linux
ABS_FILE=$(printf '%s' "$INPUT" | node -e '
  let s = "";
  process.stdin.on("data", c => s += c);
  process.stdin.on("end", () => {
    try {
      const i = JSON.parse(s);
      process.stdout.write(i?.tool_input?.file_path || "");
    } catch { process.stdout.write(""); }
  });
')

# No file? nothing to check.
if [ -z "$ABS_FILE" ]; then exit 0; fi
# File doesn't exist? Write may have been blocked upstream — nothing to check.
if [ ! -f "$ABS_FILE" ]; then exit 0; fi

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
# Normalise Windows backslashes to forward slashes for portable matching.
NORM_ABS=$(printf '%s' "$ABS_FILE" | tr '\\' '/')
NORM_ROOT=$(printf '%s' "$PROJECT_ROOT" | tr '\\' '/')
case "$NORM_ABS" in
  "$NORM_ROOT"/*) FILE="${NORM_ABS#"$NORM_ROOT"/}" ;;
  *) FILE="$NORM_ABS" ;;
esac

VIOLATIONS=""
WARNINGS=""

add_violation() { VIOLATIONS="${VIOLATIONS}❌ $1"$'\n'; }
add_warning()   { WARNINGS="${WARNINGS}⚠️  $1"$'\n'; }

# Scope: only check worker code, not docs / CLAUDE.md / scripts.
case "$FILE" in
  workers/*) ;;
  *) exit 0 ;;
esac

# ── 1. Forbidden UUID literals in worker code ────────────────────────────────
# These three UUIDs MUST NOT appear as string literals in worker code. Allowlist
# exception: workers/admin-api/index.js BACKFILL_TARGETS block (~line 3151) —
# documented one-shot for the two non-prod legacy tenants (dev + bvt).
FORBIDDEN_UUIDS=(
  "0e604a45-84fd-4789-a2cb-662bcba51a8b"
  "448e12a8-f7d9-4ace-b8c6-242bf678db3b"
  "010895db-e06c-465d-bce9-2424477be15b"
)
for uuid in "${FORBIDDEN_UUIDS[@]}"; do
  # grep -F = fixed-string (no regex). -n = line numbers.
  if grep -nF "$uuid" "$ABS_FILE" >/dev/null 2>&1; then
    while IFS= read -r line; do
      lineno="${line%%:*}"
      # Allowlist: admin-api BACKFILL_TARGETS block (lines 3140-3160).
      if [ "$FILE" = "workers/admin-api/index.js" ] && [ "$lineno" -ge 3140 ] && [ "$lineno" -le 3160 ]; then
        continue
      fi
      add_violation "Forbidden UUID literal $uuid at $FILE:$lineno — see docs/safety-rules.md. Tenant UUIDs come from KV at runtime, never as hardcoded strings."
    done < <(grep -nF "$uuid" "$ABS_FILE")
  fi
done

# ── 2. Bare jwtPayload.org_id / org_role reads ───────────────────────────────
# Allowlist: the helper bodies themselves at admin-api/index.js:167-177.
if [ "$FILE" = "workers/admin-api/index.js" ]; then
  while IFS= read -r match; do
    lineno="${match%%:*}"
    if [ "$lineno" -ge 167 ] && [ "$lineno" -le 177 ]; then continue; fi
    add_violation "Bare jwtPayload.org_id/org_role read at $FILE:$lineno — RFT-107 root cause. Use extractOrgId(jwtPayload) / extractOrgRole(jwtPayload). See docs/clerk-reference.md."
  done < <(grep -nE 'jwtPayload\.(org_id|org_role)' "$ABS_FILE" 2>/dev/null || true)
elif [ "${FILE##*.}" = "js" ] && [ "${FILE#workers/}" != "$FILE" ]; then
  # Other workers — bare reads aren't expected at all.
  if grep -nE 'jwtPayload\.(org_id|org_role)' "$ABS_FILE" >/dev/null 2>&1; then
    while IFS= read -r match; do
      lineno="${match%%:*}"
      add_violation "Bare jwtPayload.org_id/org_role read at $FILE:$lineno — use extractOrgId/extractOrgRole helpers. See docs/clerk-reference.md."
    done < <(grep -nE 'jwtPayload\.(org_id|org_role)' "$ABS_FILE")
  fi
fi

# ── 3. fetch('https://*.workers.dev') — direct W2W via workers.dev ───────────
# Constraint #11: same-account W2W must use service bindings. This catches
# literal fetch calls only — workers.dev URLs used as logo src in HTML and as
# Request URL fields passed to env.X_WORKER.fetch are legitimate and not matched.
if [ "${FILE##*.}" = "js" ]; then
  if grep -nE "fetch\(\s*['\"]https?://[^'\"]*\.workers\.dev" "$ABS_FILE" >/dev/null 2>&1; then
    while IFS= read -r match; do
      lineno="${match%%:*}"
      # Allowlist: materials-sync syncFetch fallback at admin-api:4544 (binding-missing local-dev path)
      if [ "$FILE" = "workers/admin-api/index.js" ] && [ "$lineno" -ge 4540 ] && [ "$lineno" -le 4546 ]; then continue; fi
      add_violation "Direct fetch() to workers.dev URL at $FILE:$lineno — use the service binding (env.MATERIALS_SYNC_WORKER / env.PDF_WORKER / env.ADMIN_API). Cloudflare silently drops same-account W2W via workers.dev. See docs/workers-reference.md."
    done < <(grep -nE "fetch\(\s*['\"]https?://[^'\"]*\.workers\.dev" "$ABS_FILE")
  fi
fi

# ── 4. Google Fonts CDN in workers/pdf/ ──────────────────────────────────────
# pdf-spec.md: Google Fonts does NOT load in headless Chromium. Base64-inline only.
# Browser pages under workers/rafter/ legitimately use Google Fonts — scope to pdf/.
case "$FILE" in
  workers/pdf/*)
    if grep -nE 'fonts\.(googleapis|gstatic)\.com' "$ABS_FILE" >/dev/null 2>&1; then
      while IFS= read -r match; do
        lineno="${match%%:*}"
        add_violation "Google Fonts CDN reference at $FILE:$lineno — fonts must be base64-inlined via workers/pdf/fonts.js. CDN does not load in headless Chromium. See docs/pdf-spec.md."
      done < <(grep -nE 'fonts\.(googleapis|gstatic)\.com' "$ABS_FILE")
    fi
    ;;
esac

# ── 5. Direct KV writes outside admin-api / materials-sync ───────────────────
# Constraint #9: admin-api is the only privileged write surface. materials-sync
# has documented exceptions (store-token, refresh, materials cache, clerk_org
# fallback). pdf is read-only on KV. rafter HTML is browser-side. ops-console
# HTML is browser-side.
if [ "${FILE##*.}" = "js" ]; then
  case "$FILE" in
    workers/admin-api/index.js|workers/materials-sync/index.js) ;;
    workers/*/index.js)
      if grep -nE 'RAFTER_CLIENTS\.(put|delete)\(' "$ABS_FILE" >/dev/null 2>&1; then
        while IFS= read -r match; do
          lineno="${match%%:*}"
          add_violation "Direct RAFTER_CLIENTS write at $FILE:$lineno — only admin-api and materials-sync may write KV (constraint #9). pdf is read-only. See docs/safety-rules.md."
        done < <(grep -nE 'RAFTER_CLIENTS\.(put|delete)\(' "$ABS_FILE")
      fi
      ;;
  esac
fi

# ── 6. Env-object logging — RFT-24 incident ──────────────────────────────────
# console.log(env), Object.keys(env), JSON.stringify(env) all leak secret values.
# Rotated CLERK_WEBHOOK_SECRET when this fired.
if [ "${FILE##*.}" = "js" ]; then
  if grep -nE '(console\.(log|error|warn)\(\s*env\s*\)|Object\.keys\(\s*env\s*\)|JSON\.stringify\(\s*env\s*\))' "$ABS_FILE" >/dev/null 2>&1; then
    while IFS= read -r match; do
      lineno="${match%%:*}"
      add_violation "Env-object logging at $FILE:$lineno — leaks secrets (RFT-24). Log specific named keys only, or write a structured event. See docs/workers-reference.md."
    done < <(grep -nE '(console\.(log|error|warn)\(\s*env\s*\)|Object\.keys\(\s*env\s*\)|JSON\.stringify\(\s*env\s*\))' "$ABS_FILE")
  fi
fi

# ── Emit ─────────────────────────────────────────────────────────────────────

if [ -n "$VIOLATIONS" ]; then
  printf 'Convention violations in %s:\n%s' "$FILE" "$VIOLATIONS" >&2
  exit 2
fi

if [ -n "$WARNINGS" ]; then
  printf 'Convention warnings in %s:\n%s' "$FILE" "$WARNINGS" >&2
fi

exit 0
