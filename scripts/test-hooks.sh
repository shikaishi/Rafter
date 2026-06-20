#!/usr/bin/env bash
# Unit tests for scripts/inject-context.mjs and scripts/arch-validate.sh.
# Run from repo root: bash scripts/test-hooks.sh

set -u

PROJECT_ROOT=$(pwd)
export CLAUDE_PROJECT_DIR="$PROJECT_ROOT"
PASS=0
FAIL=0
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t hooks-test)
trap "rm -rf '$TMP'" EXIT

pass() { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n%s\n' "$1" "$2" >&2; }

# ── inject-context.mjs tests ─────────────────────────────────────────────────

run_inject() {
  # $1 = tool_name, $2 = file_path
  # Don't redirect stderr here — caller wires it up via 2>file when it wants
  # to inspect block messages. Inner redirect would swallow them.
  printf '%s' "{\"tool_name\":\"$1\",\"tool_input\":{\"file_path\":\"$2\"}}" \
    | node "$PROJECT_ROOT/scripts/inject-context.mjs"
}

echo "── inject-context: routing tests ──"

OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/admin-api/index.js")
if printf '%s' "$OUT" | grep -q 'docs/safety-rules.md' \
   && printf '%s' "$OUT" | grep -q 'docs/workers-reference.md' \
   && printf '%s' "$OUT" | grep -q 'docs/clerk-reference.md' \
   && printf '%s' "$OUT" | grep -q 'docs/onboarding-reference.md' \
   && printf '%s' "$OUT" | grep -q 'docs/sm8-api.md'; then
  pass "admin-api/index.js injects safety + workers + clerk + onboarding + sm8"
else
  fail "admin-api/index.js routing" "$OUT"
fi

OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/pdf/index.js")
if printf '%s' "$OUT" | grep -q 'docs/pdf-spec.md' \
   && printf '%s' "$OUT" | grep -q 'docs/workers-reference.md'; then
  pass "pdf/index.js injects pdf-spec + workers"
else
  fail "pdf/index.js routing" "$OUT"
fi

OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/materials-sync/index.js")
if printf '%s' "$OUT" | grep -q 'docs/sm8-api.md' \
   && printf '%s' "$OUT" | grep -q 'docs/workers-reference.md' \
   && printf '%s' "$OUT" | grep -q 'docs/d1-schema.md'; then
  pass "materials-sync/index.js injects workers + sm8 + d1"
else
  fail "materials-sync/index.js routing" "$OUT"
fi

OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/rafter/index.html")
if printf '%s' "$OUT" | grep -q 'docs/clerk-reference.md' \
   && printf '%s' "$OUT" | grep -q 'docs/form-design.md'; then
  pass "rafter/index.html injects clerk + form-design"
else
  fail "rafter/index.html routing" "$OUT"
fi

OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/admin-api/wrangler.toml")
if printf '%s' "$OUT" | grep -q 'docs/workers-reference.md'; then
  pass "wrangler.toml injects workers-reference"
else
  fail "wrangler.toml routing" "$OUT"
fi

# Docs themselves should NOT trigger injection
OUT=$(run_inject "Edit" "$PROJECT_ROOT/docs/pdf-spec.md")
if [ -z "$OUT" ]; then
  pass "edits inside docs/ do not inject (avoids docs-into-docs noise)"
else
  fail "edits inside docs/ injected something" "$OUT"
fi

# Files outside the route table should produce nothing
OUT=$(run_inject "Edit" "$PROJECT_ROOT/scripts/test-hooks.sh")
if [ -z "$OUT" ]; then
  pass "scripts/ file produces no injection"
else
  fail "scripts/ file injected something" "$OUT"
fi

echo "── inject-context: structureCheck tests ──"

# Write a new file under an unknown worker dir → block
run_inject "Write" "$PROJECT_ROOT/workers/badname/index.js" >/dev/null 2>"$TMP/err"
RC=$?
if [ "$RC" = "2" ] && grep -q "Refusing to create new worker dir workers/badname/" "$TMP/err"; then
  pass "Write to unknown workers/badname/ blocked"
else
  fail "Write to workers/badname/ should block with exit 2" "rc=$RC err=$(cat "$TMP/err")"
fi

# Write to known worker dir → allowed
OUT=$(run_inject "Write" "$PROJECT_ROOT/workers/rafter/index.html" 2>"$TMP/err")
RC=$?
if [ "$RC" = "0" ]; then
  pass "Write to workers/rafter/index.html passes structureCheck"
else
  fail "Write to workers/rafter/index.html should pass" "rc=$RC err=$(cat "$TMP/err")"
fi

# Write to a new subdir inside a worker (workers/admin-api/services/foo.js) → block
run_inject "Write" "$PROJECT_ROOT/workers/admin-api/services/foo.js" >/dev/null 2>"$TMP/err"
RC=$?
if [ "$RC" = "2" ] && grep -q "intentionally flat" "$TMP/err"; then
  pass "Write to new nested subdir inside a worker blocked"
else
  fail "Write to workers/admin-api/services/foo.js should block" "rc=$RC err=$(cat "$TMP/err")"
fi

# Edit to existing file → never blocked by structureCheck
OUT=$(run_inject "Edit" "$PROJECT_ROOT/workers/admin-api/services/foo.js" 2>"$TMP/err")
RC=$?
if [ "$RC" = "0" ]; then
  pass "Edit (vs Write) bypasses structureCheck even on non-existent path"
else
  fail "Edit should not block structureCheck" "rc=$RC err=$(cat "$TMP/err")"
fi

# ── arch-validate.sh tests ───────────────────────────────────────────────────

run_validate() {
  # $1 = file path (absolute)
  printf '%s' "{\"tool_input\":{\"file_path\":\"$1\"}}" \
    | bash "$PROJECT_ROOT/scripts/arch-validate.sh" 2>"$TMP/validate_err"
}

echo "── arch-validate: clean codebase tests ──"

# Real existing worker files should pass (the audit confirmed 0 violations)
for f in \
  workers/admin-api/index.js \
  workers/materials-sync/index.js \
  workers/pdf/index.js; do
  run_validate "$PROJECT_ROOT/$f" >/dev/null 2>"$TMP/validate_err"
  RC=$?
  if [ "$RC" = "0" ]; then
    pass "$f passes arch-validate clean (0 violations)"
  else
    fail "$f should pass clean" "rc=$RC err=$(cat "$TMP/validate_err")"
  fi
done

echo "── arch-validate: violation detection tests ──"

# Forbidden UUID literal in a synthetic worker file → exit 2
mkdir -p "$TMP/workers/admin-api"
cat > "$TMP/workers/admin-api/index.js" <<'EOF'
const ANDY_UUID = '0e604a45-84fd-4789-a2cb-662bcba51a8b';
EOF
# Have to point CLAUDE_PROJECT_DIR at the tmp root so file scoping resolves
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/admin-api/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "Forbidden UUID literal" "$TMP/validate_err"; then
  pass "Forbidden UUID literal blocks with exit 2"
else
  fail "Forbidden UUID literal should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Bare jwtPayload.org_id read outside helper → exit 2
cat > "$TMP/workers/admin-api/index.js" <<'EOF'
function bad(jwtPayload) {
  return jwtPayload.org_id;
}
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/admin-api/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "Bare jwtPayload" "$TMP/validate_err"; then
  pass "Bare jwtPayload.org_id read blocks with exit 2"
else
  fail "Bare jwtPayload.org_id should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Direct workers.dev fetch → exit 2
cat > "$TMP/workers/admin-api/index.js" <<'EOF'
async function bad() {
  return fetch('https://rafter-pdf.will-8e8.workers.dev/render', { method: 'POST' });
}
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/admin-api/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "workers.dev" "$TMP/validate_err"; then
  pass "Direct fetch() to workers.dev blocks with exit 2"
else
  fail "fetch() to workers.dev should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Google Fonts CDN in pdf/ → exit 2
mkdir -p "$TMP/workers/pdf"
cat > "$TMP/workers/pdf/index.js" <<'EOF'
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Mulish';
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/pdf/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "Google Fonts" "$TMP/validate_err"; then
  pass "Google Fonts CDN in workers/pdf/ blocks with exit 2"
else
  fail "Google Fonts in pdf/ should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Same Google Fonts URL in workers/rafter/*.html → allowed (browser pages)
mkdir -p "$TMP/workers/rafter"
cat > "$TMP/workers/rafter/setup.html" <<'EOF'
<link href="https://fonts.googleapis.com/css2?family=Mulish" rel="stylesheet">
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/rafter/setup.html"}}
EOF
RC=$?
if [ "$RC" = "0" ]; then
  pass "Google Fonts CDN in workers/rafter/*.html is allowed (browser page)"
else
  fail "Google Fonts in rafter/ should pass" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# RAFTER_CLIENTS.put in pdf → exit 2
cat > "$TMP/workers/pdf/index.js" <<'EOF'
async function bad(env) {
  await env.RAFTER_CLIENTS.put('client:abc', '{}');
}
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/pdf/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "RAFTER_CLIENTS write" "$TMP/validate_err"; then
  pass "RAFTER_CLIENTS.put in pdf blocks with exit 2"
else
  fail "RAFTER_CLIENTS.put in pdf should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Env-object logging → exit 2
cat > "$TMP/workers/admin-api/index.js" <<'EOF'
console.log(env);
EOF
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$TMP/workers/admin-api/index.js"}}
EOF
RC=$?
if [ "$RC" = "2" ] && grep -q "Env-object logging" "$TMP/validate_err"; then
  pass "console.log(env) blocks with exit 2"
else
  fail "console.log(env) should block" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# Edits to a non-workers/ file produce no output and exit 0
CLAUDE_PROJECT_DIR="$TMP" bash "$PROJECT_ROOT/scripts/arch-validate.sh" <<EOF >/dev/null 2>"$TMP/validate_err"
{"tool_input":{"file_path":"$PROJECT_ROOT/scripts/test-hooks.sh"}}
EOF
RC=$?
if [ "$RC" = "0" ]; then
  pass "Edits outside workers/ skip all checks"
else
  fail "Non-workers/ edits should exit 0" "rc=$RC err=$(cat "$TMP/validate_err")"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo
echo "─────────────────────────────────────────"
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "─────────────────────────────────────────"
[ "$FAIL" = "0" ] && exit 0 || exit 1
